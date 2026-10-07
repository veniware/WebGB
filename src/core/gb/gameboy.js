import { StateReader, StateWriter } from "../state.js";
import { Apu, SAMPLE_RATE } from "./apu.js";
import { createCartridge } from "./cartridge.js";
import { Camera, SENSOR_HEIGHT, SENSOR_WIDTH } from "./mappers/camera.js";
import { Mbc7 } from "./mappers/mbc7.js";
import { CLOCK_RATE, FRAME_DOTS, SCREEN_HEIGHT, SCREEN_WIDTH, SGB_CLOCK_RATE } from "./constants.js";
import { Cpu } from "./cpu.js";
import { DMG_PALETTES, GBC_PRESETS, gbcCombination, gbcCombinationFor, SGB_PALETTES } from "./palettes.js";
import { Joypad } from "./joypad.js";
import { memoryRegions } from "./memory.js";
import { Ppu } from "./ppu.js";
import { Serial } from "./serial.js";
import { Sgb } from "./sgb.js";
import { Timer } from "./timer.js";

// Where the DMG boot ROM leaves the PPU: line 153, this many dots in (as in Gambatte).
const BOOT_DOT = 396;

const STATE_MAGIC = 0x53424757; // "WGBS"
// M-cycles the CPU is held while switching speed: about 0x20008 T-cycles, so
// DIV (which keeps counting) wraps around twice and seems to stand still
// (as measured by the AGE tests; SameBoy agrees).
const SPEED_SWITCH_CYCLES = 0x20008 / 4 - 2;

/**
 * Game Boy / Game Boy Color system: the memory map, I/O registers, OAM DMA
 * and HDMA, wiring the CPU to the other components. Implements the Core
 * interface (src/core/interface.js).
 *
 * The CPU drives time: each of its M-cycles calls tick(), which advances the
 * timer, PPU, APU, serial port and DMA. In CGB double speed an M-cycle is
 * 2 dots instead of 4, so the PPU and APU run at the same real-time speed.
 */
export class GameBoy {
    id = "gb";
    version = 4;
    fps = CLOCK_RATE / FRAME_DOTS;
    sampleRate = SAMPLE_RATE;
    // Cartridge RAM writes so far (see getSaveWrites()); not part of the state.
    saveWrites = 0;

    /**
     * @param {Uint8Array} rom
     * @param {{ cgb?: boolean, now?: () => number }} [options]
     *     cgb: run as a Game Boy Color; now: wall clock for the cartridge RTC.
     */
    /**
     * @param {Uint8Array} rom
     * @param {{ cgb?: boolean, sgb?: boolean, now?: () => number }} [options]
     *     cgb: run as a Game Boy Color; sgb: as a Super Game Boy (DMG games).
     */
    constructor(rom, { cgb = false, sgb = false, now } = {}) {
        this.cgb = cgb;
        this.sgb = sgb && !cgb ? new Sgb() : null;
        if (this.sgb) {
            this.fps = SGB_CLOCK_RATE / FRAME_DOTS;
            this.sampleRate = (SAMPLE_RATE * SGB_CLOCK_RATE) / CLOCK_RATE;
        }
        this.rom = rom;
        this.cart = createCartridge(rom, { now });
        this.wram = new Uint8Array(cgb ? 0x8000 : 0x2000);
        this.hram = new Uint8Array(0x7f);
        // FF72-FF75: undocumented CGB registers.
        this.extraRegs = new Uint8Array(4);
        this.cpu = new Cpu(this);
        this.timer = new Timer(this);
        this.ppu = new Ppu(this);
        this.apu = new Apu(this);
        this.joypad = new Joypad(this);
        this.serial = new Serial(this);
        if (this.sgb) this.ppu.outputShades();
        this.reset();
    }

    get width() {
        return this.sgb?.width ?? SCREEN_WIDTH;
    }

    get height() {
        return this.sgb?.height ?? SCREEN_HEIGHT;
    }

    get model() {
        return this.cgb ? "Game Boy Color" : this.sgb ? "Super Game Boy" : "Game Boy";
    }

    /** Controllers read: 2 when a Super Game Boy game asks for multiplayer. */
    get players() {
        return this.sgb && this.sgb.players > 1 ? 2 : 1;
    }

    /**
     * Display options; can change while running.
     * @param {{ gbPalette?: string, colorCorrection?: boolean, sgbBorder?: boolean }} options
     *     gbPalette (DMG games): 'auto' (Game Boy Color colors for the games it
     *     knows, else green), 'gbc' (always the Game Boy Color's choice), a
     *     DMG_PALETTES name, a GBC_PRESETS name or 'sgb-' and an SGB_PALETTES
     *     name. colorCorrection: mimic the Game Boy Color's LCD instead of raw
     *     colors. sgbBorder: show the Super Game Boy's border (changes the size).
     */
    configure({ gbPalette = "auto", colorCorrection = false, sgbBorder = true } = {}) {
        if (this.sgb) {
            // The game picks its colors.
            if (this.sgb.showBorder !== sgbBorder) {
                this.sgb.showBorder = sgbBorder;
                this.sgb.render(this.ppu.front);
            }
            return;
        }
        this.ppu.setColorCorrection(colorCorrection);
        if (this.cgb) return;
        const known = gbcCombinationFor(this.rom);
        const sgbPalette = SGB_PALETTES[gbPalette.replace(/^sgb-/, "")];
        if (gbPalette in DMG_PALETTES) this.ppu.setDmgPalette(DMG_PALETTES[gbPalette]);
        else if (gbPalette.startsWith("sgb-") && sgbPalette) {
            this.ppu.setCompatPalette({ bg: sgbPalette, obj0: sgbPalette, obj1: sgbPalette }, false);
        }
        else if (gbPalette in GBC_PRESETS) this.ppu.setCompatPalette(gbcCombination(GBC_PRESETS[gbPalette]));
        else if (gbPalette === "gbc" || known >= 0) this.ppu.setCompatPalette(gbcCombination(Math.max(known, 0)));
        else this.ppu.setDmgPalette(DMG_PALETTES.green);
    }

    /** Power cycle. Battery-backed RAM and the RTC are kept. */
    reset() {
        // RAM powers up holding noise; some games seed their random numbers with it.
        fillNoise(this.wram);
        fillNoise(this.hram);
        this.extraRegs.fill(0);
        this.ie = 0;
        this.if = 0;
        this.ifMid = 0;
        this.svbk = 0;
        this.wramBank = 1;
        this.doubleSpeed = false;
        this.speedArmed = false;
        this.dmaRegister = 0xff;
        this.dmaSource = 0;
        this.dmaIndex = 0;
        // M-cycles until a requested OAM DMA starts copying.
        this.dmaDelay = 0;
        this.dmaActive = false;
        this.hdmaSource = 0;
        this.hdmaDest = 0;
        // Remaining 16-byte blocks minus one, as FF55 reads it.
        this.hdmaLength = 0x7f;
        this.hdmaActive = false;
        // CGB infrared port (RP).
        this.rp = 0;
        this.irReceived = false;
        // Dots left in the current runFrame().
        this.frameBudget = 0;
        this.frameStart = 0;
        // Rumble motor: time it was on during the current frame (dots).
        this.rumbleOn = false;
        this.rumbleSince = 0;
        this.rumbleDots = 0;
        this.rumbleLevel = 0;
        this.cart.reset();
        this.cpu.reset();
        this.ppu.reset();
        this.apu.reset();
        this.joypad.reset();
        this.serial.reset();
        this.sgb?.reset();
        this.#boot();
    }

    /** State the boot ROM leaves behind; the boot ROM itself isn't run (it's copyrighted). */
    #boot() {
        const cpu = this.cpu;
        if (this.cgb) {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x11, 0x80, 0x00, 0x00, 0xff, 0x56, 0x00, 0x0d];
        } else if (this.sgb) {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x01, 0x00, 0x00, 0x14, 0x00, 0x00, 0xc0, 0x60];
        } else {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x01, 0xb0, 0x00, 0x13, 0x00, 0xd8, 0x01, 0x4d];
        }
        cpu.sp = 0xfffe;
        cpu.pc = 0x0100;
        this.timer.reset(this.cgb ? 0x1ea0 : 0xabc8);
        this.joypad.select = 0;
        this.if = 0x01;

        // Sound registers as the boot chime leaves them (without retriggering it).
        const sound = [
            [0xff26, 0x80], [0xff10, 0x80], [0xff11, 0xbf], [0xff12, 0xf3], [0xff13, 0xff], [0xff14, 0x3f],
            [0xff16, 0x3f], [0xff17, 0x00], [0xff18, 0xff], [0xff19, 0x3f], [0xff1a, 0x7f], [0xff1b, 0xff],
            [0xff1c, 0x9f], [0xff1d, 0xff], [0xff1e, 0x3f], [0xff20, 0xff], [0xff21, 0x00], [0xff22, 0x00],
            [0xff23, 0x3f], [0xff24, 0x77], [0xff25, 0xf3],
        ];
        for (const [addr, value] of sound) this.apu.write(addr, value);
        // The chime's channel is still on, faded out (the SGB plays no chime).
        this.apu.ch1.enabled = !this.sgb;
        this.apu.settle();

        this.ppu.writeRegister(0xff47, 0xfc);
        if (this.cgb) {
            this.ppu.writeRegister(0xff40, 0x91);
        } else {
            if (!this.sgb) this.#bootLogo();
            this.ppu.startAfterBoot(BOOT_DOT);
        }
    }

    /**
     * The DMG boot ROM leaves the cartridge's logo (scaled 2x) in tiles 1-24,
     * the ® symbol in tile 25 and a map showing them; some games and tests use them.
     */
    #bootLogo() {
        const { vram } = this.ppu;
        const double = (nibble) => {
            let byte = 0;
            for (let bit = 3; bit >= 0; bit--) byte = (byte << 2) | (((nibble >> bit) & 1) * 3);
            return byte;
        };
        let address = 0x10;
        for (let i = 0x104; i < 0x134; i++) {
            for (const nibble of [this.rom[i] >> 4, this.rom[i] & 0x0f]) {
                vram[address] = vram[address + 2] = double(nibble);
                address += 4;
            }
        }
        const registered = [0x3c, 0x42, 0xb9, 0xa5, 0xb9, 0xa5, 0x42, 0x3c];
        registered.forEach((row, i) => (vram[0x190 + i * 2] = row));
        vram[0x1910] = 0x19;
        for (let i = 0; i < 12; i++) {
            vram[0x1904 + i] = 1 + i;
            vram[0x1924 + i] = 13 + i;
        }
    }

    sync(s) {
        this.cpu.sync(s);
        this.timer.sync(s);
        this.ppu.sync(s);
        this.apu.sync(s);
        this.joypad.sync(s);
        this.serial.sync(s);
        this.cart.sync(s);
        this.sgb?.sync(s);
        s.bytes(this.wram);
        s.bytes(this.hram);
        s.bytes(this.extraRegs);
        for (const r of ["ie", "if", "svbk", "dmaRegister", "dmaIndex", "dmaDelay", "hdmaLength", "rp"]) this[r] = s.u8(this[r]);
        this.dmaSource = s.u16(this.dmaSource);
        this.hdmaSource = s.u16(this.hdmaSource);
        this.hdmaDest = s.u16(this.hdmaDest);
        for (const flag of ["doubleSpeed", "speedArmed", "dmaActive", "hdmaActive"]) this[flag] = s.bool(this[flag]);
        this.frameBudget = s.i32(this.frameBudget);
        this.wramBank = this.svbk || 1;
    }

    // --- Core interface ------------------------------------------------------------

    setInput(buttons) {
        this.joypad.setButtons(buttons);
    }

    /**
     * Runs until the PPU finishes a frame (VBlank), or for one frame's worth of
     * time while the LCD is off, so frames stay in step with the display.
     */
    runFrame() {
        const { cpu, ppu } = this;
        this.beginFrame();
        while (this.frameBudget > 0 && !ppu.frameDone) cpu.step();
        this.endFrame(true);
    }

    // Linked machines run in small slices instead: beginFrame(), runDots()
    // until the frame's time is used, endFrame(false).

    beginFrame() {
        this.apu.beginFrame();
        this.ppu.frameDone = false;
        this.frameBudget += FRAME_DOTS;
        this.frameStart = this.frameBudget;
    }

    /** Runs whole instructions until `dots` more dots have passed. */
    runDots(dots) {
        const { cpu } = this;
        const target = this.frameBudget - dots;
        while (this.frameBudget > target) cpu.step();
    }

    /** @param {boolean} alignToVBlank Start the next frame right after VBlank. */
    endFrame(alignToVBlank) {
        const elapsed = this.frameStart - this.frameBudget;
        if (alignToVBlank && this.ppu.frameDone) this.frameBudget = 0;
        this.apu.catchUp();
        this.sgb?.render(this.ppu.front);
        if (this.rumbleOn) this.rumbleDots += elapsed - this.rumbleSince;
        this.rumbleLevel = elapsed > 0 ? Math.min(1, this.rumbleDots / elapsed) : 0;
        this.rumbleDots = 0;
        this.rumbleSince = 0;
    }

    /** How much the rumble motor ran during the last frame, 0-1. */
    getRumble() {
        return this.rumbleLevel;
    }

    /** True for cartridges with a tilt sensor (MBC7); see setTilt. */
    get wantsTilt() {
        return this.cart instanceof Mbc7;
    }

    /** Tilt in g: x positive to the right, y positive towards the player. */
    setTilt(x, y) {
        if (this.cart instanceof Mbc7) {
            this.cart.tiltX = x;
            this.cart.tiltY = y;
        }
    }

    /** True for the Game Boy Camera; the host then feeds frames with setCameraImage. */
    get wantsCamera() {
        return this.cart instanceof Camera;
    }

    /** Size of the grayscale images setCameraImage takes. */
    get cameraSize() {
        return { width: SENSOR_WIDTH, height: SENSOR_HEIGHT };
    }

    setCameraImage(pixels) {
        if (this.cart instanceof Camera) this.cart.setImage(pixels);
    }

    /** Infrared light from outside (another Game Boy); light this one emits is irLight. */
    setInfrared(received) {
        this.irReceived = received;
        if ("irReceived" in this.cart) this.cart.irReceived = received;
    }

    get irLight() {
        return (this.rp & 1) !== 0 || this.cart.irLight === true;
    }

    getFrameBuffer() {
        if (this.sgb) return this.sgb.showBorder ? this.sgb.frameBytes : this.sgb.screenBytes;
        return this.ppu.frontBytes;
    }

    /** The 160x144 screen, without a Super Game Boy border. */
    getScreenBuffer() {
        return this.sgb ? this.sgb.screenBytes : this.ppu.frontBytes;
    }

    getAudioSamples() {
        return this.apu.samples;
    }

    getSaveWrites() {
        return this.saveWrites;
    }

    getMemoryRegions() {
        return memoryRegions(this);
    }

    screenshot() {
        return { pixels: this.getScreenBuffer().slice(), width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
    }

    getSaveData() {
        return this.cart.getSaveData();
    }

    loadSaveData(data) {
        this.cart.loadSaveData(data);
    }

    saveState() {
        const s = new StateWriter();
        this.#header(s);
        this.sync(s);
        return s.finish();
    }

    loadState(data) {
        const s = new StateReader(data);
        if (!this.#header(s)) throw new Error("This snapshot is for a different game or system.");
        const backup = this.saveState();
        try {
            this.sync(s);
            if (!s.done) throw new Error("Invalid save state.");
        } catch (err) {
            const restore = new StateReader(backup);
            this.#header(restore);
            this.sync(restore);
            throw err;
        }
    }

    /** Writes or checks the state header (format, system, ROM size). */
    #header(s) {
        const magic = s.u32(STATE_MAGIC);
        const modelId = this.cgb ? 1 : this.sgb ? 2 : 0;
        const model = s.u8(modelId);
        const romSize = s.u32(this.cart.rom.length);
        return magic === STATE_MAGIC && model === modelId && romSize === this.cart.rom.length;
    }

    // --- Timing ----------------------------------------------------------------------

    /** Advances everything but the CPU by one M-cycle. */
    tick() {
        this.timer.tick();
        const dots = this.doubleSpeed ? 2 : 4;
        // In two halves: what's pending halfway through decides a HALT (see Cpu).
        this.ppu.tick(dots >> 1);
        this.ifMid = this.if;
        this.ppu.tick(dots >> 1);
        this.apu.pending += dots;
        if (this.cart.ticking) this.cart.tick(4);
        if (this.dmaDelay || this.dmaActive) this.#dmaTick();
        this.frameBudget -= dots;
    }

    /** STOP: resets DIV, then switches speed if armed (returns false) or stops the CPU (true). */
    stop() {
        this.timer.writeDiv();
        if (!this.cgb || !this.speedArmed) return true;
        this.speedArmed = false;
        this.doubleSpeed = !this.doubleSpeed;
        this.cpu.stall += SPEED_SWITCH_CYCLES;
        return false;
    }

    /** Called by the PPU at the start of each HBlank: runs one HDMA block. */
    hblank() {
        if (!this.hdmaActive) return;
        this.#hdmaBlock();
        this.cpu.stall += this.doubleSpeed ? 16 : 8;
        if (this.hdmaLength === 0) {
            this.hdmaLength = 0x7f;
            this.hdmaActive = false;
        } else {
            this.hdmaLength--;
        }
    }

    // --- Memory map ------------------------------------------------------------------

    read(addr) {
        if (this.dmaActive && addr < 0xfe00) {
            const value = this.#dmaConflict(addr);
            if (value >= 0) return value;
        }
        if (addr < 0x8000) return this.cart.readRom(addr);
        if (addr < 0xa000) return this.ppu.readVram(addr);
        if (addr < 0xc000) return this.cart.readRam(addr);
        if (addr < 0xfe00) return this.#readWram(addr);
        if (addr < 0xff00) {
            if (!this.cgb && this.ppu.oamWriteBlocked) {
                this.ppu.oamBugRead();
                return 0xff;
            }
            if (addr >= 0xfea0) return this.ppu.oamReadBlocked ? 0xff : 0;
            return this.dmaActive ? 0xff : this.ppu.readOam(addr);
        }
        if (addr < 0xff80) return this.#readIo(addr);
        if (addr < 0xffff) return this.hram[addr - 0xff80];
        return this.ie;
    }

    /**
     * The CPU's 16-bit increment/decrement unit drives the address bus: with a
     * value in FE00-FEFF it disturbs OAM on a DMG like a write would.
     */
    oamBug(addr) {
        if (addr >= 0xfe00 && addr < 0xff00 && !this.cgb) this.ppu.oamBugWrite();
    }

    write(addr, value) {
        if (this.dmaActive && addr < 0xfe00 && this.#dmaWriteConflict(addr, value)) return;
        if (addr < 0x8000) {
            this.cart.writeRom(addr, value);
            if (this.cart.rumbling !== this.rumbleOn) this.#rumbleChanged();
        }
        else if (addr < 0xa000) this.ppu.writeVram(addr, value);
        else if (addr < 0xc000) {
            this.cart.writeRam(addr, value);
            this.saveWrites++;
        }
        else if (addr < 0xfe00) this.#writeWram(addr, value);
        else if (addr < 0xff00) {
            if (!this.cgb && this.ppu.oamWriteBlocked) this.ppu.oamBugWrite();
            else if (addr < 0xfea0 && !this.dmaActive) this.ppu.writeOam(addr, value);
        } else if (addr < 0xff80) this.#writeIo(addr, value);
        else if (addr < 0xffff) this.hram[addr - 0xff80] = value;
        else this.ie = value;
    }

    #rumbleChanged() {
        const now = this.frameStart - this.frameBudget;
        if (this.rumbleOn) this.rumbleDots += now - this.rumbleSince;
        this.rumbleSince = now;
        this.rumbleOn = this.cart.rumbling;
    }

    /** C000-DFFF, mirrored at E000-FDFF. D000-DFFF is banked on the CGB. */
    #readWram(addr) {
        addr &= 0x1fff;
        return addr < 0x1000 ? this.wram[addr] : this.wram[(this.wramBank << 12) | (addr & 0xfff)];
    }

    #writeWram(addr, value) {
        addr &= 0x1fff;
        if (addr < 0x1000) this.wram[addr] = value;
        else this.wram[(this.wramBank << 12) | (addr & 0xfff)] = value;
    }

    #readIo(addr) {
        switch (addr) {
            case 0xff00: return this.joypad.read();
            case 0xff01: return this.serial.sb;
            case 0xff02: return this.serial.readSc();
            case 0xff04: return this.timer.div;
            case 0xff05: return this.timer.tima;
            case 0xff06: return this.timer.tma;
            case 0xff07: return this.timer.tac;
            case 0xff0f: return 0xe0 | this.if;
            case 0xff46: return this.dmaRegister;
        }
        if (addr < 0xff10) return 0xff;
        if (addr < 0xff40) return this.apu.read(addr);
        if (!this.cgb) return addr < 0xff4c ? this.ppu.readRegister(addr) : 0xff;
        switch (addr) {
            case 0xff4d: return 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.speedArmed ? 1 : 0);
            case 0xff55: return (this.hdmaActive ? 0 : 0x80) | this.hdmaLength;
            case 0xff56: {
                // Bit 1 is 0 while light is received and reading is enabled (bits 6-7).
                const dark = (this.rp & 0xc0) !== 0xc0 || !this.irReceived;
                return 0x3c | (this.rp & 0xc1) | (dark ? 2 : 0);
            }
            case 0xff70: return 0xf8 | this.svbk;
            case 0xff72: case 0xff73: case 0xff74: return this.extraRegs[addr - 0xff72];
            case 0xff75: return 0x8f | this.extraRegs[3];
            case 0xff76: case 0xff77: return this.apu.readPcm(addr);
        }
        return addr < 0xff70 ? this.ppu.readRegister(addr) : 0xff;
    }

    #writeIo(addr, value) {
        switch (addr) {
            case 0xff00: this.joypad.write(value); return;
            case 0xff01: this.serial.sb = value; return;
            case 0xff02: this.serial.writeSc(value); return;
            case 0xff04: this.timer.writeDiv(); return;
            case 0xff05: this.timer.writeTima(value); return;
            case 0xff06: this.timer.writeTma(value); return;
            case 0xff07: this.timer.writeTac(value); return;
            case 0xff0f: this.if = value & 0x1f; return;
            case 0xff46: this.#startDma(value); return;
        }
        if (addr < 0xff10) return;
        if (addr < 0xff40) {
            this.apu.write(addr, value);
            return;
        }
        if (!this.cgb) {
            if (addr < 0xff4c) this.ppu.writeRegister(addr, value);
            return;
        }
        switch (addr) {
            case 0xff4d: this.speedArmed = (value & 1) !== 0; return;
            case 0xff51: this.hdmaSource = (value << 8) | (this.hdmaSource & 0xff); return;
            case 0xff52: this.hdmaSource = (this.hdmaSource & 0xff00) | (value & 0xf0); return;
            case 0xff53: this.hdmaDest = ((value & 0x1f) << 8) | (this.hdmaDest & 0xff); return;
            case 0xff54: this.hdmaDest = (this.hdmaDest & 0x1f00) | (value & 0xf0); return;
            case 0xff55: this.#writeHdma(value); return;
            case 0xff56: this.rp = value & 0xc1; return;
            case 0xff70:
                this.svbk = value & 7;
                this.wramBank = this.svbk || 1;
                return;
            case 0xff72: case 0xff73: case 0xff74: this.extraRegs[addr - 0xff72] = value; return;
            case 0xff75: this.extraRegs[3] = value & 0x70; return;
        }
        if (addr < 0xff70) this.ppu.writeRegister(addr, value);
    }

    // --- DMA ---------------------------------------------------------------------------

    #startDma(value) {
        this.dmaRegister = value;
        // Sources from E000 up read work RAM, like its echo.
        this.dmaSource = (value >= 0xe0 ? value - 0x20 : value) << 8;
        // Copying starts two M-cycles after the write; a DMA already running
        // continues until then.
        this.dmaDelay = 2;
    }

    /** One byte per M-cycle; OAM stays blocked until the M-cycle after the last byte. */
    #dmaTick() {
        if (this.dmaActive) {
            if (this.dmaIndex === 0xa0) this.dmaActive = false;
            else this.#dmaCopy();
        }
        if (this.dmaDelay && --this.dmaDelay === 0) {
            this.dmaIndex = 0;
            this.dmaActive = true;
            this.#dmaCopy();
        }
    }

    #dmaCopy() {
        this.ppu.oam[this.dmaIndex] = this.#dmaRead(this.dmaSource + this.dmaIndex);
        this.dmaIndex++;
    }

    /**
     * OAM DMA occupies the bus it copies from: the CPU accessing that bus
     * meets the DMA's address instead. The CGB has a separate bus for work
     * RAM, with odder rules (these follow SameBoy).
     */
    #dmaBusy(addr) {
        const next = this.dmaSource + this.dmaIndex;
        if (addr === next || (next >= 0xe000 && (next & ~0x2000) === addr)) return false;
        if (!this.cgb) return dmgBus(addr) === dmgBus(next);
        if (addr >= 0xc000) return cgbBus(next) !== Bus.VRAM;
        if (next >= 0xe000) return cgbBus(addr) !== Bus.VRAM;
        return cgbBus(addr) === cgbBus(next);
    }

    /** A read during OAM DMA: the byte being copied, or -1 when the bus is free. */
    #dmaConflict(addr) {
        if (!this.#dmaBusy(addr)) return -1;
        const last = this.dmaSource + this.dmaIndex - 1;
        if (this.cgb && addr >= 0xc000 && (cgbBus(last + 1) !== Bus.RAM || last + 1 >= 0xe000)) {
            return this.#readWram((last & 0x1000) | (addr & 0xfff) | 0xc000);
        }
        if (this.cgb && cgbBus(addr) === Bus.MAIN && last + 1 >= 0xe000) return 0xff;
        return this.#dmaRead(last);
    }

    /** A write during OAM DMA; returns false when the bus is free. */
    #dmaWriteConflict(addr, value) {
        if (!this.#dmaBusy(addr)) return false;
        const next = this.dmaSource + this.dmaIndex;
        const last = next - 1;
        if (this.cgb) {
            if (cgbBus(addr) === Bus.MAIN && next >= 0xe000) return true;
            if (addr >= 0xc000 && (next < 0xc000 || next >= 0xe000)) {
                this.#writeWram((last & 0x1000) | (addr & 0xfff) | 0xc000, value);
                return true;
            }
            if (last >= 0xa000) return true;
            this.ppu.oam[this.dmaIndex - 1] = 0;
        } else if (last >= 0xa000) {
            // The DMA's source wins; the byte being copied picks up the write's 0 bits.
            this.ppu.oam[this.dmaIndex - 1] &= value;
            return true;
        }
        // The write lands on the DMA's address instead (on a ROM source: the mapper).
        if (last < 0x8000) this.cart.writeRom(last, value);
        else this.ppu.writeVram(last, value);
        return true;
    }

    /** Reads for DMA, which bypasses the PPU's access restrictions. */
    #dmaRead(addr) {
        if (addr < 0x8000) return this.cart.readRom(addr);
        if (addr < 0xa000) return this.ppu.vram[(this.ppu.vramBank << 13) | (addr & 0x1fff)];
        if (addr < 0xc000) return this.cart.readRam(addr);
        return this.#readWram(addr);
    }

    #writeHdma(value) {
        if (this.hdmaActive && !(value & 0x80)) {
            // Stops an HBlank transfer; FF55 then reads bit 7 set and the length just written.
            this.hdmaActive = false;
            this.hdmaLength = value & 0x7f;
            return;
        }
        this.hdmaLength = value & 0x7f;
        if (value & 0x80) {
            this.hdmaActive = true;
            // Started in HBlank (or with the LCD off): the first block goes now.
            if (this.ppu.mode === 0) this.hblank();
            return;
        }
        // General-purpose DMA: everything at once, with the CPU held meanwhile.
        const blocks = this.hdmaLength + 1;
        for (let i = 0; i < blocks; i++) this.#hdmaBlock();
        this.hdmaLength = 0x7f;
        this.cpu.stall += blocks * (this.doubleSpeed ? 16 : 8);
    }

    #hdmaBlock() {
        const { vram, vramBank } = this.ppu;
        for (let i = 0; i < 16; i++) {
            vram[(vramBank << 13) | this.hdmaDest] = this.#dmaRead(this.hdmaSource);
            this.hdmaSource = (this.hdmaSource + 1) & 0xffff;
            this.hdmaDest = (this.hdmaDest + 1) & 0x1fff;
        }
    }
}

// Buses: the cartridge (and, on the DMG, work RAM), video RAM, CGB work RAM.
const Bus = { MAIN: 0, VRAM: 1, RAM: 2 };

function dmgBus(addr) {
    return addr >= 0x8000 && addr < 0xa000 ? Bus.VRAM : Bus.MAIN;
}

function cgbBus(addr) {
    if (addr >= 0xc000) return Bus.RAM;
    return addr >= 0x8000 && addr < 0xa000 ? Bus.VRAM : Bus.MAIN;
}

/** Fills with the same pseudo-random bytes every time (xorshift32). */
function fillNoise(array) {
    let x = 0x2545f491;
    for (let i = 0; i < array.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        array[i] = x;
    }
}
