/**
 * Tests for IEEE 754 <-> IBM HFP conversion (xptIEEE754.ts).
 */

import { ieeeToIbmDouble, ibmDoubleToIeee, IBM_DOUBLE_MAX_VALUE, IBM_DOUBLE_MIN_VALUE } from '../export/xptIEEE754';

function hex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

describe('xptIEEE754', () => {
    describe('ieeeToIbmDouble', () => {
        // Known reference values from SAS TS-140 / xport library
        const known: [number, string][] = [
            [1.0, '41 10 00 00 00 00 00 00'],
            [-1.0, 'c1 10 00 00 00 00 00 00'],
            [0.0, '00 00 00 00 00 00 00 00'],
            [0.5, '40 80 00 00 00 00 00 00'],
            [2.0, '41 20 00 00 00 00 00 00'],
            [16.0, '42 10 00 00 00 00 00 00'],
            [10.0, '41 a0 00 00 00 00 00 00'],
            [100.0, '42 64 00 00 00 00 00 00'],
        ];

        it.each(known)('converts %f to %s', (value, expected) => {
            const result = ieeeToIbmDouble(value);
            expect(hex(result.bytes)).toBe(expected);
            expect(result.clipped).toBe(false);
        });

        it('handles NaN as clipped zeros', () => {
            const result = ieeeToIbmDouble(NaN);
            expect(hex(result.bytes)).toBe('00 00 00 00 00 00 00 00');
            expect(result.clipped).toBe(true);
        });

        it('handles Infinity as clipped max value', () => {
            for (const val of [Infinity, -Infinity]) {
                const result = ieeeToIbmDouble(val);
                // exp = 0x7f, sign = val < 0
                expect(result.clipped).toBe(true);
                const bytes = result.bytes;
                expect(bytes[0]).toBe(val < 0 ? 0xff : 0x7f);
                for (let i = 1; i < 8; i++) expect(bytes[i]).toBe(0xff);
            }
        });

        it('treats -0 as zero', () => {
            const result = ieeeToIbmDouble(-0);
            expect(hex(result.bytes)).toBe('00 00 00 00 00 00 00 00');
            expect(result.clipped).toBe(false);
        });

        it('clips subnormals below min value to zero', () => {
            const tiny = 1e-300; // well below IBM_DOUBLE_MIN_VALUE
            const result = ieeeToIbmDouble(tiny);
            expect(hex(result.bytes)).toBe('00 00 00 00 00 00 00 00');
            expect(result.clipped).toBe(true);
        });

        it('clips values above max to max', () => {
            const huge = 1e100; // well above IBM_DOUBLE_MAX_VALUE
            const result = ieeeToIbmDouble(huge);
            expect(result.bytes[0]).toBe(0x7f);
            for (let i = 1; i < 8; i++) expect(result.bytes[i]).toBe(0xff);
            expect(result.clipped).toBe(true);
        });

        it('round-trips common numbers with good precision', () => {
            const tests = [0, 1, -1, 0.5, -0.5, 3.141592653589793, -273.15, 1e10, 1e-10];
            for (const v of tests) {
                const { bytes, clipped } = ieeeToIbmDouble(v);
                expect(clipped).toBe(false);
                const back = ibmDoubleToIeee(bytes);
                if (v === 0) {
                    expect(back).toBe(0);
                } else {
                    const rel = Math.abs((back - v) / v);
                    expect(rel).toBeLessThan(1e-12);
                }
            }
        });
    });

    describe('ibmDoubleToIeee', () => {
        it('converts zero bytes to 0', () => {
            const bytes = new Uint8Array(8);
            expect(ibmDoubleToIeee(bytes)).toBe(0);
        });

        it('throws on wrong length', () => {
            expect(() => ibmDoubleToIeee(new Uint8Array(4))).toThrow('require 8 bytes');
        });
    });

    describe('constants', () => {
        it('IBM_DOUBLE_MIN_VALUE is about 5.4e-79', () => {
            expect(IBM_DOUBLE_MIN_VALUE).toBeGreaterThan(5e-79);
            expect(IBM_DOUBLE_MIN_VALUE).toBeLessThan(6e-79);
        });

        it('IBM_DOUBLE_MAX_VALUE is about 7.2e75', () => {
            expect(IBM_DOUBLE_MAX_VALUE).toBeGreaterThan(7e75);
            expect(IBM_DOUBLE_MAX_VALUE).toBeLessThan(8e75);
        });
    });
});
