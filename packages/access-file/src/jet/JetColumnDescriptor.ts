/**
 * Column descriptors that encode a column value into its index-entry
 * segment (port of IndexData.ColumnDescriptor and its subclasses from
 * JustyBase.UCanAccessCs / Jackcess).
 */

import type { AccessValue } from '../types';
import { flipBytes, getNullEntryFlag, getStartEntryFlag, ASC_BOOLEAN_TRUE, ASC_BOOLEAN_FALSE, DESC_BOOLEAN_TRUE, DESC_BOOLEAN_FALSE } from './JetIndexCodes';
import type { JetColumn } from './JetTable';
import { ByteStream, indexCodesFor, JetTextSortOrder } from './JetTextSortOrder';

const ASCENDING_COLUMN_FLAG = 0x01;

export class JetColumnDescriptor {
    protected readonly column: JetColumn;
    protected readonly flags: number;

    public constructor(column: JetColumn, flags: number) {
        this.column = column;
        this.flags = flags;
    }

    public get isAscending(): boolean {
        return (this.flags & ASCENDING_COLUMN_FLAG) !== 0;
    }

    public get columnNumber(): number {
        return this.column.columnNumber;
    }

    /** encodes the given value as one index column segment */
    public writeValue(value: AccessValue | null, bout: ByteStream): void {
        if (this.isNullValue(value)) {
            bout.writeByte(getNullEntryFlag(this.isAscending));
            return;
        }
        bout.writeByte(getStartEntryFlag(this.isAscending));
        this.writeNonNullValue(value, bout);
    }

    public isNullValue(value: AccessValue | null): boolean {
        return value === null;
    }

    protected writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        void value;
        void bout;
        throw new Error('not implemented');
    }

    protected encodeNumber(value: AccessValue): Uint8Array {
        const output = new Uint8Array(this.fixedByteSize());
        switch (this.column.type) {
            case 0x02: output[0] = this.numberValue(value); break;
            case 0x03: {
                const num = this.numberValue(value);
                output[0] = (num >> 8) & 0xff;
                output[1] = num & 0xff;
                break;
            }
            case 0x04: {
                const num = this.numberValue(value);
                output[0] = (num >> 24) & 0xff;
                output[1] = (num >> 16) & 0xff;
                output[2] = (num >> 8) & 0xff;
                output[3] = num & 0xff;
                break;
            }
            case 0x05: {
                const num = this.numberValue(value);
                output[0] = (num >> 56) & 0xff;
                output[1] = (num >> 48) & 0xff;
                output[2] = (num >> 40) & 0xff;
                output[3] = (num >> 32) & 0xff;
                output[4] = (num >> 24) & 0xff;
                output[5] = (num >> 16) & 0xff;
                output[6] = (num >> 8) & 0xff;
                output[7] = num & 0xff;
                break;
            }
            case 0x06: {
                const data = Buffer.alloc(4);
                data.writeFloatBE(this.numberValue(value), 0);
                output.set(data);
                break;
            }
            case 0x07:
            case 0x08: {
                const data = Buffer.alloc(8);
                data.writeDoubleBE(this.numberValue(value), 0);
                output.set(data);
                break;
            }
            case 0x0f: {
                const data = Buffer.from(this.encodeGuidBytes(value));
                output.set(data);
                break;
            }
            case 0x13: {
                let integer = this.bigIntValue(value);
                if (integer < 0n) {
                    integer += 1n << 64n;
                }
                for (let index = output.length - 1; index >= 0; index--) {
                    output[index] = Number(integer & 0xffn);
                    integer >>= 8n;
                }
                break;
            }
            default:
                break;
        }
        return output;
    }

    private fixedByteSize(): number {
        switch (this.column.type) {
            case 0x02: return 1;
            case 0x03: return 2;
            case 0x04: return 4;
            case 0x05:
            case 0x07:
            case 0x08:
            case 0x13: return 8;
            case 0x06: return 4;
            case 0x0f: return 16;
            default: return this.column.size;
        }
    }

    private numberValue(value: AccessValue): number {
        if (typeof value === 'bigint') return Number(value);
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        return Number(value ?? 0);
    }

    private bigIntValue(value: AccessValue): bigint {
        if (typeof value === 'bigint') {
            return value;
        }
        if (typeof value === 'number') {
            if (!Number.isSafeInteger(value)) {
                throw new Error(`Value '${value}' is not a safe BIGINT.`);
            }
            return BigInt(value);
        }
        if (typeof value === 'string') {
            return BigInt(value.trim());
        }
        return BigInt(this.numberValue(value));
    }

    private encodeGuidBytes(value: AccessValue): Uint8Array {
        const text = String(value ?? '').trim().replace(/[{}]/g, '');
        const groups = text.split('-');
        const output = new Uint8Array(16);
        if (groups.length !== 5) {
            return output;
        }
        const writeGroup = (offset: number, group: string, reverse: boolean): void => {
            const bytes = Buffer.from(group, 'hex');
            for (let index = 0; index < bytes.length; index++) {
                output[offset + (reverse ? bytes.length - 1 - index : index)] = bytes[index] ?? 0;
            }
        };
        writeGroup(0, groups[0] ?? '', true);
        writeGroup(4, groups[1] ?? '', true);
        writeGroup(6, groups[2] ?? '', true);
        writeGroup(8, groups[3] ?? '', false);
        writeGroup(10, groups[4] ?? '', false);
        return output;
    }
}

/** integer based columns */
export class JetIntegerColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const valueBytes = this.encodeNumber(value);
        valueBytes[0] = valueBytes[0]! ^ 0x80;
        if (!this.isAscending) {
            flipBytes(valueBytes, 0, valueBytes.length);
        }
        bout.writeBytes(valueBytes);
    }
}

/** floating point based columns */
export class JetFloatingPointColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const valueBytes = this.encodeNumber(value);
        const isNegative = (valueBytes[0]! & 0x80) !== 0;
        if (!isNegative) {
            valueBytes[0] = valueBytes[0]! ^ 0x80;
        }
        if (isNegative === this.isAscending) {
            flipBytes(valueBytes, 0, valueBytes.length);
        }
        bout.writeBytes(valueBytes);
    }
}

/** fixed point based columns (legacy sort order) */
export class JetLegacyFixedPointColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const valueBytes = this.encodeNumericValue(value);
        const isNegative = (valueBytes[0]! & 0x80) !== 0;
        this.handleNegationAndOrder(isNegative, valueBytes);
        bout.writeBytes(valueBytes);
    }

    protected handleNegationAndOrder(isNegative: boolean, valueBytes: Uint8Array): void {
        if (isNegative === this.isAscending) {
            flipBytes(valueBytes, 0, valueBytes.length);
        }
        valueBytes[0] = isNegative ? 0x00 : 0xff;
    }

    private encodeNumericValue(value: AccessValue): Uint8Array {
        // NUMERIC index entries use the big-endian 17-byte layout:
        // byte 0 = sign, bytes 1..16 = unscaled magnitude (big-endian).
        const text = typeof value === 'bigint'
            ? value.toString()
            : typeof value === 'number'
                ? String(value)
                : String(value ?? '0').trim();
        const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
        if (!match) {
            throw new Error(`Value '${text}' is not a supported decimal.`);
        }
        const scale = this.column.scale ?? 0;
        const fraction = (match[3] ?? '').padEnd(scale, '0').slice(0, scale);
        let magnitude = BigInt(`${match[2] ?? '0'}${fraction}` || '0');
        const discarded = (match[3] ?? '').slice(scale);
        if (discarded.length > 0 && Number(discarded[0] ?? 0) >= 5) {
            magnitude += 1n;
        }
        const negative = match[1] === '-';
        const output = new Uint8Array(17);
        output[0] = negative && magnitude !== 0n ? 0x80 : 0;
        let remainder = magnitude;
        for (let index = 16; index >= 1; index--) {
            output[index] = Number(remainder & 0xffn);
            remainder >>= 8n;
        }
        return output;
    }
}

/** new-style fixed point based columns */
export class JetFixedPointColumnDescriptor extends JetLegacyFixedPointColumnDescriptor {
    protected override handleNegationAndOrder(isNegative: boolean, valueBytes: Uint8Array): void {
        valueBytes[0] = 0xff;
        if (isNegative === this.isAscending) {
            flipBytes(valueBytes, 0, valueBytes.length);
        }
    }
}

/** byte based columns */
export class JetByteColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const valueBytes = this.encodeNumber(value);
        if (!this.isAscending) {
            flipBytes(valueBytes, 0, valueBytes.length);
        }
        bout.writeBytes(valueBytes);
    }
}

/** boolean columns */
export class JetBooleanColumnDescriptor extends JetColumnDescriptor {
    public override isNullValue(): boolean {
        return false;
    }

    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const booleanValue = value !== false && value !== 0 && value !== null && value !== undefined && String(value).toLowerCase() !== 'false';
        bout.writeByte(booleanValue
            ? this.isAscending ? ASC_BOOLEAN_TRUE : DESC_BOOLEAN_TRUE
            : this.isAscending ? ASC_BOOLEAN_FALSE : DESC_BOOLEAN_FALSE);
    }
}

/** text columns using a specific sort order */
export class JetTextColumnDescriptor extends JetColumnDescriptor {
    private readonly _sortOrder: JetTextSortOrder | null;

    public constructor(column: JetColumn, flags: number, sortOrder: JetTextSortOrder | null) {
        super(column, flags);
        this._sortOrder = sortOrder;
    }

    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const codes = indexCodesFor(this._sortOrder);
        codes.writeNonNullIndexTextValue(value, bout, this.isAscending);
    }
}

/** GUID columns */
export class JetGuidColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        writeGeneralBinaryEntry(this.encodeNumber(value), this.isAscending, bout);
    }
}

/** BINARY columns */
export class JetBinaryColumnDescriptor extends JetColumnDescriptor {
    protected override writeNonNullValue(value: AccessValue, bout: ByteStream): void {
        const bytes = value instanceof Uint8Array
            ? Uint8Array.from(value)
            : new Uint8Array(Buffer.from(String(value ?? ''), 'binary'));
        writeGeneralBinaryEntry(bytes, this.isAscending, bout);
    }
}

/**
 * Writes a binary value using the general binary entry encoding rules
 * (port of IndexData.WriteGeneralBinaryEntry).
 */
function writeGeneralBinaryEntry(valueBytes: Uint8Array, isAscending: boolean, bout: ByteStream): void {
    const dataLen = valueBytes.length;
    const partialEntryBytes = new Uint8Array(9);

    let segmentLen = dataLen;
    let pos = 0;
    while (segmentLen > 8) {
        partialEntryBytes.set(valueBytes.subarray(pos, pos + 8), 0);
        if (!isAscending) {
            flipBytes(partialEntryBytes, 0, 8);
        }
        partialEntryBytes[8] = 9;
        pos += 8;
        segmentLen -= 8;
        bout.writeBytes(partialEntryBytes);
    }

    if (segmentLen > 0) {
        partialEntryBytes.fill(0);
        partialEntryBytes.set(valueBytes.subarray(pos, pos + segmentLen), 0);
        partialEntryBytes[8] = segmentLen;
        if (!isAscending) {
            flipBytes(partialEntryBytes, 0, 9);
        }
        bout.writeBytes(partialEntryBytes);
    }
}
