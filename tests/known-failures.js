// Test ROMs that don't pass yet, with the reason; the tests are skipped.
// Keep this honest: remove entries as they get fixed, and don't add entries
// to hide regressions. Names are the test names (path, plus the model or
// subtest in parentheses where a ROM runs more than one way).

export const KNOWN_FAILURES = {
    "mealybug-tearoom-tests/ppu/m3_lcdc_bg_en_change.gb": "off by a pixel at some transitions",
    "mealybug-tearoom-tests/ppu/m3_lcdc_win_en_change_multiple_wx.gb": "window re-enabled with WX changes",
    "same-suite/apu/channel_1/channel_1_freq_change_timing-A.gb": "expects a GBA running the game (AGB timing)",
    "age-test-roms/lcd-align-ly/lcd-align-ly-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "age-test-roms/lcd-align-ly/lcd-align-ly-cgbE.gb (cgb)": "CGB LY timing after switching the LCD on",
    "age-test-roms/ly/ly-dmgC-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "age-test-roms/m3-bg-bgp/m3-bg-bgp.gb (m3-bg-bgp-dmgC.png)": "BGP change mid-line on a DMG-C (a DMG-B is emulated)",
    "age-test-roms/m3-bg-lcdc/m3-bg-lcdc.gb (m3-bg-lcdc-cgbBCE.png)": "LCDC change mid-line on the CGB",
    "age-test-roms/oam/oam-read-dmgC-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "age-test-roms/speed-switch/caution/spsw-interrupts-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "age-test-roms/speed-switch/spsw-ch2-lc-delay-cgbBCE.gb (cgb)": "exact timing around the speed switch",
    "age-test-roms/speed-switch/spsw-tima-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "age-test-roms/speed-switch/spsw-tima-cgbE.gb (cgb)": "exact timing around the speed switch",
    "age-test-roms/stat-mode/stat-mode-dmgC-cgbBC.gb (cgb)": "expects a CGB-B/C (a CGB-E is emulated)",
    "gbmicrotest/halt_op_dupe_delay.gb": "HALT bug timing",
    "gbmicrotest/stat_write_glitch_l154_d.gb": "STAT write glitch on line 154",
    "little-things-gb/tellinglys.gb (dmg)": "input is applied as a frame starts (least lag), so joypad interrupts come at the same line",
    "little-things-gb/tellinglys.gb (cgb)": "input is applied as a frame starts (least lag), so joypad interrupts come at the same line",
};
