/**
 * Tests for Windows-1252 encoding (xptWin1252.ts).
 */

import { encodeWin1252 } from '../export/xptWin1252';

describe('xptWin1252', () => {
    describe('encodeWin1252', () => {
        it('encodes ASCII characters unchanged', () => {
            const result = encodeWin1252('Hello, World! 123');
            expect(result.warned).toBe(false);
            const str = Array.from(result.bytes, b => String.fromCharCode(b)).join('');
            expect(str).toBe('Hello, World! 123');
        });

        it('encodes Latin-1 characters (0xA0-0xFF)', () => {
            const result = encodeWin1252('©®°±²³´µ¶·¸¹º»¼½¾¿ÀÁ');
            expect(result.warned).toBe(false);
            expect(result.bytes.length).toBe('©®°±²³´µ¶·¸¹º»¼½¾¿ÀÁ'.length);
        });

        it('encodes Windows-1252 specific characters (0x80-0x9F)', () => {
            // € (Euro sign, U+20AC) → 0x80
            const euro = encodeWin1252('€');
            expect(euro.bytes[0]).toBe(0x80);
            expect(euro.warned).toBe(false);

            // ™ (Trade mark, U+2122) → 0x99
            const tm = encodeWin1252('™');
            expect(tm.bytes[0]).toBe(0x99);
            expect(tm.warned).toBe(false);
        });

        it('replaces unmappable characters with ? and warns', () => {
            // Chinese characters are not in Windows-1252
            const result = encodeWin1252('中文测试');
            expect(result.warned).toBe(true);
            for (const b of result.bytes) {
                expect(b).toBe(0x3f); // '?'
            }
        });

        it('handles mixed content', () => {
            const result = encodeWin1252('Hello € world ™ test ©');
            expect(result.warned).toBe(false);
            // Check the € and ™ are encoded
            const bytes = result.bytes;
            const expected = 'Hello '.split('').map(c => c.charCodeAt(0));
            expected.push(0x80); // €
            expected.push(...' world '.split('').map(c => c.charCodeAt(0)));
            expected.push(0x99); // ™
            expected.push(...' test '.split('').map(c => c.charCodeAt(0)));
            expected.push(0xa9); // ©
            expect(Array.from(bytes)).toEqual(expected);
        });

        it('handles null/empty string', () => {
            const result = encodeWin1252('');
            expect(result.bytes.length).toBe(0);
            expect(result.warned).toBe(false);
        });
    });
});
