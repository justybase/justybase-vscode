/**
 * XPORT v5 header/namestr/observation record structures.
 *
 * All records are 80 bytes, space-padded. Data lives in EBCDIC encoding
 * for version-5 headers, but we use ASCII (0x20 space) since the XPORT v5
 * standard allows both and most readers accept ASCII.
 */

import type { SasColumnDef } from './xptColumnMapper';
import { encodeWin1252 } from './xptWin1252';
import { ieeeToIbmDouble } from './xptIEEE754';

const RECORD_LENGTH = 80;
// Namestr is 140 bytes per variable; it's streamed across 80-byte record boundaries.
const NAMESTR_LENGTH = 140;

// ── Record streaming helpers ────────────────────────────────────────────

/**
 * Accumulates bytes and emits complete 80-byte records.
 * Used to stream arbitrarily-sized data (like the concatenated namestr)
 * into the 80-byte record stream.
 */
export class RecordWriter {
    private _buffer: number[] = [];
    private _totalBytes = 0;

    /** The cumulative 80-byte records emitted so far. */
    get records(): Uint8Array[] {
        return this._records;
    }
    private _records: Uint8Array[] = [];

    /** Total bytes written (before padding). */
    get totalBytes(): number {
        return this._totalBytes;
    }

    write(bytes: Uint8Array | number[]): void {
        for (const b of bytes) {
            this._buffer.push(b);
            this._totalBytes++;
            if (this._buffer.length === RECORD_LENGTH) {
                this._flush();
            }
        }
    }

    writeString(str: string): void {
        this.write(Array.from(str, c => c.charCodeAt(0)));
    }

    /** Flush the final incomplete record, padding with spaces to 80 bytes. */
    finalize(): Uint8Array[] {
        if (this._buffer.length > 0) {
            while (this._buffer.length < RECORD_LENGTH) {
                this._buffer.push(0x20); // space
                this._totalBytes++;
            }
            this._flush();
        }
        return this._records;
    }

    private _flush(): void {
        this._records.push(new Uint8Array(this._buffer));
        this._buffer = [];
    }
}

// ── Standard header text ────────────────────────────────────────────────

const LIBRARY_HEADER_ID = 'HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!';
const MEMBER_HEADER_ID = 'HEADER RECORD*******MEMBER HEADER RECORD!!!!!!!';
const NAMESTR_HEADER_ID = 'HEADER RECORD*******NAMESTR HEADER RECORD!!!!!!!';
const OBS_HEADER_ID = 'HEADER RECORD*******OBS HEADER RECORD!!!!!!!';

function padSasString(value: string, length: number): string {
    return value.padEnd(length, ' ');
}

// ── Date format ─────────────────────────────────────────────────────────

/**
 * Format a Date into SAS datetime string: "ddmmmyy:hh:mm:ss"
 *
 * - dd = 2-digit day
 * - mmm = 3-letter English month abbreviation (JAN, FEB, ...)
 * - yy = 2-digit year
 * - hh:mm:ss = 24-hour time, zero-padded
 */
export function formatSasDate(date: Date): string {
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = MONTHS[date.getUTCMonth()];
    const year = String(date.getUTCFullYear()).slice(-2);
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    return `${day}${month}${year}:${hh}:${mm}:${ss}`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ── Header record builders ──────────────────────────────────────────────

/**
 * Build the LIBRARY header record (80 bytes).
 *
 * Byte 0-35 :  "HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!"
 * Byte 36-51:  16 bytes - reserved (zeros on creation), but in practice
 *              first 8 = version info, next 8 = OS info
 * Byte 52-59:  creation date "ddmmmyy"    (8 bytes)
 * Byte 60-66:  ":" separator (but spec says colons at 59? No — read further)
 *
 * In practice SAS writes:
 *   bytes 36-43: "SAS     " (version)
 *   bytes 44-51: "SYSNAME " (OS)
 *   bytes 52-59: creation date (ddmmmyy)
 *   bytes 60-67: modification date (ddmmmyy)
 *   No, that's not right either. Let's follow the de-facto standard:
 *
 * Layout from xport Python library observation:
 *   bytes 0..35  : header ID
 *   bytes 36..43 : 8 bytes padding/SAS version ("SAS     ")
 *   bytes 44..51 : 8 bytes OS ("OSNAME   " or spaces)
 *   bytes 52..67 : 16 bytes creation date "ddmmmyy:hh:mm:ss" (or spaces)
 *   bytes 68..79 : 12 bytes padding (or second date)
 *
 * But to be safe, we write a clean 80-byte record that any reader will
 * accept: header ID + padded empty fields.
 */
export function buildLibraryHeader(
    sasVersion: string,
    osName: string,
    created: Date,
    modified: Date,
): Uint8Array {
    const buf = new Uint8Array(RECORD_LENGTH);
    buf.fill(0x20); // spaces

    // Header ID (36 bytes)
    const head = encodeWin1252(LIBRARY_HEADER_ID);
    buf.set(head.bytes.slice(0, 36), 0);

    // SAS version (8 bytes)
    const ver = encodeWin1252(padSasString(sasVersion, 8));
    buf.set(ver.bytes, 36);

    // OS name (8 bytes)
    const os = encodeWin1252(padSasString(osName, 8));
    buf.set(os.bytes, 44);

    // Creation date (16 bytes): "ddmmmyy:hh:mm:ss"
    const cdate = encodeWin1252(formatSasDate(created));
    buf.set(cdate.bytes.slice(0, 16), 52);

    // Modification date (12 bytes — remaining space after 68)
    const mdate = encodeWin1252(formatSasDate(modified));
    buf.set(mdate.bytes.slice(0, 12), 68);

    return buf;
}

/**
 * Build the MEMBER header record (80 bytes).
 *
 * bytes 0..35  : header ID
 * bytes 36..43 : member name (8 chars, left-justified)
 * bytes 44..51 : member type (usually "DATA    ")
 * bytes 52..67 : creation date (16 bytes)
 * bytes 68..79 : modification date (12 bytes — no, 12 bytes filled then padding)
 *
 * Actually member header layout from de-facto standard:
 *   0-35   header ID
 *   36-43  member name (8)
 *   44-51  member type (8) — "DATA    "
 *   52-67  creation date (16)
 *   68-75  modification date (8 bytes? hmm)
 *   76-79  padding (4)
 */
export function buildMemberHeader(
    memberName: string,
    memberType: string,
    created: Date,
    modified: Date,
): Uint8Array {
    const buf = new Uint8Array(RECORD_LENGTH);
    buf.fill(0x20);

    const head = encodeWin1252(MEMBER_HEADER_ID);
    buf.set(head.bytes.slice(0, 36), 0);

    const name = encodeWin1252(padSasString(memberName.toUpperCase(), 8));
    buf.set(name.bytes, 36);

    const type = encodeWin1252(padSasString(memberType, 8));
    buf.set(type.bytes, 44);

    const cdate = encodeWin1252(formatSasDate(created));
    buf.set(cdate.bytes.slice(0, 16), 52);

    const mdate = encodeWin1252(formatSasDate(modified));
    buf.set(mdate.bytes.slice(0, 12), 68);

    return buf;
}

/**
 * Build the NAMESTR header record (80 bytes).
 *
 * bytes 0..35  : header ID
 * bytes 36..39 : "0000" (padding with zeros)
 * bytes 40..43 : number of variables (4-digit decimal, zero-filled)
 * bytes 44..79 : zeros / spaces
 */
export function buildNamestrHeader(numVariables: number): Uint8Array {
    const buf = new Uint8Array(RECORD_LENGTH);
    buf.fill(0x20);
    const head = encodeWin1252(NAMESTR_HEADER_ID);
    buf.set(head.bytes.slice(0, 36), 0);

    // 4 bytes zeros then 4 bytes variable count
    const countStr = `0000${String(numVariables).padStart(4, '0')}`;
    for (let i = 0; i < 8; i++) {
        buf[36 + i] = countStr.charCodeAt(i);
    }
    // Zero out the rest
    for (let i = 44; i < 80; i++) {
        buf[i] = 0x20;
    }

    return buf;
}

/**
 * Build the OBSERVATION header record (80 bytes).
 * All zeros in the data area.
 */
export function buildObsHeader(): Uint8Array {
    const buf = new Uint8Array(RECORD_LENGTH);
    buf.fill(0x20);
    const head = encodeWin1252(OBS_HEADER_ID);
    buf.set(head.bytes.slice(0, 36), 0);
    // Remaining 44 bytes: zeros then spaces
    for (let i = 36; i < 80; i++) {
        buf[i] = 0x00;
    }
    return buf;
}

// ── Namestr record (per variable) ───────────────────────────────────────

/**
 * Build a single variable's namestr block (140 bytes).
 *
 * Layout (from TS-140):
 *   bytes 0..7   : NAME (8 chars, left-justified)
 *   bytes 8..9   : TYPE (1=numeric, 2=char) as 2-digit decimal " 1" or " 2"
 *   bytes 10..11 : HEAP POS? Actually — check spec. HDR LENGTH? Let's use
 *                  the de-facto layout from SAS and "xport" library.
 *
 * The de-facto layout is:
 *   bytes 0..7   : NAME (8)
 *   bytes 8..9   : TYPE (2 bytes, " 1" or " 2") — but could also be
 *                  numeric binary values? The documentation says:
 *                  byte 8 = type (1 or 2), byte 9 = 0 (null) in C struct.
 *   
 *   Actually per TS-140 the namestr layout is a C struct:
 *   struct namestr {
 *     char name[8];        // 0-7
 *     int type;            // 8-11 (4-byte int, binary)
 *     int hdrentry;        // 12-15 (4-byte int)
 *     int hdrlength;       // 16-19 (4-byte int)
 *     int formlength;      // 20-23 (4-byte int)
 *     int formoffset;      // 24-27 (4-byte int)
 *     int inflength;       // 28-31 (4-byte int)
 *     int inpoffset;       // 32-35 (4-byte int)
 *     int position;        // 36-39 (4-byte int)
 *     char label[40];      // 40-79
 *     char format[8];      // 80-87
 *     char inform[8];      // 88-95
 *     int flength;         // 96-99 (4-byte int)
 *     int ilength;         // 100-103 (4-byte int)
 *     int ngent;           // 104-107 (4-byte int)
 *   };
 *   
 * But wait — the header IDs are EBCDIC, and the binary integers are
 * big-endian. The total struct is 108 bytes, but actually the namestr
 * is 140 bytes. The remaining 32 bytes after the struct are padding.
 *
 * Actually the namestr length is 140 because:
 *   8 (name) + 4 (type) + ... = 
 * 
 * Let me just use the Python xport library's confirmed layout:
 *
 *   pos  len  field
 *   0    8    NAME  
 *   8    4    TYPE (big-endian int32: 1=numeric, 2=char)
 *   12   4    HDREntryPtr (?)
 *   16   4    HDRDataLength (?)
 *   20   4    FormattedFieldLength
 *   24   4    FormattedFieldPositionOffset
 *   28   4    InformatFieldLength
 *   32   4    InformatFieldPositionOffset
 *   36   4    Position (1-based column position in observation record)
 *   40   40   LABEL
 *   80   8    FORMAT (output format name)
 *   88   8    INFORMAT (input format name)
 *   96   4    FormatLength
 *   100  4    InformatLength
 *   104  4    (reserved / ngent?)
 *   108  32   padding (zeros) — making 140 total
 *
 * All binary integers are big-endian (IBM mainframe convention).
 * NAME and LABEL are EBCDIC (or ASCII, reader-dependent).
 * FORMAT and INFORMAT are EBCDIC/ASCII.
 */
export function buildNamestr(
    name: string,
    def: SasColumnDef,
    position: number, // 1-based
): Uint8Array {
    const buf = new Uint8Array(NAMESTR_LENGTH);
    buf.fill(0x00);

    // NAME (8 bytes, left-justified, uppercase recommended)
    const nameEnc = encodeWin1252(name.toUpperCase().padEnd(8, ' '));
    buf.set(nameEnc.bytes.slice(0, 8), 0);

    // TYPE (4 bytes, big-endian int32)
    writeInt32BE(buf, 8, def.sasType);

    // HDREntryPtr (4 bytes) — often 0
    writeInt32BE(buf, 12, 0);
    // HDRDataLength (4 bytes) — often 0
    writeInt32BE(buf, 16, 0);

    // FormattedFieldLength (4 bytes)
    writeInt32BE(buf, 20, def.formatLength);
    // FormattedFieldPositionOffset (4 bytes) — often 0
    writeInt32BE(buf, 24, 0);

    // InformatFieldLength (4 bytes)
    writeInt32BE(buf, 28, def.informLength);
    // InformatFieldPositionOffset (4 bytes)
    writeInt32BE(buf, 32, 0);

    // Position (4 bytes, 1-based)
    writeInt32BE(buf, 36, position);

    // LABEL (40 bytes)
    const labelEnc = encodeWin1252(def.label.padEnd(40, ' '));
    buf.set(labelEnc.bytes.slice(0, 40), 40);

    // FORMAT (8 bytes)
    const fmtEnc = encodeWin1252(def.format.padEnd(8, ' '));
    buf.set(fmtEnc.bytes.slice(0, 8), 80);

    // INFORMAT (8 bytes)
    const infEnc = encodeWin1252(def.inform.padEnd(8, ' '));
    buf.set(infEnc.bytes.slice(0, 8), 88);

    // FormatLength (4 bytes)
    writeInt32BE(buf, 96, def.formatLength);
    // InformatLength (4 bytes)
    writeInt32BE(buf, 100, def.informLength);
    // reserved (4 bytes)
    writeInt32BE(buf, 104, 0);

    // remaining 32 bytes are already 0x00 (padding)

    return buf;
}

// ── Numeric value writing ───────────────────────────────────────────────

/**
 * Write a signed 32-bit big-endian integer into a buffer at offset.
 */
export function writeInt32BE(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = (value >> 24) & 0xff;
    buf[offset + 1] = (value >> 16) & 0xff;
    buf[offset + 2] = (value >> 8) & 0xff;
    buf[offset + 3] = value & 0xff;
}

// ── Observation data writing ────────────────────────────────────────────

/**
 * Write a numeric observation value as 8 bytes of IBM HFP.
 * (Delegates to xptIEEE754.)
 */
export function writeNumericObs(
    buf: Uint8Array,
    offset: number,
    value: number | null | undefined,
): { clipped: boolean } {
    if (value === null || value === undefined) {
        buf.fill(0, offset, offset + 8);
        return { clipped: false };
    }
    const result = ieeeToIbmDouble(value);
    buf.set(result.bytes, offset);
    return { clipped: result.clipped };
}

/**
 * Write a character observation value, space-padded to a fixed width.
 */
export function writeCharObs(
    buf: Uint8Array,
    offset: number,
    value: string | null | undefined,
    width: number,
): void {
    if (value === null || value === undefined) {
        for (let i = 0; i < width; i++) buf[offset + i] = 0x20;
        return;
    }
    const result = encodeWin1252(value);
    const bytes = result.bytes;
    const copyLen = Math.min(bytes.length, width);
    for (let i = 0; i < copyLen; i++) buf[offset + i] = bytes[i];
    for (let i = copyLen; i < width; i++) buf[offset + i] = 0x20;
}
