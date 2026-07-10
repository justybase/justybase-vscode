/**
 * Windows-1252 (CP-1252) encoder.
 *
 * Maps Unicode code points to single-byte Windows-1252 values.
 * Characters outside the printable 1252 range are replaced with '?' (0x3F)
 * and reported as warnings.
 */

// Code points that differ from ISO-8859-1 (0x80-0x9F are printable in Win1252).
const CP1252_MAP: Map<number, number> = new Map([
    [0x20AC, 0x80], // € EURO SIGN
    [0x201A, 0x82], // ‚ SINGLE LOW-9 QUOTATION MARK
    [0x0192, 0x83], // ƒ LATIN SMALL LETTER F WITH HOOK
    [0x201E, 0x84], // „ DOUBLE LOW-9 QUOTATION MARK
    [0x2026, 0x85], // … HORIZONTAL ELLIPSIS
    [0x2020, 0x86], // † DAGGER
    [0x2021, 0x87], // ‡ DOUBLE DAGGER
    [0x02C6, 0x88], // ˆ MODIFIER LETTER CIRCUMFLEX ACCENT
    [0x2030, 0x89], // ‰ PER MILLE SIGN
    [0x0160, 0x8A], // Š LATIN CAPITAL LETTER S WITH CARON
    [0x2039, 0x8B], // ‹ SINGLE LEFT-POINTING ANGLE QUOTATION MARK
    [0x0152, 0x8C], // Œ LATIN CAPITAL LIGATURE OE
    [0x017D, 0x8E], // Ž LATIN CAPITAL LETTER Z WITH CARON
    [0x2018, 0x91], // ' LEFT SINGLE QUOTATION MARK
    [0x2019, 0x92], // ' RIGHT SINGLE QUOTATION MARK
    [0x201C, 0x93], // " LEFT DOUBLE QUOTATION MARK
    [0x201D, 0x94], // " RIGHT DOUBLE QUOTATION MARK
    [0x2022, 0x95], // • BULLET
    [0x2013, 0x96], // – EN DASH
    [0x2014, 0x97], // — EM DASH
    [0x02DC, 0x98], // ˜ SMALL TILDE
    [0x2122, 0x99], // ™ TRADE MARK SIGN
    [0x0161, 0x9A], // š LATIN SMALL LETTER S WITH CARON
    [0x203A, 0x9B], // › SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    [0x0153, 0x9C], // œ LATIN SMALL LIGATURE OE
    [0x017E, 0x9E], // ž LATIN SMALL LETTER Z WITH CARON
    [0x0178, 0x9F], // Ÿ LATIN CAPITAL LETTER Y WITH DIAERESIS
]);

export interface EncodeResult {
    bytes: Uint8Array;
    warned: boolean; // true if any character was replaced with '?'
}

/**
 * Encode a string to Windows-1252 bytes.
 *
 * Characters in the ASCII range (0x00-0x7F) are passed through.
 * Characters with code points 0xA0-0xFF are mapped via Latin-1 (ISO-8859-1)
 * which is identical to Windows-1252 in that range.
 * Extended Windows-1252 characters (0x80-0x9F area) are looked up via the map.
 * Any unmappable character is replaced with 0x3F ('?').
 *
 * @returns An object with the encoded bytes and a flag indicating if any
 *          replacements were made.
 */
export function encodeWin1252(input: string): EncodeResult {
    const buf = Buffer.alloc(input.length);
    let warned = false;

    for (let i = 0; i < input.length; i++) {
        const cp = input.charCodeAt(i);
        if (cp <= 0x7f) {
            // ASCII passes through
            buf[i] = cp;
        } else if (cp >= 0xa0 && cp <= 0xff) {
            // ISO-8859-1 / Latin-1 range (same as Windows-1252)
            buf[i] = cp;
        } else if (CP1252_MAP.has(cp)) {
            buf[i] = CP1252_MAP.get(cp)!;
        } else {
            // Unmappable: use '?'
            buf[i] = 0x3f;
            warned = true;
        }
    }

    return { bytes: buf, warned };
}
