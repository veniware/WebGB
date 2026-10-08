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

// System counter (DIV) and its phase when the boot ROM hands over, and how
// far the PPU is into line 153 (DMG).
const BOOT_DIV_DMG = 0xabcc;
const BOOT_DIV_CGB = 0x1ea0;
const BOOT_DIV_CYCLES = -3;
const BOOT_PPU_CYCLES = -104;

const STATE_MAGIC = 0x53424757; // "WGBS"

// I/O registers the PPU must be caught up for before they're read or written.
const PPU_REGISTERS = new Uint8Array(0x80);
for (const reg of [0x0f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x51, 0x52, 0x53,
    0x54, 0x55, 0x68, 0x69, 0x6a, 0x6b, 0x6c]) {
    PPU_REGISTERS[reg] = 1;
}

/**
 * Game Boy / Game Boy Color system: the memory map, I/O registers, OAM DMA
 * and HDMA, wiring the CPU to the other components. Implements the Core
 * interface (src/core/interface.js).
 *
 * The CPU drives time: before each memory access it calls advance() with the
 * T-cycles since the last one, which runs the timer, PPU, APU, serial port
 * and DMA up to that point. In CGB double speed a T-cycle is half a dot, so
 * the PPU and APU run at the same real-time speed. Timing follows SameBoy
 * (MIT, Lior Halphon).
 */
export class GameBoy {
    id = "gb";
    version = 6;
    fps = CLOCK_RATE / FRAME_DOTS;
    sampleRate = SAMPLE_RATE;
    // Cartridge RAM writes so far (see getSaveWrites()); not part of the state.
    saveWrites = 0;

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
        // I/O registers kept as written (FF00-FF7F); the timer, serial port,
        // joypad and APU keep their own.
        this.io = new Uint8Array(0x80);
        this.cpu = new Cpu(this);
        this.apu = new Apu(this);
        this.timer = new Timer(this);
        this.ppu = new Ppu(this);
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
        this.io.fill(0);
        this.ie = 0;
        this.wramBank = 1;
        this.doubleSpeed = false;
        // The last address the CPU put on the bus (the APU's wave RAM glitches use it).
        this.addressBus = 0;
        // OAM DMA (as in SameBoy): the next OAM byte (0xFF while starting up,
        // 0xA0-0xA1 when ending/off) and source address; T-cycles to run and left over.
        this.dmaCurrentDest = 0xa1;
        this.dmaCurrentSrc = 0;
        this.dmaCycles = 0;
        this.dmaCyclesModulo = 0;
        this.dmaRestarting = false;
        this.dmaPpuVramConflict = false;
        this.dmaPpuVramConflictAddr = 0;
        this.inDmaRead = false;
        // HDMA: copying now (hdmaOn), or a block per HBlank (hdmaOnHblank).
        this.hdmaOn = false;
        this.hdmaOnHblank = false;
        this.hdmaStepsLeft = 0;
        this.hdmaCurrentSrc = 0;
        this.hdmaCurrentDest = 0;
        this.hdmaInProgress = false;
        this.addrForHdmaConflict = 0xffff;
        this.allowHdmaOnWake = false;
        // Speed switch (CGB): T-cycles until it takes effect, the PPU frozen, the CPU halted.
        this.speedSwitchCountdown = 0;
        this.speedSwitchFreeze = 0;
        this.speedSwitchHaltCountdown = 0;
        this.doubleSpeedAlignment = 0;
        this.irReceived = false;
        // 8 MHz units run since power-on, and left in the current runFrame();
        // the run stops when frameBudget reaches stopAt.
        this.totalCycles = 0;
        this.stopAt = 0;
        this.frameBudget = 0;
        this.frameStart = 0;
        // Rumble motor: time it was on during the current frame.
        this.rumbleOn = false;
        this.rumbleSince = 0;
        this.rumbleTime = 0;
        this.rumbleLevel = 0;
        this.io[0x46] = this.io[0x48] = this.io[0x49] = this.cgb ? 0 : 0xff;
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
        const { cpu, io, ppu } = this;
        if (this.cgb) {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x11, 0x80, 0x00, 0x00, 0xff, 0x56, 0x00, 0x0d];
        } else if (this.sgb) {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x01, 0x00, 0x00, 0x14, 0x00, 0x00, 0xc0, 0x60];
        } else {
            [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x01, 0xb0, 0x00, 0x13, 0x00, 0xd8, 0x01, 0x4d];
        }
        cpu.sp = 0xfffe;
        cpu.pc = 0x0100;
        this.timer.reset(this.cgb ? BOOT_DIV_CGB : BOOT_DIV_DMG, BOOT_DIV_CYCLES);
        this.joypad.select = 0;
        io[0x0f] = 0x01;

        // Sound registers as the boot chime leaves them (without retriggering it).
        const sound = [
            [0xff26, 0x80], [0xff10, 0x80], [0xff11, 0xbf], [0xff12, 0xf3], [0xff13, 0xff], [0xff14, 0x3f],
            [0xff16, 0x3f], [0xff17, 0x00], [0xff18, 0xff], [0xff19, 0x3f], [0xff1a, 0x7f], [0xff1b, 0xff],
            [0xff1c, 0x9f], [0xff1d, 0xff], [0xff1e, 0x3f], [0xff20, 0xff], [0xff21, 0x00], [0xff22, 0x00],
            [0xff23, 0x3f], [0xff24, 0x77], [0xff25, 0xf3],
        ];
        // The chime's channel is still on, faded out (the SGB plays no chime).
        this.apu.bootState(sound, !this.sgb);

        io[0x47] = 0xfc;
        io[0x41] = 0x80;
        if (this.cgb) {
            ppu.writeRegister(0x40, 0x91);
            return;
        }
        if (!this.sgb) this.#bootLogo();
        // The DMG boot ROM hands over during line 153, LY already reading 0.
        io[0x40] = 0x91;
        io[0x41] = 0x81;
        ppu.currentLine = 153;
        ppu.positionInLine = 0xf0;
        ppu.windowY = 0xff;
        ppu.lyForComparison = 0;
        ppu.modeForInterrupt = 1;
        ppu.statUpdate();
        ppu.state = 17;
        ppu.cycles = BOOT_PPU_CYCLES;
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
        s.bytes(this.io);
        for (const r of ["ie", "wramBank", "dmaCurrentDest", "dmaCyclesModulo", "hdmaStepsLeft", "speedSwitchFreeze",
            "doubleSpeedAlignment", "speedSwitchCountdown"]) {
            this[r] = s.u8(this[r]);
        }
        for (const r of ["dmaCurrentSrc", "dmaCycles", "dmaPpuVramConflictAddr", "hdmaCurrentSrc", "hdmaCurrentDest",
            "addressBus"]) {
            this[r] = s.u16(this[r]);
        }
        for (const flag of ["doubleSpeed", "dmaRestarting", "dmaPpuVramConflict", "hdmaOn", "hdmaOnHblank",
            "allowHdmaOnWake"]) {
            this[flag] = s.bool(this[flag]);
        }
        this.speedSwitchHaltCountdown = s.i32(this.speedSwitchHaltCountdown);
        this.frameBudget = s.i32(this.frameBudget);
        if (s.reading) this.timer.refreshWatch();
    }

    /** IF, for the serial port and joypad. */
    get if() {
        return this.io[0x0f];
    }

    set if(value) {
        this.io[0x0f] = value;
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
        this.beginFrame();
        this.#runToVBlank();
        this.endFrame(true);
    }

    // (A separate method so V8 doesn't throw away the optimized loop at each frame's end.)
    #runToVBlank() {
        const { cpu, ppu } = this;
        this.stopAt = 0;
        while (this.frameBudget > 0 && !ppu.frameDone) cpu.step();
    }

    // Linked machines run in small slices instead: beginFrame(), runDots()
    // until the frame's time is used, endFrame(false).

    beginFrame() {
        this.apu.beginFrame();
        this.ppu.frameDone = false;
        this.frameBudget += FRAME_DOTS * 2;
        this.frameStart = this.frameBudget;
    }

    /** Runs whole instructions until `dots` more dots have passed. */
    runDots(dots) {
        const { cpu } = this;
        const target = this.frameBudget - dots * 2;
        this.stopAt = target;
        while (this.frameBudget > target) cpu.step();
    }

    /** @param {boolean} alignToVBlank Start the next frame right after VBlank. */
    endFrame(alignToVBlank) {
        const elapsed = this.frameStart - this.frameBudget;
        if (alignToVBlank && this.ppu.frameDone) this.frameBudget = 0;
        this.apu.catchUp();
        this.sgb?.render(this.ppu.front);
        if (this.rumbleOn) this.rumbleTime += elapsed - this.rumbleSince;
        this.rumbleLevel = elapsed > 0 ? Math.min(1, this.rumbleTime / elapsed) : 0;
        this.rumbleTime = 0;
        this.rumbleSince = 0;
    }

    /** Dots run so far (for tests that run on emulated time). */
    get dots() {
        return this.totalCycles / 2;
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
        return (this.io[0x56] & 1) !== 0 || this.cart.irLight === true;
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

    loadState(data, version = this.version) {
        if (version !== this.version) throw new Error("This snapshot is from an older version of the emulator.");
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

    /** Runs everything but the CPU for `cycles` CPU T-cycles (GB_advance_cycles). */
    advance(cycles) {
        if (this.speedSwitchCountdown | this.speedSwitchHaltCountdown | this.speedSwitchFreeze) {
            this.#advanceSwitching(cycles);
            return;
        }
        this.dmaCycles = cycles;
        const timer = this.timer;
        // (The timer's common case, inlined.)
        const divCycles = timer.divCycles + cycles;
        if (divCycles <= 0 && !this.cpu.stopped) timer.divCycles = divCycles;
        else timer.run(cycles);
        if (this.cart.ticking && !this.cpu.halted && !this.cpu.stopped) this.cart.tick(cycles);
        this.#advanceVideo(this.doubleSpeed ? cycles : cycles << 1);
    }

    /** advance() around a speed switch. */
    #advanceSwitching(cycles) {
        if (this.speedSwitchCountdown) {
            if (this.speedSwitchCountdown === cycles) {
                this.doubleSpeed = !this.doubleSpeed;
                this.timer.refreshWatch();
                this.speedSwitchCountdown = 0;
            } else if (this.speedSwitchCountdown > cycles) {
                this.speedSwitchCountdown -= cycles;
            } else {
                const before = this.speedSwitchCountdown;
                cycles -= before;
                this.speedSwitchCountdown = 0;
                this.advance(before);
                this.doubleSpeed = !this.doubleSpeed;
                this.timer.refreshWatch();
            }
        }
        this.dmaCycles = cycles;
        this.timer.run(cycles);
        if (this.cart.ticking && !this.cpu.halted && !this.cpu.stopped) this.cart.tick(cycles);
        if (this.speedSwitchHaltCountdown) {
            this.speedSwitchHaltCountdown -= cycles;
            if (this.speedSwitchHaltCountdown <= 0) {
                this.speedSwitchHaltCountdown = 0;
                this.cpu.halted = false;
            }
        }
        if (this.speedSwitchFreeze) {
            if (this.speedSwitchFreeze >= cycles) {
                this.speedSwitchFreeze -= cycles;
                return;
            }
            cycles -= this.speedSwitchFreeze;
            this.speedSwitchFreeze = 0;
        }
        this.#advanceVideo(this.doubleSpeed ? cycles : cycles << 1);
    }

    /** The rest of advance(), in 8 MHz units (the same in both speeds). */
    #advanceVideo(units) {
        if (this.io[0x40] & 0x80) this.doubleSpeedAlignment = (this.doubleSpeedAlignment + units) & 0xff;
        this.frameBudget -= units;
        this.totalCycles += units;
        this.ppu.run(units, false);
        if (this.dmaCurrentDest !== 0xa1 && !this.cpu.stopped) this.dmaRun();
    }

    /**
     * While halted: whole M-cycles (in T-cycles) that can pass in one go
     * because nothing can raise an interrupt meanwhile, or 0. Running them
     * in one advance() is exact: it's the same as stepping through them.
     */
    idleCycles() {
        if (this.speedSwitchCountdown | this.speedSwitchHaltCountdown | this.speedSwitchFreeze || this.hdmaOn) return 0;
        if ((this.serial.sc & 0x81) === 0x81) return 0;
        // In 8 MHz units: the PPU's next step, the end of this run.
        let units = Math.min(this.ppu.quietUnits, this.frameBudget - this.stopAt);
        let cycles = this.doubleSpeed ? units : units >> 1;
        cycles = Math.min(cycles, this.timer.quietCycles);
        // Two M-cycles of margin, so the interrupt is taken by the usual steps.
        cycles = ((cycles - 8) & ~3);
        return cycles >= 16 ? cycles : 0;
    }

    /** Leaving HALT: a waiting HBlank DMA block and OAM DMA go on. */
    wake() {
        if (this.hdmaOnHblank && (this.io[0x41] & 3) === 0 && this.allowHdmaOnWake) this.hdmaOn = true;
        this.dmaCycles = 4;
        this.dmaRun();
        this.speedSwitchHaltCountdown = 0;
    }

    enterStopMode() {
        const { ppu } = this;
        this.timer.writeDiv();
        // The CPU-side DIV reset signal is held a little longer.
        if (!this.cpu.ime) this.timer.divCycles = -4;
        this.cpu.stopped = true;
        this.allowHdmaOnWake = (this.io[0x41] & 3) !== 0;
        ppu.oamPpuBlocked = !ppu.oamReadBlocked;
        ppu.vramPpuBlocked = !ppu.vramReadBlocked;
        ppu.cgbPalettesPpuBlocked = !ppu.cgbPalettesBlocked;
    }

    leaveStopMode() {
        const { ppu } = this;
        this.cpu.stopped = false;
        if (this.hdmaOnHblank && (this.io[0x41] & 3) === 0 && this.allowHdmaOnWake) this.hdmaOn = true;
        this.dmaCycles = 4;
        this.dmaRun();
        ppu.oamPpuBlocked = false;
        ppu.vramPpuBlocked = false;
        ppu.cgbPalettesPpuBlocked = false;
    }

    /**
     * STOP with KEY1 armed: the speed changes 6 T-cycles later (to double)
     * or at once (to single); without a pending interrupt the CPU is then
     * halted for about 0x20008 T-cycles while DIV keeps counting.
     */
    switchSpeed(interruptPending) {
        if (this.io[0x40] & 0x80 && this.doubleSpeed && this.doubleSpeedAlignment & 7) this.speedSwitchFreeze = 2;
        if (this.doubleSpeed) {
            this.doubleSpeed = false;
            this.timer.refreshWatch();
        } else {
            this.speedSwitchCountdown = 6;
            this.speedSwitchFreeze = 1;
        }
        if (!interruptPending) {
            this.speedSwitchHaltCountdown = 0x20008;
            this.speedSwitchFreeze = 5;
        }
        this.io[0x4d] = 0;
    }

    /** The CPU's 16-bit increment/decrement unit put `addr` on the bus (DMG OAM bug). */
    triggerOamBug(addr) {
        this.ppu.triggerOamBug(addr);
    }

    // --- Memory map ------------------------------------------------------------------

    read(addr) {
        if (this.dmaCurrentDest !== 0xa1 && this.#dmaBusy(addr)) {
            // OAM DMA occupies the bus it copies from: the CPU meets its address instead.
            const src = this.dmaCurrentSrc;
            if (this.cgb && cgbBus(addr) === Bus.MAIN && src >= 0xe000) return 0xff;
            if (this.cgb && addr >= 0xc000 && (cgbBus(src) !== Bus.RAM || src >= 0xe000)) {
                addr = ((src - 1) & 0x1000) | (addr & 0xfff) | 0xc000;
            } else {
                addr = (src - 1) & 0xffff;
            }
        }
        if (addr < 0x8000) return this.cart.readRom(addr);
        if (addr < 0xa000) {
            if (this.dmaCurrentDest === 0xa1) this.ppu.catchUp();
            return this.ppu.readVram(addr);
        }
        if (addr < 0xc000) return this.cart.readRam(addr);
        if (addr < 0xfe00) return this.#readWram(addr);
        if (addr < 0xff00) {
            this.ppu.catchUp();
            return this.ppu.cpuReadOam(addr);
        }
        if (addr < 0xff80) return this.#readIo(addr);
        if (addr < 0xffff) return this.hram[addr - 0xff80];
        return this.ie;
    }

    write(addr, value) {
        if (this.dmaCurrentDest !== 0xa1 && this.#dmaBusy(addr) && !this.#dmaWriteConflict(addr, value)) return;
        this.#write(addr, value);
    }

    #write(addr, value) {
        if (addr < 0x8000) {
            this.cart.writeRom(addr, value);
            if (this.cart.rumbling !== this.rumbleOn) this.#rumbleChanged();
        } else if (addr < 0xa000) {
            this.ppu.catchUp();
            this.ppu.writeVram(addr, value);
        } else if (addr < 0xc000) {
            this.cart.writeRam(addr, value);
            this.saveWrites++;
        } else if (addr < 0xfe00) {
            this.#writeWram(addr, value);
        } else if (addr < 0xff00) {
            this.ppu.catchUp();
            this.ppu.cpuWriteOam(addr, value);
        } else if (addr < 0xff80) {
            this.#writeIo(addr, value);
        } else if (addr < 0xffff) {
            this.hram[addr - 0xff80] = value;
        } else {
            this.ppu.catchUp();
            this.ie = value;
        }
    }

    #rumbleChanged() {
        const now = this.frameStart - this.frameBudget;
        if (this.rumbleOn) this.rumbleTime += now - this.rumbleSince;
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
        const reg = addr & 0x7f;
        const io = this.io;
        const cgb = this.cgb;
        if (PPU_REGISTERS[reg]) this.ppu.catchUp();
        switch (reg) {
            case 0x00: return this.joypad.read();
            case 0x01: return this.serial.sb;
            case 0x02: return this.serial.readSc();
            case 0x04: return this.timer.div;
            case 0x05: return this.timer.readTima();
            case 0x06: return this.timer.tma;
            case 0x07: return this.timer.tac | 0xf8;
            case 0x0f: return io[0x0f] | 0xe0;
            case 0x40: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49:
            case 0x4a: case 0x4b:
                return io[reg];
            case 0x41: case 0x4f: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c:
                return this.ppu.readRegister(reg);
            case 0x4d: return cgb ? (io[0x4d] & 0x7f) | (this.doubleSpeed ? 0xfe : 0x7e) : 0xff;
            case 0x55:
                if (!cgb) return 0xff;
                return (this.hdmaOn || this.hdmaOnHblank ? 0 : 0x80) | ((this.hdmaStepsLeft - 1) & 0x7f);
            case 0x56: {
                if (!cgb) return 0xff;
                // Bit 1 is 0 while light is received and reading is enabled (bits 6-7).
                let value = (io[0x56] & 0xc1) | 0x2e;
                if ((io[0x56] & 0xc0) === 0xc0 && this.irReceived) value &= ~2;
                return value;
            }
            case 0x70: return cgb ? io[0x70] : 0xff;
            case 0x72: case 0x73: case 0x74: return cgb ? io[reg] : 0xff;
            case 0x75: return cgb ? io[0x75] | 0x8f : 0xff;
            case 0x76: case 0x77: return cgb ? this.apu.readPcm(addr) : 0xff;
        }
        if (reg >= 0x10 && reg < 0x40) return this.apu.read(addr);
        return 0xff;
    }

    #writeIo(addr, value) {
        const reg = addr & 0x7f;
        const io = this.io;
        const cgb = this.cgb;
        if (PPU_REGISTERS[reg]) this.ppu.catchUp();
        switch (reg) {
            case 0x00: this.joypad.write(value); return;
            case 0x01: this.serial.sb = value; return;
            case 0x02: this.serial.writeSc(value); return;
            case 0x04: this.timer.writeDiv(); return;
            case 0x05: this.timer.writeTima(value); return;
            case 0x06: this.timer.writeTma(value); return;
            case 0x07: this.timer.writeTac(value); return;
            case 0x0f: io[0x0f] = value; return;
            case 0x40: case 0x41: case 0x42: case 0x43: case 0x45: case 0x47: case 0x48: case 0x49: case 0x4a:
            case 0x4b: case 0x4f: case 0x68: case 0x69: case 0x6a: case 0x6b: case 0x6c:
                this.ppu.writeRegister(reg, value);
                return;
            case 0x46:
                this.dmaRestarting = this.dmaCurrentDest !== 0xa1 && this.dmaCurrentDest !== 0xa0;
                this.dmaCycles = 0;
                this.dmaCyclesModulo = 2;
                this.dmaCurrentDest = 0xff;
                this.dmaCurrentSrc = value << 8;
                io[0x46] = value;
                this.ppu.statUpdate();
                return;
            case 0x4d: if (cgb) io[0x4d] = value; return;
            case 0x51:
                if (!cgb) return;
                this.hdmaCurrentSrc = (this.hdmaCurrentSrc & 0xf0) | (value << 8);
                // E000-FFFF reads like F000-FFFF (and can't wrap into anything useful).
                if (this.hdmaCurrentSrc >= 0xe000) this.hdmaCurrentSrc |= 0xf000;
                return;
            case 0x52: if (cgb) this.hdmaCurrentSrc = (this.hdmaCurrentSrc & 0xff00) | (value & 0xf0); return;
            case 0x53: if (cgb) this.hdmaCurrentDest = (this.hdmaCurrentDest & 0xf0) | (value << 8); return;
            case 0x54: if (cgb) this.hdmaCurrentDest = (this.hdmaCurrentDest & 0xff00) | (value & 0xf0); return;
            case 0x55:
                if (!cgb) return;
                this.hdmaStepsLeft = (value & 0x7f) + 1;
                if (!(value & 0x80) && this.hdmaOnHblank) {
                    // Stops an HBlank transfer.
                    this.hdmaOnHblank = false;
                    return;
                }
                this.hdmaOn = !(value & 0x80);
                this.hdmaOnHblank = (value & 0x80) !== 0;
                // Started in HBlank (or with the LCD off): the first block goes now.
                if (this.hdmaOnHblank && (io[0x41] & 3) === 0 && this.ppu.state !== 7) this.hdmaOn = true;
                return;
            case 0x56: if (cgb) io[0x56] = value; return;
            case 0x70:
                if (!cgb) return;
                this.wramBank = value & 7 || 1;
                io[0x70] = value | 0xf8;
                return;
            case 0x72: case 0x73: case 0x74: case 0x75: io[reg] = value; return;
        }
        if (reg >= 0x10 && reg < 0x40) this.apu.write(addr, value);
    }

    // --- DMA ---------------------------------------------------------------------------

    /**
     * Whether OAM DMA occupies the bus `addr` is on. The CGB has a separate bus
     * for work RAM, with odder rules (these follow SameBoy).
     */
    #dmaBusy(addr) {
        if (addr >= 0xfe00 || this.hdmaInProgress) return false;
        // Not while it's starting up.
        if (this.dmaCurrentDest === 0xff || this.dmaCurrentDest === 0) return false;
        const src = this.dmaCurrentSrc;
        if (src === addr || (src >= 0xe000 && (src & ~0x2000) === addr)) return false;
        if (this.cgb) {
            if (addr >= 0xc000) return cgbBus(src) !== Bus.VRAM;
            if (src >= 0xe000) return cgbBus(addr) !== Bus.VRAM;
            return cgbBus(addr) === cgbBus(src);
        }
        return dmgBus(addr) === dmgBus(src);
    }

    /** A CPU write during OAM DMA on its bus; returns true when the write still goes (elsewhere). */
    #dmaWriteConflict(addr, value) {
        const src = this.dmaCurrentSrc;
        const oam = this.ppu.oam;
        if (this.cgb && cgbBus(addr) === Bus.MAIN && src >= 0xe000) return false;
        if (this.cgb && addr >= 0xc000 && (src < 0xc000 || src >= 0xe000)) {
            this.#write(((src - 1) & 0x1000) | (addr & 0xfff) | 0xc000, value);
            return false;
        }
        const target = (src - 1) & 0xffff;
        if (this.cgb || target >= 0xa000) {
            // The byte being copied is disturbed.
            if (target < 0xa000) oam[this.dmaCurrentDest - 1] = 0;
            else if (!this.cgb) oam[this.dmaCurrentDest - 1] &= value;
            if (!this.cgb || target >= 0xa000) return false;
        }
        // The write lands on the DMA's address instead (on a ROM source: the mapper).
        this.#write(target, value);
        return false;
    }

    /** Runs OAM DMA for the T-cycles in dmaCycles: a byte every 4 (GB_dma_run). */
    dmaRun() {
        if (this.dmaCurrentDest === 0xa1) return;
        const cpu = this.cpu;
        if (cpu.halted || cpu.stopped) return;
        const oam = this.ppu.oam;
        let cycles = this.dmaCycles + this.dmaCyclesModulo;
        this.inDmaRead = true;
        while (cycles >= 4) {
            cycles -= 4;
            if (this.dmaCurrentDest >= 0xa0) {
                // Starting up (0xFF) or finishing (0xA0): an M-cycle without a copy.
                this.dmaCurrentDest = (this.dmaCurrentDest + 1) & 0xff;
                if (this.ppu.state === 8) {
                    this.io[0x41] |= 2;
                    this.ppu.statUpdate();
                }
                break;
            }
            if (this.hdmaInProgress && (this.hdmaStepsLeft > 1 || (this.hdmaCurrentDest & 0xf) !== 0xf)) {
                this.dmaCurrentDest++;
            } else if (this.dmaCurrentSrc < 0xe000) {
                oam[this.dmaCurrentDest++] = this.read(this.dmaCurrentSrc);
            } else {
                // From E000 up: work RAM like its echo on a DMG, nothing on a CGB.
                oam[this.dmaCurrentDest++] = this.cgb ? 0xff : this.read(this.dmaCurrentSrc & ~0x2000);
            }
            this.dmaCurrentSrc = (this.dmaCurrentSrc + 1) & 0xffff;
            this.dmaPpuVramConflict = false;
        }
        this.inDmaRead = false;
        this.dmaCyclesModulo = cycles;
        this.dmaCycles = 0;
    }

    /** Copies HDMA blocks while hdmaOn: 2 bytes per M-cycle, the CPU waiting (GB_hdma_run). */
    hdmaRun() {
        const { ppu } = this;
        const vram = ppu.vram;
        const cycles = this.doubleSpeed ? 4 : 2;
        this.addrForHdmaConflict = 0xffff;
        const vramBase = ppu.vramBank << 13;
        this.hdmaInProgress = true;
        this.advance(cycles);
        while (this.hdmaOn) {
            let byte = 0xff;
            this.addrForHdmaConflict = 0xffff;
            const src = this.hdmaCurrentSrc;
            if (src < 0x8000 || (src & 0xe000) === 0xc000 || (src & 0xe000) === 0xa000) byte = this.read(src);
            if (this.dmaCurrentDest !== 0xa1 && (this.dmaCyclesModulo === 2 || this.doubleSpeed) && (src & 0xff) < 0xa0) {
                ppu.oam[src & 0xff] = byte;
            }
            this.hdmaCurrentSrc = (src + 1) & 0xffff;
            this.advance(cycles);
            let dest;
            if (this.addrForHdmaConflict === 0xffff) {
                dest = this.hdmaCurrentDest & 0x1fff;
            } else {
                // The PPU read VRAM at the same time: the addresses mix (CGB-E).
                dest = this.hdmaCurrentDest & this.addrForHdmaConflict & 0x1fff;
            }
            this.hdmaCurrentDest = (this.hdmaCurrentDest + 1) & 0xffff;
            vram[vramBase + dest] = byte;
            if (ppu.vramWriteBlocked) vram[(vramBase ^ 0x2000) + dest] = byte;
            if ((this.hdmaCurrentDest & 0xf) === 0) {
                if (--this.hdmaStepsLeft === 0 || this.hdmaCurrentDest === 0) {
                    this.hdmaOn = false;
                    this.hdmaOnHblank = false;
                } else if (this.hdmaOnHblank) {
                    this.hdmaOn = false;
                }
            }
        }
        this.hdmaInProgress = false;
        if (!this.doubleSpeed) this.advance(2);
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
