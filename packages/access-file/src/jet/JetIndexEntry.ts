/**
 * Index entries (port of IndexData.Entry/NodeEntry and RowId from
 * JustyBase.UCanAccessCs / Jackcess).
 *
 * A leaf entry is:  [entryBytes][pageNumber 3 bytes BE][rowNumber 1 byte]
 * A node entry is:  [entryBytes][pageNumber 3 bytes BE][rowNumber 1 byte][subPageNumber 4 bytes BE]
 *
 * entryBytes are written in BIG_ENDIAN order (the index page header is
 * little-endian, the entry data is big-endian).
 */

export class JetRowId {
    public static readonly InvalidRowNumber = -1;
    public static readonly FirstPageNumber = -1;
    public static readonly LastPageNumber = -2;

    public readonly pageNumber: number;
    public readonly rowNumber: number;

    public constructor(pageNumber: number, rowNumber: number) {
        this.pageNumber = pageNumber;
        this.rowNumber = rowNumber;
    }

    public get idType(): 'always-first' | 'normal' | 'always-last' {
        if (this.pageNumber === JetRowId.FirstPageNumber) return 'always-first';
        if (this.pageNumber === JetRowId.LastPageNumber) return 'always-last';
        return 'normal';
    }

    public get isValid(): boolean {
        return this.rowNumber >= 0 && this.pageNumber >= 0;
    }

    public compareTo(other: JetRowId): number {
        const left = this.idType;
        const right = other.idType;
        if (left !== right) {
            return left === 'always-first' ? -1 : left === 'always-last' ? 1 : right === 'always-first' ? 1 : -1;
        }
        if (this.pageNumber !== other.pageNumber) {
            return this.pageNumber < other.pageNumber ? -1 : 1;
        }
        return this.rowNumber - other.rowNumber;
    }

    public equals(other: JetRowId): boolean {
        return this.pageNumber === other.pageNumber && this.rowNumber === other.rowNumber;
    }
}

export const FIRST_ROW_ID = new JetRowId(JetRowId.FirstPageNumber, JetRowId.InvalidRowNumber);
export const LAST_ROW_ID = new JetRowId(JetRowId.LastPageNumber, JetRowId.InvalidRowNumber);

export type JetEntryType = 'always-first' | 'first-valid' | 'normal' | 'last-valid' | 'always-last';

function determineEntryType(entryBytes: Uint8Array | null, rowId: JetRowId): JetEntryType {
    if (entryBytes !== null) {
        return rowId.idType === 'normal'
            ? 'normal'
            : rowId.idType === 'always-first' ? 'first-valid' : 'last-valid';
    }
    if (!rowId.isValid) {
        return rowId.idType === 'always-first' ? 'always-first' : 'always-last';
    }
    throw new Error('Values was null for valid entry');
}

/** Compares two index entry byte sequences. */
export function byteCodeCompare(left: Uint8Array | null, right: Uint8Array | null): number {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    const len = Math.min(left.length, right.length);
    let pos = 0;
    while (pos < len && left[pos] === right[pos]) {
        pos++;
    }
    if (pos < len) {
        return (left[pos]! & 0xff) < (right[pos]! & 0xff) ? -1 : 1;
    }
    return left.length - right.length;
}

export function read3ByteIntBigEndian(buffer: Uint8Array, offset: number): number {
    return (buffer[offset]! << 16) | (buffer[offset + 1]! << 8) | buffer[offset + 2]!;
}

export function write3ByteIntBigEndian(buffer: Uint8Array, offset: number, value: number): void {
    buffer[offset] = (value >> 16) & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset + 2] = value & 0xff;
}

export function read4ByteIntBigEndian(buffer: Uint8Array, offset: number): number {
    return ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0;
}

export function write4ByteIntBigEndian(buffer: Uint8Array, offset: number, value: number): void {
    buffer[offset] = (value >> 24) & 0xff;
    buffer[offset + 1] = (value >> 16) & 0xff;
    buffer[offset + 2] = (value >> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
}

export class JetIndexEntry {
    public readonly rowId: JetRowId;
    protected readonly entryBytes: Uint8Array | null;
    private readonly type: JetEntryType;

    public constructor(entryBytes: Uint8Array | null, rowId: JetRowId, type?: JetEntryType) {
        this.rowId = rowId;
        this.entryBytes = entryBytes;
        this.type = type ?? determineEntryType(entryBytes, rowId);
    }

    /** Reads an existing entry from a buffer (with optional extra trailing bytes). */
    public static readFromBuffer(buffer: Uint8Array, offset: number, entryLen: number, extraTrailingLen: number): JetIndexEntry {
        const colEntryLen = entryLen - (4 + extraTrailingLen);
        const entryBytes = buffer.slice(offset, offset + colEntryLen);
        const page = read3ByteIntBigEndian(buffer, offset + colEntryLen);
        const row = buffer[offset + colEntryLen + 3] ?? 0;
        return new JetIndexEntry(entryBytes, new JetRowId(page, row));
    }

    public get subPageNumber(): number | null {
        return null;
    }

    public get isLeafEntry(): boolean {
        return true;
    }

    public get isValid(): boolean {
        return this.entryBytes !== null;
    }

    public getEntryBytes(): Uint8Array | null {
        return this.entryBytes;
    }

    /** size of this entry in the database */
    public get size(): number {
        return (this.entryBytes?.length ?? 0) + 4;
    }

    /** writes this entry into the given output, omitting the given prefix bytes */
    public write(output: Uint8Array, outputPos: number, prefix: Uint8Array): number {
        const entryBytes = this.entryBytes!;
        let pos = outputPos;
        if (prefix.length <= entryBytes.length) {
            output.set(entryBytes.subarray(prefix.length), pos);
            pos += entryBytes.length - prefix.length;
            write3ByteIntBigEndian(output, pos, this.rowId.pageNumber);
            pos += 3;
        } else if (prefix.length <= entryBytes.length + 3) {
            const tmp = new Uint8Array(3);
            write3ByteIntBigEndian(tmp, 0, this.rowId.pageNumber);
            const skip = prefix.length - entryBytes.length;
            output.set(tmp.subarray(skip), pos);
            pos += tmp.length - skip;
        } else {
            throw new Error('prefix should never be this long');
        }
        output[pos] = this.rowId.rowNumber & 0xff;
        return pos + 1;
    }

    /** whether the entry bytes are equal between this entry and the given entry */
    public equalsEntryBytes(other: JetIndexEntry): boolean {
        return byteCodeCompare(this.entryBytes, other.entryBytes) === 0;
    }

    public compareTo(other: JetIndexEntry): number {
        if (this === other) {
            return 0;
        }
        if (this.isValid && other.isValid) {
            const entryCmp = byteCodeCompare(this.entryBytes, other.entryBytes);
            if (entryCmp !== 0) {
                return entryCmp;
            }
        } else {
            const typeOrder: JetEntryType[] = ['always-first', 'first-valid', 'normal', 'last-valid', 'always-last'];
            const left = typeOrder.indexOf(this.type);
            const right = typeOrder.indexOf(other.type);
            if (left !== right) {
                return left - right;
            }
        }
        return this.rowId.compareTo(other.rowId);
    }

    public equals(other: JetIndexEntry): boolean {
        return this === other || (other !== null && this.constructor === other.constructor && this.compareTo(other) === 0);
    }

    /** returns a copy of this entry as a node entry with the given sub page number */
    public asNodeEntry(subPageNumber: number): JetIndexNodeEntry {
        return new JetIndexNodeEntry(this.entryBytes, this.rowId, this.type, subPageNumber);
    }
}

export class JetIndexNodeEntry extends JetIndexEntry {
    private readonly _subPageNumber: number;

    public constructor(entryBytes: Uint8Array | null, rowId: JetRowId, type: JetEntryType, subPageNumber: number) {
        super(entryBytes, rowId, type);
        this._subPageNumber = subPageNumber;
    }

    /** reads an existing node entry from a buffer */
    public static readFromBuffer(buffer: Uint8Array, offset: number, entryLen: number): JetIndexNodeEntry {
        const entry = JetIndexEntry.readFromBuffer(buffer, offset, entryLen, 4);
        const subPageNumber = read4ByteIntBigEndian(buffer, offset + entryLen - 4);
        return new JetIndexNodeEntry(entry.getEntryBytes(), entry.rowId, 'normal', subPageNumber);
    }

    public override get subPageNumber(): number {
        return this._subPageNumber;
    }

    public override get isLeafEntry(): boolean {
        return false;
    }

    public override get size(): number {
        return super.size + 4;
    }

    public override write(output: Uint8Array, outputPos: number, prefix: Uint8Array): number {
        const pos = super.write(output, outputPos, prefix);
        write4ByteIntBigEndian(output, pos, this._subPageNumber);
        return pos + 4;
    }

    public override equals(other: JetIndexEntry): boolean {
        return this === other
            || (other instanceof JetIndexNodeEntry && this.compareTo(other) === 0 && this._subPageNumber === other._subPageNumber);
    }
}

/** sentinel entry which sorts before any other entry */
export const FIRST_ENTRY = new JetIndexEntry(null, FIRST_ROW_ID);
/** sentinel entry which sorts after any other entry */
export const LAST_ENTRY = new JetIndexEntry(null, LAST_ROW_ID);
