/**
 * IEEE 754 double-precision <-> IBM System/360 hexadecimal floating point
 * (HFP / XPORT v5 numeric encoding), per SAS TS-140.
 *
 * IBM HFP (8 bytes, big-endian):
 *   byte 0  bit 7  : sign (1 = negative)
 *   byte 0  bits 6..0 : exponent, base 16, bias 64
 *   bytes 1..7 :  56-bit mantissa, normalized so top nibble (bits 55..52) != 0
 *
 * Value = (-1)^S * 16^(E - 64) * 0.M       M = 56-bit unsigned integer
 *       = (-1)^S * 16^(E - 64) * M / 2^56
 *
 * Finite range:  ~5.4e-79  <= |x| <= ~7.2e75
 */

export interface IbmDoubleResult {
    bytes: Uint8Array;
    clipped: boolean;
}

const BIAS = 64;
const MAX_EXP = 127;

/** Largest finite positive IBM HFP value */
export const IBM_DOUBLE_MAX_VALUE = 16.0 ** (MAX_EXP - BIAS) * (1.0 - 16.0 ** -14.0);
/** Smallest positive normalized IBM HFP value (exp=0, mant=0x10) */
export const IBM_DOUBLE_MIN_VALUE = 16.0 ** (0 - BIAS) * (1.0 / 16.0);

// ── IEEE 754 raw decomposition ──────────────────────────────────────────

interface IeeeBits {
    sign: number;  // 0|1
    exp: number;   // biased exponent 0..2047
    mant: number;  // 52-bit mantissa (low 52 bits of the 64-bit word)
}

function getIeeeBits(value: number): IeeeBits {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    const lo = new Uint32Array(buf)[0];
    const hi = new Uint32Array(buf)[1];
    return {
        sign: (hi >>> 31) & 1,
        exp: (hi >>> 20) & 0x7ff,
        mant: ((hi & 0x000fffff) * 0x100000000) + lo,
    };
}

// ── Conversion ──────────────────────────────────────────────────────────

/**
 * Convert an IEEE 754 double to 8 bytes of IBM HFP.
 *
 * Edge-case policy:
 *  - ±0 → zero bytes
 *  - NaN → zero bytes (clipped = true)
 *  - ±Infinity → ±IBM_DOUBLE_MAX_VALUE (clipped = true)
 *  - Subnormals below IBM_DOUBLE_MIN_VALUE → zero (clipped = true)
 *  - Values above IBM_DOUBLE_MAX_VALUE → IBM_DOUBLE_MAX_VALUE (clipped = true)
 */
export function ieeeToIbmDouble(value: number): IbmDoubleResult {
    // Fast zero / edge checks.
    if (value === 0 || Number.isNaN(value)) {
        return { bytes: new Uint8Array(8), clipped: Number.isNaN(value) };
    }
    if (!Number.isFinite(value)) {
        return { bytes: maxIbmBytes(value < 0), clipped: true };
    }
    const abs = Math.abs(value);
    if (abs < IBM_DOUBLE_MIN_VALUE) {
        return { bytes: new Uint8Array(8), clipped: true };
    }
    if (abs > IBM_DOUBLE_MAX_VALUE) {
        return { bytes: maxIbmBytes(value < 0), clipped: true };
    }

    // Decompose IEEE 754.
    const ieee = getIeeeBits(value);
    const s = ieee.sign;
    const ee = ieee.exp;        // biased IEEE exponent
    const mm = ieee.mant;       // 52-bit mantissa fraction

    // Build the 53-bit significand integer using BigInt (JS bitwise ops truncate to 32 bits).
    const mmBig = BigInt(mm);
    const sig53: bigint = ee !== 0
        ? (1n << 52n) | mmBig    // normal: set the hidden bit (bit 52)
        : mmBig;                  // subnormal
    // binExp such that: value = (-1)^s * sig53 * 2^binExp
    // For IEEE, binExp = ee - 1075 (derived from ee - 1023 - 52)
    const binExp = ee !== 0 ? ee - 1075 : -1074;

    // Convert binary exponent to hex: 2^binExp = 16^(K // 4) * 2^(K % 4)
    // where K = binExp + 56
    // This expresses the mantissa as a 56-bit integer times a power of 16.
    const K = binExp + 56;               // used to align to 56-bit mantissa
    let hexExpUnbiased = Math.floor(K / 4);  // unbiased hex exponent
    const rem = K - hexExpUnbiased * 4;         // [0..3] binary remainder

    // Build the raw 56-bit mantissa.
    // M56 = sig53 * 2^rem (sig53 is 53-bit, shifting by 0..3 gives at most 56 bits)
    const shift56 = rem; // 0..3
    let M56 = sig53 << BigInt(shift56);

    // Normalize: ensure the top nibble (bits 55..52) is non-zero.
    // If zero, shift left by 4 and decrement hexExp.
    // If M56 >= 2^56, shift right by 4 and increment hexExp.
    while (M56 >= (1n << 56n)) {
        M56 >>= 4n;
        hexExpUnbiased++;
    }
    while (M56 !== 0n && (M56 >> 52n) === 0n) {
        M56 <<= 4n;
        hexExpUnbiased--;
    }

    // Guard against range overflow.
    const storedExp = hexExpUnbiased + BIAS;
    if (storedExp <= 0) {
        return { bytes: new Uint8Array(8), clipped: true };
    }
    if (storedExp >= MAX_EXP) {
        return { bytes: maxIbmBytes(s === 1), clipped: true };
    }

    // Mask to 56 bits.
    M56 &= 0x00ffffffffffffffn;

    // Pack: byte0 = sign (1) + exp (7), bytes 1..7 = M56 big-endian.
    const bytes = new Uint8Array(8);
    bytes[0] = (s << 7) | (storedExp & 0x7f);
    for (let i = 0; i < 7; i++) {
        bytes[1 + i] = Number((M56 >> BigInt(48 - i * 8)) & 0xffn);
    }
    return { bytes, clipped: false };
}

function maxIbmBytes(negative: boolean): Uint8Array {
    const bytes = new Uint8Array(8);
    bytes[0] = negative ? 0xff : 0x7f;
    for (let i = 1; i < 8; i++) bytes[i] = 0xff;
    return bytes;
}

// ── Reverse ─────────────────────────────────────────────────────────────

export function ibmDoubleToIeee(bytes: Uint8Array): number {
    if (bytes.length !== 8) throw new Error('require 8 bytes');
    const sign = (bytes[0] & 0x80) !== 0;
    const exp = bytes[0] & 0x7f;
    const M56 = readBigUint56(bytes);
    if (exp === 0 && M56 === 0n) return 0;
    const value = Number(M56) / 0x0100000000000000 * 16.0 ** (exp - BIAS);
    return sign ? -value : value;
}

function readBigUint56(bytes: Uint8Array): bigint {
    let m = 0n;
    for (let i = 1; i < 8; i++) m = (m << 8n) | BigInt(bytes[i]);
    return m;
}
