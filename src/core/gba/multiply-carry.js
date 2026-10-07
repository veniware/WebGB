/*
 * The carry flag after a multiply, from the ARM7TDMI's Booth multiplier:
 * the flag is one bit of the carry-save adders' "partial carry".
 *
 * Altered source: ported from zaydlang's multiplication-algorithm (C) to
 * JavaScript, reduced to the carry flag and to 32-bit words. Original notice:
 *
 * Copyright (c) 2024 zaydlang
 *
 * This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.
 *
 * Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:
 *
 *     1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
 *     2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
 *     3. This notice may not be removed or altered from any source distribution.
 */

export const Flavor = { SHORT: 0, LONG_UNSIGNED: 1, LONG_SIGNED: 2 };

/**
 * The carry flag of MULS/MLAS (SHORT) or UMULLS/UMLALS/SMULLS/SMLALS.
 * Values are 32-bit words; the accumulator is accHi:accLo (0 without one).
 *
 * The multiplier runs up to 4 cycles of 4 radix-4 Booth steps through
 * carry-save adders (CSAs), 34 bits wide; each cycle retires 8 bits of the
 * partial sum and carry. The flag is bit 31 of the partial carry, or bit 63
 * for a long multiply that ran all 4 cycles.
 */
export function multiplyCarry(flavor, multiplicand, multiplier, accLo = 0, accHi = 0) {
    const signed = flavor !== Flavor.LONG_UNSIGNED;
    // Values above 32 bits are split: lo (bits 0-31) and hi (bits 32 up).
    const mLo = multiplicand | 0;
    const mHi = signed && mLo < 0 ? 3 : 0;
    let rLo = multiplier | 0;
    // The partial carry starts with the multiplicand negated (Booth's bit -1),
    // the partial sum with the accumulator; both shifted right once.
    let cLo = 0;
    let cHi = 0;
    if (rLo & 1) {
        cLo = (~mLo >>> 1) | ((~mHi & 1) << 31);
        cHi = (~mHi >>> 1) & 1;
    }
    let sLo = (accLo >>> 1) | ((accHi & 1) << 31);
    let sHi = (accHi >>> 1) & 1;
    // The accumulator's bits from 34 up, fed in 2 bits per CSA.
    let acc = accHi >>> 2;
    let low = 0; // the 8 partial carry bits retired by the last cycle
    let cycles = 0;
    do {
        low = 0;
        for (let i = 0; i < 4; i++) {
            // The Booth addend for multiplier bits 2i-1..2i+1 (34 bits), plus 1 when negative.
            let xLo = 0;
            let xHi = 0;
            let xCarry = 0;
            switch ((rLo >>> (2 * i)) & 7) {
                case 1: case 2: xLo = mLo; xHi = mHi; break;
                case 3: xLo = mLo << 1; xHi = ((mHi << 1) | (mLo >>> 31)) & 3; break;
                case 4: xLo = ~(mLo << 1); xHi = ~((mHi << 1) | (mLo >>> 31)) & 3; xCarry = 1; break;
                case 5: case 6: xLo = ~mLo; xHi = ~mHi & 3; xCarry = 1; break;
            }
            sHi &= 1;
            cHi &= 1;
            const oLo = sLo ^ xLo ^ cLo;
            const oHi = sHi ^ (xHi & 1) ^ cHi;
            let kLo = (sLo & xLo) | (xLo & cLo) | (cLo & sLo);
            let kHi = (sHi & xHi & 1) | (xHi & cHi & 1) | (cHi & sHi);
            // Carries move up a bit; the Booth carry goes into the free bit 0.
            kHi = (kHi << 1) | (kLo >>> 31);
            kLo = (kLo << 1) | xCarry;
            // The two lowest bits are final (later addends are 4x bigger).
            low |= (kLo & 3) << (2 * i);
            // Sign extension of the carry and the addend, folded into bits 31-32.
            const magic = (acc & 1) + (1 - (cHi & 1)) + (1 - (xHi >>> 1));
            sLo = (oLo >>> 2) | ((oHi & 3) << 30) | ((magic & 1) << 31);
            sHi = (oHi >>> 2) | (magic >>> 1);
            cLo = (kLo >>> 2) | ((kHi & 3) << 30);
            cHi = (kHi >>> 2) | (1 - ((acc >>> 1) & 1));
            acc >>>= 2;
        }
        rLo = signed ? rLo >> 8 : rLo >>> 8;
        cycles++;
    } while (rLo !== 0 && !(signed && rLo === -1));
    // Bits retired so far: 1 + 8 per cycle; the rest of the partial carry follows.
    if (flavor !== Flavor.SHORT && cycles === 4) return (cLo >>> 30) & 1; // bit 63
    if (cycles === 4) return (low >>> 6) & 1; // bit 31
    return (cLo >>> (30 - 8 * cycles)) & 1; // bit 31
}
