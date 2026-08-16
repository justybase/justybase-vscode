/**
 * Writable table model for the direct-mutation writer
 * (port of Table/TableMutator from JustyBase.UCanAccessCs).
 *
 * A JetTable parses the table definition page of an existing table and
 * exposes row-level add/update/delete with:
 *   - in-place updates when the new row fits the existing slot
 *   - in-page relocation (full page rewrite) when it does not
 *   - long-value pages (MEMO/OLE) with preservation of unchanged values
 *   - usage-map maintenance (owned pages + free-space pages)
 *
 * Index pages are updated alongside row mutations when a table has indexes.
 */

import { AccessFileError } from '../accessFileSession';
import type { AccessValue } from '../types';
import { DELETED_ROW_MASK, JET_PAGE_TYPES, OFFSET_MASK, OVERFLOW_ROW_MASK } from './JetLayout';
import type { JetLayout } from './JetLayout';
import {
    writeLongValue,
    readLongValueBytes,
    longValuePageNumbers,
    longValueType,
} from './JetLvalWriter';
import { LONG_VALUE_TYPES } from './JetLayout';
import type { JetPageChannel } from './JetPageChannel';
import { JetUsageMap } from './JetUsageMap';
import { JetIndexData } from './JetIndexData';
import type { JetPendingChange } from './JetIndexData';
import { JetRowId } from './JetIndexEntry';
import { JetTextSortOrder } from './JetTextSortOrder';

export interface JetColumn {
    readonly name: string;
    readonly type: number;
    readonly columnNumber: number;
    readonly variable: boolean;
    readonly variableIndex: number;
    readonly fixedOffset: number;
    readonly size: number;
    readonly precision: number;
    readonly scale: number;
    readonly autoLong: boolean;
    readonly autoUuid: boolean;
    /** raw sort-order value from the column definition (text columns only) */
    readonly sortOrder?: number;
    /** sort-order version byte (Jet4 stores 4 bytes: value + version at +2/+3) */
    readonly sortOrderVersion?: number;
}

export interface JetRowLocation {
    readonly pageNumber: number;
    readonly rowNumber: number;
    readonly start: number;
    readonly end: number;
    /** Physical row data when pageNumber/rowNumber is an overflow header. */
    readonly dataPageNumber?: number;
    readonly dataRowNumber?: number;
}

const TYPE_MEMO = 0x0c;
const TYPE_OLE = 0x0b;
const TYPE_TEXT = 0x0a;
const TYPE_BOOLEAN = 0x01;

function isLongValueType(type: number): boolean {
    return type === TYPE_MEMO || type === TYPE_OLE;
}

function readName(buffer: Buffer, position: { value: number }, layout: JetLayout): string {
    const length = readUInt(buffer, position.value, layout.sizeNameLength);
    position.value += layout.sizeNameLength;
    const byteLength = Math.min(length, buffer.length - position.value);
    const name = layout.utf16
        ? buffer.toString('utf16le', position.value, position.value + byteLength)
        : buffer.toString('latin1', position.value, position.value + byteLength);
    position.value += byteLength;
    return name.replace(/\0+$/, '');
}

function readUInt(buffer: Buffer, offset: number, size: number): number {
    return size === 1 ? buffer.readUInt8(offset) : size === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
}

export class JetTable {
    public readonly name: string;
    public readonly definitionPage: number;
    public readonly columns: readonly JetColumn[];
    public readonly maxColumns: number;
    public readonly variableColumnCount: number;
    public readonly indexCount: number;
    public readonly ownedPages: JetUsageMap;
    public readonly freeSpacePages: JetUsageMap;
    public readonly longValuePages = new Set<number>();
    public readonly indexDatas: readonly JetIndexData[];

    private _rowCount: number;
    private _nextAutoNumber: number;
    private _logicalIndexBlockStart = -1;
    private readonly _definition: Buffer;

    public constructor(
        private readonly _channel: JetPageChannel,
        name: string,
        definitionPage: number,
    ) {
        this.name = name;
        this.definitionPage = definitionPage;
        const layout = this.layout;
        this._definition = this.readDefinition();
        this._rowCount = this._definition.readUInt32LE(layout.offsetNumRows);
        this._nextAutoNumber = this._definition.readUInt32LE(layout.offsetNextAutoNumber);
        this.maxColumns = this._definition.readUInt16LE(layout.offsetMaxCols);
        this.variableColumnCount = this._definition.readUInt16LE(layout.offsetNumVarCols);
        const columnCount = this._definition.readUInt16LE(layout.offsetNumCols);
        this.indexCount = this._definition.readUInt32LE(layout.offsetNumIndexes);
        this.ownedPages = JetUsageMap.read(
            this._channel,
            this._definition,
            layout.offsetOwnedPages,
        );
        this.freeSpacePages = JetUsageMap.read(
            this._channel,
            this._definition,
            layout.offsetFreeSpacePages,
        );
        this.columns = this.parseColumns(columnCount);
        this.indexDatas = this.readIndexDefinitions();
    }

    public get layout(): JetLayout {
        return this._channel.layout;
    }

    public get channel(): JetPageChannel {
        return this._channel;
    }

    public get tableDefinition(): Buffer {
        return this._definition;
    }

    /**
     * Resolves the collating sort order for a text column from the column
     * definition (port of Column.ReadTextSortOrder).
     */
    public columnSortOrder(column: JetColumn): JetTextSortOrder | null {
        const layout = this.layout;
        if (column.type !== 0x0a && column.type !== 0x0c) {
            return null;
        }
        const value = column.sortOrder ?? 0;
        if (value === 0) {
            return layout.utf16 ? JetTextSortOrder.GeneralLegacy : JetTextSortOrder.General97;
        }
        const version = layout.sizeSortOrder === 4
            ? (column.sortOrderVersion ?? 0)
            : layout.utf16 ? 0 : -1;
        if (value === JetTextSortOrder.General.value) {
            if (version === JetTextSortOrder.General.version) return JetTextSortOrder.General;
            if (version === JetTextSortOrder.GeneralLegacy.version) return JetTextSortOrder.GeneralLegacy;
            if (version === JetTextSortOrder.General97.version) return JetTextSortOrder.General97;
        }
        return new JetTextSortOrder(value, version);
    }

    private readIndexDefinitions(): JetIndexData[] {
        const layout = this.layout;
        const indexDatas: JetIndexData[] = [];
        if (this.indexCount === 0) {
            return indexDatas;
        }
        // index data blocks come after the column names
        const columnsOffset = layout.offsetIndexDefBlock + this.indexCount * layout.sizeIndexDefinition;
        const namesPosition = { value: columnsOffset + this.columns.length * layout.sizeColumnHeader };
        for (let index = 0; index < this.columns.length; index++) {
            const nameLength = readUInt(this._definition, namesPosition.value, layout.sizeNameLength);
            namesPosition.value += layout.sizeNameLength + nameLength;
        }
        const indexBlockStart = namesPosition.value;
        const position = { value: indexBlockStart };
        for (let index = 0; index < this.indexCount; index++) {
            indexDatas.push(JetIndexData.read(this, this._definition, index, layout, position));
        }
        this._logicalIndexBlockStart = position.value;
        // read logical index info (primary key / foreign key flags) and mark
        // the backing index data
        const indexDataNumbers: number[] = [];
        const logicalPosition = { value: this._logicalIndexBlockStart };
        for (let index = 0; index < this.indexCount; index++) {
            logicalPosition.value += layout.skipBeforeIndexSlot;
            logicalPosition.value += 4; // index number
            const dataNumber = this._definition.readUInt32LE(logicalPosition.value);
            logicalPosition.value += 4;
            indexDataNumbers.push(dataNumber);
            logicalPosition.value += 1 + 4 + 4 + 1 + 1; // related info + cascades
            const indexType = this._definition[logicalPosition.value] ?? 0;
            logicalPosition.value += 1;
            logicalPosition.value += layout.skipAfterIndexSlot;
            if (indexType === 1 && dataNumber < indexDatas.length) {
                indexDatas[dataNumber]!.setBackingPrimaryKey(true);
            }
        }
        return indexDatas;
    }

    /**
     * Reads the logical index names (one per logical index slot, in slot
     * order) from the table definition.
     */
    public indexNames(): string[] {
        const layout = this.layout;
        if (this.indexCount === 0 || this._logicalIndexBlockStart < 0) {
            return [];
        }
        const position = { value: this._logicalIndexBlockStart };
        for (let index = 0; index < this.indexCount; index++) {
            position.value += layout.skipBeforeIndexSlot;
            // logical index block: number(4) + data number(4) + related info
            position.value += 4 + 4 + 1 + 4 + 4 + 1 + 1 + 1;
            position.value += layout.skipAfterIndexSlot;
        }
        const names: string[] = [];
        for (let index = 0; index < this.indexCount; index++) {
            names.push(readName(this._definition, position, layout));
        }
        return names;
    }

    /**
     * Reads the logical index types (1 = primary key, 2 = foreign key,
     * 0 = plain) in slot order from the table definition.
     */
    public indexTypes(): number[] {
        const layout = this.layout;
        if (this.indexCount === 0 || this._logicalIndexBlockStart < 0) {
            return [];
        }
        const types: number[] = [];
        const position = { value: this._logicalIndexBlockStart };
        for (let index = 0; index < this.indexCount; index++) {
            position.value += layout.skipBeforeIndexSlot;
            position.value += 4; // index number
            position.value += 4; // index data number
            position.value += 1; // related table type
            position.value += 4; // related index number
            position.value += 4; // related table page number
            position.value += 1; // cascade updates
            position.value += 1; // cascade deletes
            types.push(this._definition[position.value] ?? 0); // index type
            position.value += 1;
            position.value += layout.skipAfterIndexSlot;
        }
        return types;
    }

    private readDefinition(): Buffer {
        const first = this._channel.pageAt(this.definitionPage);
        const chunks = [first];
        let nextPage = first.readUInt32LE(4);
        while (nextPage !== 0) {
            const page = this._channel.pageAt(nextPage);
            chunks.push(page.subarray(8));
            nextPage = page.readUInt32LE(4);
        }
        return Buffer.concat(chunks);
    }

    private parseColumns(columnCount: number): JetColumn[] {
        const layout = this.layout;
        const columnsOffset = layout.offsetIndexDefBlock + this.indexCount * layout.sizeIndexDefinition;
        const namesPosition = { value: columnsOffset + columnCount * layout.sizeColumnHeader };
        const columns: JetColumn[] = [];
        for (let index = 0; index < columnCount; index++) {
            const offset = columnsOffset + index * layout.sizeColumnHeader;
            const flagsOffset = layout.utf16 ? 15 : 13;
            const variableIndexOffset = layout.utf16 ? 7 : 3;
            const fixedOffsetOffset = layout.utf16 ? 21 : 14;
            const lengthOffset = layout.utf16 ? 23 : 16;
            const column: JetColumn = {
                name: readName(this._definition, namesPosition, layout),
                type: this._definition[offset] ?? 0,
                columnNumber: readUInt(this._definition, offset + (layout.utf16 ? 5 : 1), 2),
                variable: (((this._definition[offset + flagsOffset] ?? 0) & 0x01) === 0),
                variableIndex: readUInt(this._definition, offset + variableIndexOffset, 2),
                fixedOffset: readUInt(this._definition, offset + fixedOffsetOffset, 2),
                size: readUInt(this._definition, offset + lengthOffset, 2),
                precision: this._definition[offset + 11] ?? 0,
                scale: this._definition[offset + 12] ?? 0,
                autoLong: (this._definition[offset + flagsOffset] ?? 0) === 0x07,
                autoUuid: (this._definition[offset + flagsOffset] ?? 0) === 0x05,
                ...(layout.offsetColumnSortOrder >= 0
                    ? { sortOrder: readUInt(this._definition, offset + layout.offsetColumnSortOrder, 2) }
                    : {}),
                ...(layout.sizeSortOrder === 4 && layout.offsetColumnSortOrder >= 0
                    ? { sortOrderVersion: this._definition[offset + layout.offsetColumnSortOrder + 3] ?? 0 }
                    : {}),
            };
            columns.push(column);
        }
        columns.sort((left, right) => left.columnNumber - right.columnNumber);
        return columns;
    }

    public get rowCount(): number {
        return this._rowCount;
    }

    public get nextAutoNumber(): number {
        return this._nextAutoNumber;
    }

    /** Enumerates all non-deleted rows, following overflow pointers. */
    public rowLocations(): JetRowLocation[] {
        const candidates: { readonly location: JetRowLocation; readonly overflow: boolean }[] = [];
        const overflowTargets = new Set<string>();
        const layout = this.layout;
        const owned = Array.from(this.ownedPages.cursor()).sort((a, b) => a - b);
        for (const pageNumber of owned) {
            const page = this._channel.pageAt(pageNumber);
            if (page[0] !== JET_PAGE_TYPES.DATA) {
                continue;
            }
            if (page.readUInt32LE(4) === 0x4c41564c /* 'LVAL' in little-endian */) {
                continue;
            }
            const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
            for (let rowNumber = 0; rowNumber < rowCount; rowNumber++) {
                const location = this.rowLocationAt(pageNumber, rowNumber, page);
                if (location) {
                    const isOverflow = (page.readUInt16LE(
                        layout.offsetRowStart + layout.sizeRowLocation * rowNumber,
                    ) & OVERFLOW_ROW_MASK) !== 0;
                    if (isOverflow) {
                        const dataPageNumber = location.dataPageNumber ?? location.pageNumber;
                        const dataRowNumber = location.dataRowNumber ?? location.rowNumber;
                        overflowTargets.add(`${dataPageNumber}:${dataRowNumber}`);
                    }
                    candidates.push({ location, overflow: isOverflow });
                }
            }
        }
        return candidates
            .filter(candidate => !overflowTargets.has(
                `${candidate.location.pageNumber}:${candidate.location.rowNumber}`,
            ))
            .map(candidate => candidate.location);
    }

    /** Reads a row location and follows overflow pointers to its data. */
    public positionAtRowData(pageNumber: number, rowNumber: number): JetRowLocation | undefined {
        const layout = this.layout;
        const headerPageNumber = pageNumber;
        const headerRowNumber = rowNumber;
        let currentPageNumber = pageNumber;
        let currentRowNumber = rowNumber;
        let page = this._channel.pageAt(currentPageNumber);
        const visited = new Set<string>();
        while (true) {
            const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
            if (currentRowNumber < 0 || currentRowNumber >= rowCount) {
                throw new AccessFileError(
                    `Access row (${currentPageNumber}, ${currentRowNumber}) is outside the data page.`,
                );
            }
            const rowOffset = layout.offsetRowStart + layout.sizeRowLocation * currentRowNumber;
            const start = page.readUInt16LE(rowOffset) & OFFSET_MASK;
            const end = currentRowNumber === 0
                ? layout.pageSize
                : page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * (currentRowNumber - 1)) & OFFSET_MASK;
            const rawStart = page.readUInt16LE(rowOffset);
            if ((rawStart & DELETED_ROW_MASK) !== 0) {
                return undefined;
            }
            if (start < layout.offsetRowStart + rowCount * layout.sizeRowLocation
                || end < start
                || end > layout.pageSize) {
                throw new AccessFileError(
                    `Invalid row location at page ${currentPageNumber}, row ${currentRowNumber}.`,
                );
            }
            if ((rawStart & OVERFLOW_ROW_MASK) === 0) {
                return {
                    pageNumber: headerPageNumber,
                    rowNumber: headerRowNumber,
                    start,
                    end,
                    dataPageNumber: currentPageNumber,
                    dataRowNumber: currentRowNumber,
                };
            }
            const key = `${currentPageNumber}:${currentRowNumber}`;
            if (visited.has(key)) {
                throw new AccessFileError(`Cyclic overflow pointer detected at page ${currentPageNumber}, row ${currentRowNumber}.`);
            }
            visited.add(key);
            if (end - start < 4) {
                throw new AccessFileError('Invalid overflow row info.');
            }
            const overflowRowNumber = page[start] ?? 0;
            const overflowPageNumber = (page[start + 1] ?? 0) | ((page[start + 2] ?? 0) << 8) | ((page[start + 3] ?? 0) << 16);
            if (overflowPageNumber === currentPageNumber && overflowRowNumber === currentRowNumber) {
                throw new AccessFileError('Overflow row points to itself.');
            }
            currentPageNumber = overflowPageNumber;
            currentRowNumber = overflowRowNumber;
            page = this._channel.pageAt(currentPageNumber);
        }
    }

    /**
     * Returns the location of a specific row slot on a page, following an
     * overflow pointer when present.
     */
    public rowLocationAt(pageNumber: number, rowNumber: number, page: Buffer): JetRowLocation | undefined {
        const layout = this.layout;
        const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
        if (rowNumber < 0 || rowNumber >= rowCount) {
            return undefined;
        }
        const rawStart = page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * rowNumber);
        if ((rawStart & DELETED_ROW_MASK) !== 0) {
            return undefined;
        }
        if ((rawStart & OVERFLOW_ROW_MASK) !== 0) {
            return this.positionAtRowData(pageNumber, rowNumber);
        }
        const start = rawStart & OFFSET_MASK;
        const end = rowNumber === 0
            ? layout.pageSize
            : page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * (rowNumber - 1)) & OFFSET_MASK;
        if (start < layout.offsetRowStart + rowCount * layout.sizeRowLocation || end < start || end > layout.pageSize) {
            return undefined;
        }
        return {
            pageNumber,
            rowNumber,
            start,
            end,
            dataPageNumber: pageNumber,
            dataRowNumber: rowNumber,
        };
    }

    public readRowValues(location: JetRowLocation): AccessValue[] {
        const page = this._channel.pageAt(location.dataPageNumber ?? location.pageNumber);
        return this.columns.map(column => this.readColumnValue(page, location, column));
    }

    private readColumnValue(page: Buffer, location: JetRowLocation, column: JetColumn): AccessValue {
        const layout = this.layout;
        const { mask } = this.nullMask(page, location);
        if (!this.isNotNull(mask, column.columnNumber)) {
            return column.type === TYPE_BOOLEAN ? false : null;
        }
        if (column.type === TYPE_BOOLEAN) {
            return true;
        }
        if (!column.variable) {
            const start = location.start + layout.sizeRowColumnCount + column.fixedOffset;
            const end = start + this.fixedSize(column);
            return this.decodeFixed(page.subarray(start, end), column);
        }
        const offsets = this.variableOffsets(page, location);
        const start = location.start + (offsets[column.variableIndex] ?? 0);
        const end = location.start + (offsets[column.variableIndex + 1] ?? offsets[column.variableIndex] ?? 0);
        const data = page.subarray(start, end);
        if (isLongValueType(column.type) && data.length >= 4) {
            return this.decodeLongValue(data as Buffer, column.type === TYPE_MEMO);
        }
        return this.decodeVariable(data, column);
    }

    private decodeLongValue(def: Buffer, isMemo: boolean): AccessValue {
        const layout = this.layout;
        const type = longValueType(def);
        const length = def.readUInt32LE(0) & 0x3fffffff;
        if (type === LONG_VALUE_TYPES.THIS_PAGE) {
            const bytes = def.subarray(layout.sizeLongValueDef, layout.sizeLongValueDef + length);
            return isMemo ? this.decodeText(Buffer.from(bytes)) : Uint8Array.from(bytes);
        }
        const bytes = readLongValueBytes(def, this._channel);
        return isMemo ? this.decodeText(Buffer.from(bytes)) : bytes;
    }

    private decodeVariable(data: Buffer, column: JetColumn): AccessValue {
        if (column.type === TYPE_TEXT || column.type === TYPE_MEMO) {
            return this.decodeText(data);
        }
        return Uint8Array.from(data);
    }

    private decodeText(data: Buffer): string {
        const layout = this.layout;
        if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
            return Buffer.from(data.subarray(2).map(byte => byte === 0 ? 0 : byte)).toString('latin1').replace(/\0+$/, '');
        }
        return (layout.utf16 ? data.toString('utf16le') : data.toString('latin1')).replace(/\0+$/, '');
    }

    private fixedSize(column: JetColumn): number {
        switch (column.type) {
            case 0x01: return 0;
            case 0x02: return 1;
            case 0x03: return 2;
            case 0x04: return 4;
            case 0x05:
            case 0x07:
            case 0x08: return 8;
            case 0x06: return 4;
            case 0x0f: return 16;
            case 0x10: return 17;
            case 0x12: return 4;
            case 0x13: return 8;
            default: return column.size;
        }
    }

    private decodeFixed(data: Buffer, column: JetColumn): AccessValue {
        switch (column.type) {
            case 0x02: return data[0] ?? 0;
            case 0x03: return data.readInt16LE(0);
            case 0x04: return data.readInt32LE(0);
            case 0x05: return data.readBigInt64LE(0) / 10000n;
            case 0x06: return data.readFloatLE(0);
            case 0x07: return data.readDoubleLE(0);
            case 0x08: return new Date((data.readDoubleLE(0) * 86400000) + Date.UTC(1899, 11, 30));
            case 0x0a:
            case 0x0c: return this.decodeText(data);
            case 0x12: return data.readInt32LE(0);
            case 0x09:
            case 0x0b: return Uint8Array.from(data);
            case 0x13: return data.readBigInt64LE(0);
            default: return Uint8Array.from(data);
        }
    }

    private nullMask(page: Buffer, location: JetRowLocation): { mask: Buffer } {
        const layout = this.layout;
        const columnCount = readUInt(page, location.start, layout.sizeRowColumnCount);
        const maskLength = Math.ceil(columnCount / 8);
        return { mask: page.subarray(location.end - maskLength, location.end) };
    }

    private isNotNull(mask: Buffer, index: number): boolean {
        return (((mask[Math.floor(index / 8)] ?? 0) & (1 << (index % 8))) !== 0);
    }

    private variableOffsets(page: Buffer, location: JetRowLocation): number[] {
        const layout = this.layout;
        const { mask } = this.nullMask(page, location);
        if (layout.sizeRowVarColOffset === 1) {
            // Jet 3 stores one-byte offsets and a compact jump table instead
            // of Jet 4's little-endian ushort trailer.  A jump byte contains
            // the first offset index at or beyond the next 256-byte boundary.
            const rowEndExclusive = location.end;
            const rowEndInclusive = rowEndExclusive - 1;
            const numVarOffset = rowEndInclusive - mask.length;
            if (numVarOffset < location.start || numVarOffset >= rowEndExclusive) {
                throw new AccessFileError(`Invalid Jet 3 variable-column trailer for '${this.name}'.`);
            }
            const numVarColumns = page[numVarOffset] ?? 0;
            if (numVarColumns > this.variableColumnCount) {
                throw new AccessFileError(
                    `Jet 3 row declares ${numVarColumns} variable columns, table '${this.name}' has ${this.variableColumnCount}.`,
                );
            }
            const rowLength = rowEndExclusive - location.start;
            let jumpCount = Math.floor((rowLength - 1) / 0x100);
            const columnOffset = rowEndInclusive - mask.length - jumpCount - 1;
            if (columnOffset - numVarColumns < location.start) {
                throw new AccessFileError(`Invalid Jet 3 variable-column offset table for '${this.name}'.`);
            }
            // Very short rows may have a trailing dummy jump byte.  This is
            // the same boundary rule used by Jackcess and the C# port.
            if (Math.floor((columnOffset - location.start - numVarColumns) / 0x100) < jumpCount) {
                jumpCount--;
            }
            const offsets: number[] = [];
            let jumpsUsed = 0;
            for (let index = 0; index <= numVarColumns; index++) {
                while (jumpsUsed < jumpCount) {
                    const jumpPosition = rowEndInclusive - mask.length - jumpsUsed - 1;
                    if (jumpPosition < location.start || index !== (page[jumpPosition] ?? 0)) {
                        break;
                    }
                    jumpsUsed++;
                }
                const offsetPosition = columnOffset - index;
                if (offsetPosition < location.start || offsetPosition >= rowEndExclusive) {
                    throw new AccessFileError(`Invalid Jet 3 variable-column offset for '${this.name}'.`);
                }
                offsets.push((page[offsetPosition] ?? 0) + jumpsUsed * 0x100);
            }
            return offsets;
        }
        const countOffset = location.end - mask.length - 2;
        const count = page.readUInt16LE(countOffset);
        return Array.from({ length: count + 1 }, (_, index) =>
            page.readUInt16LE(countOffset - 2 - index * 2));
    }

    // ------------------------------------------------------------------
    // Writing
    // ------------------------------------------------------------------

    /**
     * Adds a row at the end of the table (append).  Allocates a new data
     * page when no owned page has free space.
     */
    public addRow(values: readonly AccessValue[]): JetRowLocation {
        const layout = this.layout;
        const row = this.createRow(values, 0);
        if (row.length > layout.maxRowSize) {
            throw new AccessFileError(`Row size ${row.length} is too large for the Access format.`);
        }
        const pageNumber = this.findFreeRowSpace(row.length);
        const page = this._channel.pageAt(pageNumber);
        const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
        const end = rowCount === 0
            ? layout.pageSize
            : page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * (rowCount - 1)) & OFFSET_MASK;
        const start = end - row.length;
        page.fill(0, start, end);
        row.copy(page, start);
        page.writeUInt16LE(start, layout.offsetRowStart + layout.sizeRowLocation * rowCount);
        page.writeUInt16LE(rowCount + 1, layout.offsetNumRowsOnDataPage);
        page.writeUInt16LE(page.readUInt16LE(layout.offsetFreeSpace) - row.length - layout.sizeRowLocation, layout.offsetFreeSpace);
        this._rowCount++;
        this.handleAutoNumbers(values);
        return { pageNumber, rowNumber: rowCount, start, end };
    }

    /**
     * Updates a row in place.  When the new row does not fit the existing
     * slot, the whole data page is rewritten (in-page relocation), which
     * preserves physical row order and avoids overflow pointers.
     */
    public updateRow(location: JetRowLocation, oldValues: readonly AccessValue[], newValues: readonly AccessValue[]): void {
        const layout = this.layout;
        const positioned = this.positionAtRowData(location.pageNumber, location.rowNumber);
        if (!positioned) {
            throw new AccessFileError(`Row (${location.pageNumber}, ${location.rowNumber}) is invalid or deleted.`);
        }
        const dataLocation = this.asDataLocation(positioned);
        const preservedLongValues = new Map<number, Buffer>();
        const obsoleteLongValues: Buffer[] = [];
        const oldPage = this._channel.pageAt(dataLocation.pageNumber);
        const { mask } = this.nullMask(oldPage, dataLocation);
        const offsets = this.variableOffsets(oldPage, dataLocation);
        for (const column of this.columns) {
            if (!isLongValueType(column.type)) {
                continue;
            }
            if (!this.isNotNull(mask, column.columnNumber)) {
                continue;
            }
            const start = dataLocation.start + (offsets[column.variableIndex] ?? 0);
            const end = dataLocation.start + (offsets[column.variableIndex + 1] ?? offsets[column.variableIndex] ?? 0);
            const data = oldPage.subarray(start, end);
            const unchanged = newValues[column.columnNumber] !== null
                && this.valuesEqual(oldValues[column.columnNumber] ?? null, newValues[column.columnNumber] ?? null);
            if (unchanged && data.length >= 4) {
                preservedLongValues.set(column.columnNumber, Buffer.from(data as Buffer));
            } else if (data.length >= 4) {
                obsoleteLongValues.push(Buffer.from(data as Buffer));
            }
        }

        // Release the old chain before serializing the replacement.  The
        // staged file is discarded if serialization fails, and this lets the
        // allocator reuse the old pages immediately instead of growing the
        // database once for every replacement.
        this.releaseLongValueDefinitions(obsoleteLongValues, location);

        const slotSize = dataLocation.end - dataLocation.start;
        const paddedRow = this.createRow(newValues, slotSize, preservedLongValues);
        if (paddedRow.length <= slotSize) {
            paddedRow.copy(oldPage, dataLocation.start);
            this.handleAutoNumbers(newValues);
            return;
        }

        // in-page relocation: rewrite the whole data page keeping the same
        // row order so snapshot diffing stays stable.  The relocated row is
        // built unpadded (its trailer moves to the end of the new slot).
        // Reuse the already serialized row.  Re-serializing here would
        // allocate a second LVAL chain and leak the first one.
        const row = this.removeRowPadding(paddedRow);
        if (row.length > layout.maxRowSize) {
            throw new AccessFileError(`Row size ${row.length} is too large for the Access format.`);
        }
        this.rewriteDataPage(dataLocation, row);
        this.handleAutoNumbers(newValues);
    }

    /** Deletes a row (marks header deleted; follows overflow to the physical record). */
    public deleteRow(location: JetRowLocation): void {
        const layout = this.layout;
        const positioned = this.positionAtRowData(location.pageNumber, location.rowNumber);
        if (!positioned) {
            throw new AccessFileError(`Row (${location.pageNumber}, ${location.rowNumber}) is invalid or deleted.`);
        }
        const obsoleteLongValues = this.longValueDefinitionsAt(positioned);
        const dataPageNumber = positioned.dataPageNumber ?? positioned.pageNumber;
        const dataRowNumber = positioned.dataRowNumber ?? positioned.rowNumber;
        if (dataPageNumber !== location.pageNumber || dataRowNumber !== location.rowNumber) {
            const page = this._channel.pageAt(dataPageNumber);
            const offset = layout.offsetRowStart + layout.sizeRowLocation * dataRowNumber;
            page.writeUInt16LE(page.readUInt16LE(offset) | DELETED_ROW_MASK, offset);
        }
        const page = this._channel.pageAt(location.pageNumber);
        const offset = layout.offsetRowStart + layout.sizeRowLocation * location.rowNumber;
        // mdb-reader treats 0x4000 as deleted, while the C#/Jackcess readers
        // treat 0x8000 as deleted; set both status bits so neither reader
        // follows the tombstone as an overflow pointer.
        page.writeUInt16LE(page.readUInt16LE(offset) | DELETED_ROW_MASK | OVERFLOW_ROW_MASK, offset);
        this._rowCount--;
        this.releaseLongValueDefinitions(obsoleteLongValues);
    }

    // ------------------------------------------------------------------
    // Index-aware writes
    // ------------------------------------------------------------------

    /**
     * Adds a row and updates every index of the table (with uniqueness and
     * required checks).  The physical row is appended first; index changes
     * are committed after the row location is known.
     */
    public addRowWithIndexes(values: readonly AccessValue[]): JetRowLocation {
        const location = this.addRow(values);
        const rowId = new JetRowId(location.pageNumber, location.rowNumber);
        const changes = this.indexDatas.map(index => index.prepareAddRow(values, rowId));
        this.commitIndexChanges(changes);
        return location;
    }

    /**
     * Updates a row and refreshes every index entry for the row.  The old
     * entry is removed first, then the new entry is inserted (uniqueness
     * checked before the physical row is written).
     */
    public updateRowWithIndexes(location: JetRowLocation, oldValues: readonly AccessValue[], newValues: readonly AccessValue[]): void {
        const rowId = new JetRowId(location.pageNumber, location.rowNumber);
        // constraints first: removing the old entry and inserting the new one
        // may fail (unique/required); verify before touching the data page
        for (const index of this.indexDatas) {
            index.deleteRow(oldValues, rowId);
        }
        const changes = this.indexDatas.map(index => index.prepareAddRow(newValues, rowId));
        this.commitIndexChanges(changes);
        this.updateRow(location, oldValues, newValues);
    }

    /** Deletes a row and removes it from every index. */
    public deleteRowWithIndexes(location: JetRowLocation, values: readonly AccessValue[]): void {
        const rowId = new JetRowId(location.pageNumber, location.rowNumber);
        for (const index of this.indexDatas) {
            index.deleteRow(values, rowId);
        }
        this.deleteRow(location);
    }

    private commitIndexChanges(changes: readonly (JetPendingChange | null)[]): void {
        for (const change of changes) {
            change?.commit();
        }
    }

    /** Writes the row count and the AutoNumber counter back to the table definition. */
    public writeDefinitionCounters(): void {
        const layout = this.layout;
        const page = this._channel.pageAt(this.definitionPage);
        page.writeUInt32LE(this._rowCount, layout.offsetNumRows);
        page.writeUInt32LE(this._nextAutoNumber, layout.offsetNextAutoNumber);
        for (const index of this.indexDatas) {
            index.write();
            page.writeUInt32LE(index.uniqueEntryCount, index.uniqueEntryCountOffset);
        }
    }

    // ------------------------------------------------------------------
    // internal helpers
    // ------------------------------------------------------------------

    private handleAutoNumbers(values: readonly AccessValue[]): void {
        for (const column of this.columns) {
            if (!column.autoLong) {
                continue;
            }
            const value = values[column.columnNumber];
            const numeric = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
            if (Number.isFinite(numeric) && numeric > this._nextAutoNumber) {
                this._nextAutoNumber = numeric;
            }
        }
    }

    private rewriteDataPage(updatedLocation: JetRowLocation, updatedRow: Buffer): void {
        const layout = this.layout;
        const page = this._channel.pageAt(updatedLocation.pageNumber);
        const locations = this.rowsOnPage(updatedLocation.pageNumber, page)
            .filter(location => location.rowNumber !== updatedLocation.rowNumber);
        locations.sort((left, right) => left.rowNumber - right.rowNumber);

        // capture every row's bytes before rewriting the page (source and
        // destination ranges overlap, so copy everything first)
        const total = locations.length + 1;
        const rows: Buffer[] = [];
        let index = 0;
        const insertIndex = updatedLocation.rowNumber;
        for (let rowNumber = 0; rowNumber < total; rowNumber++) {
            if (rowNumber === insertIndex) {
                rows.push(Buffer.from(updatedRow));
            } else {
                const location = locations[index++]!;
                rows.push(Buffer.from(page.subarray(location.start, location.end)));
            }
        }

        // lay the rows out from the end of the page in row-number order
        let rowStart = layout.pageSize;
        const newOffsets: number[] = [];
        for (let rowNumber = 0; rowNumber < total; rowNumber++) {
            const size = rows[rowNumber]!.length;
            rowStart -= size;
            newOffsets.push(rowStart);
        }
        const minDataStart = layout.offsetRowStart + total * layout.sizeRowLocation;
        if (rowStart < minDataStart) {
            throw new AccessFileError(
                `Updated row in Access table '${this.name}' does not fit the data page; the page must be rebalanced or extended.`,
            );
        }
        page.fill(0, minDataStart, layout.pageSize);
        for (let rowNumber = 0; rowNumber < total; rowNumber++) {
            rows[rowNumber]!.copy(page, newOffsets[rowNumber]!, 0, rows[rowNumber]!.length);
        }
        const newFreeSpace = rowStart - (layout.offsetRowStart + total * layout.sizeRowLocation);
        for (let rowNumber = 0; rowNumber < total; rowNumber++) {
            page.writeUInt16LE(newOffsets[rowNumber]!, layout.offsetRowStart + layout.sizeRowLocation * rowNumber);
        }
        page.writeUInt16LE(total, layout.offsetNumRowsOnDataPage);
        page.writeUInt16LE(newFreeSpace, layout.offsetFreeSpace);
    }

    private rowsOnPage(pageNumber: number, page: Buffer): JetRowLocation[] {
        const layout = this.layout;
        const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
        const locations: JetRowLocation[] = [];
        for (let rowNumber = 0; rowNumber < rowCount; rowNumber++) {
            const location = this.rowLocationAt(pageNumber, rowNumber, page);
            if (location
                && (location.dataPageNumber ?? location.pageNumber) === pageNumber
                && (location.dataRowNumber ?? location.rowNumber) === rowNumber) {
                locations.push(location);
            }
        }
        return locations;
    }

    private asDataLocation(location: JetRowLocation): JetRowLocation {
        const pageNumber = location.dataPageNumber ?? location.pageNumber;
        const rowNumber = location.dataRowNumber ?? location.rowNumber;
        return {
            ...location,
            pageNumber,
            rowNumber,
            dataPageNumber: pageNumber,
            dataRowNumber: rowNumber,
        };
    }

    private removeRowPadding(row: Buffer): Buffer {
        const nullMaskSize = Math.ceil(this.maxColumns / 8);
        if (this.layout.sizeRowVarColOffset === 1) {
            const location: JetRowLocation = { pageNumber: 0, rowNumber: 0, start: 0, end: row.length };
            const offsets = this.variableOffsets(row, location);
            const endOfData = offsets[offsets.length - 1] ?? this.layout.sizeRowColumnCount;
            const unpadded = Buffer.alloc(this.layout.pageSize);
            row.copy(unpadded, 0, 0, endOfData);
            const trailerPosition = this.writeJet3VariableTrailer(unpadded, offsets, endOfData, 0);
            row.copy(unpadded, trailerPosition, row.length - nullMaskSize, row.length);
            return unpadded.subarray(0, trailerPosition + nullMaskSize);
        }
        const trailerSize = 2 + (this.variableColumnCount + 1) * 2 + 2 + nullMaskSize;
        const trailerStart = row.length - trailerSize;
        const endOfData = row.readUInt16LE(trailerStart);
        if (endOfData < 0 || endOfData > trailerStart) {
            throw new AccessFileError(`Invalid serialized row for Access table '${this.name}'.`);
        }
        const unpadded = Buffer.alloc(endOfData + trailerSize);
        row.copy(unpadded, 0, 0, endOfData);
        row.copy(unpadded, endOfData, trailerStart, row.length);
        return unpadded;
    }

    private longValueDefinitionsAt(location: JetRowLocation): Buffer[] {
        const dataLocation = this.asDataLocation(location);
        const page = this._channel.pageAt(dataLocation.pageNumber);
        const { mask } = this.nullMask(page, dataLocation);
        const offsets = this.variableOffsets(page, dataLocation);
        const definitions: Buffer[] = [];
        for (const column of this.columns) {
            if (!isLongValueType(column.type) || !this.isNotNull(mask, column.columnNumber)) {
                continue;
            }
            const start = dataLocation.start + (offsets[column.variableIndex] ?? 0);
            const end = dataLocation.start + (offsets[column.variableIndex + 1] ?? offsets[column.variableIndex] ?? 0);
            const data = page.subarray(start, end);
            if (data.length >= this.layout.sizeLongValueDef
                && longValueType(data) !== LONG_VALUE_TYPES.THIS_PAGE) {
                definitions.push(Buffer.from(data));
            }
        }
        return definitions;
    }

    private releaseLongValueDefinitions(
        definitions: readonly Buffer[],
        excludedLocation?: JetRowLocation,
    ): void {
        if (definitions.length === 0) {
            return;
        }
        const pagesToRelease = new Set<number>();
        for (const definition of definitions) {
            for (const pageNumber of longValuePageNumbers(definition, this._channel)) {
                pagesToRelease.add(pageNumber);
            }
        }
        if (pagesToRelease.size === 0) {
            return;
        }

        // Do not free a page that is still referenced by another row.  This
        // matters for files produced by Access itself, which may pack several
        // long-value rows onto one LVAL page.
        const referencedPages = this.referencedLongValuePages(excludedLocation);
        for (const pageNumber of pagesToRelease) {
            if (referencedPages.has(pageNumber)) {
                continue;
            }
            if (this.ownedPages.containsPageNumber(pageNumber)) {
                this.ownedPages.removePageNumber(pageNumber);
            }
            if (this.freeSpacePages.containsPageNumber(pageNumber)) {
                this.freeSpacePages.removePageNumber(pageNumber);
            }
            this._channel.deallocatePage(pageNumber);
            this.longValuePages.delete(pageNumber);
        }
    }

    private referencedLongValuePages(excludedLocation?: JetRowLocation): Set<number> {
        const referenced = new Set<number>();
        for (const location of this.rowLocations()) {
            if (excludedLocation
                && location.pageNumber === excludedLocation.pageNumber
                && location.rowNumber === excludedLocation.rowNumber) {
                continue;
            }
            for (const definition of this.longValueDefinitionsAt(location)) {
                for (const pageNumber of longValuePageNumbers(definition, this._channel)) {
                    referenced.add(pageNumber);
                }
            }
        }
        return referenced;
    }

    private findFreeRowSpace(rowSize: number): number {
        const layout = this.layout;
        const owned = Array.from(this.ownedPages.cursor()).sort((a, b) => b - a);
        for (const pageNumber of owned) {
            if (!this.freeSpacePages.containsPageNumber(pageNumber)) {
                continue;
            }
            const page = this._channel.pageAt(pageNumber);
            if (page[0] !== JET_PAGE_TYPES.DATA || page.readUInt32LE(4) === 0x4c41564c) {
                continue;
            }
            const freeSpace = page.readUInt16LE(layout.offsetFreeSpace);
            const rowsOnPage = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
            if (rowSize + layout.sizeRowLocation <= freeSpace && rowsOnPage < layout.maxNumRowsOnDataPage) {
                return pageNumber;
            }
            this.freeSpacePages.removePageNumber(pageNumber);
        }
        const newPage = this._channel.newDataPage(this.definitionPage);
        this.ownedPages.addPageNumber(newPage.pageNumber);
        this.freeSpacePages.addPageNumber(newPage.pageNumber);
        return newPage.pageNumber;
    }

    /**
     * Serializes a row (port of the existing staged writer's createRow, plus
     * LVAL definitions for MEMO/OLE values).
     */
    private createRow(
        values: readonly AccessValue[],
        minRowSize = 0,
        preservedLongValues?: ReadonlyMap<number, Buffer>,
    ): Buffer {
        const layout = this.layout;
        const nullMaskSize = Math.ceil(this.maxColumns / 8);
        const output = Buffer.alloc(layout.pageSize);
        let position = layout.sizeRowColumnCount;
        if (layout.sizeRowColumnCount === 1) {
            output.writeUInt8(this.maxColumns, 0);
        } else {
            output.writeUInt16LE(this.maxColumns, 0);
        }
        const mask = Buffer.alloc(nullMaskSize);
        let fixedEnd = position;
        for (const column of this.columns) {
            if (column.variable) continue;
            const value = values[column.columnNumber] ?? null;
            if (column.type === TYPE_BOOLEAN) {
                if (value === true) this.setMask(mask, column.columnNumber);
                continue;
            }
            if (value !== null) {
                this.setMask(mask, column.columnNumber);
                this.encodeFixed(column, value, layout).copy(output, position + column.fixedOffset);
            }
            fixedEnd = Math.max(fixedEnd, position + column.fixedOffset + this.fixedSize(column));
        }
        position = fixedEnd;
        const variableColumns = this.columns.filter(column => column.variable)
            .sort((left, right) => left.variableIndex - right.variableIndex);
        const offsets = new Array<number>(this.variableColumnCount + 1).fill(position);
        for (const column of variableColumns) {
            const offset = position;
            const value = values[column.columnNumber] ?? null;
            if (value !== null) {
                this.setMask(mask, column.columnNumber);
                const preserved = isLongValueType(column.type)
                    ? preservedLongValues?.get(column.columnNumber)
                    : undefined;
                let bytes: Buffer;
                if (preserved) {
                    bytes = Buffer.from(preserved);
                } else if (isLongValueType(column.type)) {
                    bytes = writeLongValue(
                        this.valueBytes(value),
                        layout.pageSize - position,
                        this._channel,
                        pageNumber => {
                            this.longValuePages.add(pageNumber);
                        },
                    );
                } else if (column.type === TYPE_TEXT) {
                    bytes = this.encodeText(value, layout);
                } else if (value instanceof Uint8Array) {
                    bytes = Buffer.from(value);
                } else {
                    bytes = this.encodeFixed(column, value, layout);
                }
                bytes.copy(output, position);
                position += bytes.length;
            }
            offsets[column.variableIndex] = offset;
            offsets[column.variableIndex + 1] = position;
        }
        for (let index = 0; index < offsets.length; index++) offsets[index] ??= position;
        const endOfData = position;
        if (layout.sizeRowVarColOffset === 1) {
            position = this.writeJet3VariableTrailer(output, offsets, endOfData, minRowSize);
        } else {
            const trailerSize = 2 + offsets.length * 2 + 2 + nullMaskSize;
            if (position + trailerSize < minRowSize) position = minRowSize - trailerSize;
            output.writeUInt16LE(endOfData, position);
            position += 2;
            for (let index = offsets.length - 1; index >= 0; index--) {
                output.writeUInt16LE(offsets[index] ?? endOfData, position);
                position += 2;
            }
            output.writeUInt16LE(this.variableColumnCount, position);
            position += 2;
        }
        mask.copy(output, position);
        position += mask.length;
        return output.subarray(0, position);
    }

    /** Serializes the Jet 3 jump-table variable-column trailer. */
    private writeJet3VariableTrailer(
        output: Buffer,
        offsets: readonly number[],
        endOfData: number,
        minRowSize: number,
    ): number {
        const nullMaskSize = Math.ceil(this.maxColumns / 8);
        let variableDataEnd = endOfData;
        let jumpCount = 0;
        while (true) {
            const trailerLength = (this.variableColumnCount + 1) + jumpCount + 1 + nullMaskSize;
            const rowLength = variableDataEnd + trailerLength;
            const computedJumps = Math.floor((rowLength - 1) / 0x100);
            let paddedEnd = variableDataEnd;
            if (minRowSize > 0 && variableDataEnd + trailerLength < minRowSize) {
                paddedEnd = minRowSize - trailerLength;
            }
            if (computedJumps === jumpCount && paddedEnd === variableDataEnd) {
                break;
            }
            jumpCount = computedJumps;
            variableDataEnd = paddedEnd;
        }
        output.fill(0, endOfData, variableDataEnd);

        const rowEndInclusive = variableDataEnd
            + (this.variableColumnCount + 1)
            + jumpCount
            + 1
            + nullMaskSize
            - 1;
        const columnOffset = rowEndInclusive - nullMaskSize - jumpCount - 1;
        let effectiveJumps = jumpCount;
        if (Math.floor((columnOffset - this.variableColumnCount) / 0x100) < jumpCount) {
            effectiveJumps = jumpCount - 1;
        }
        const completeOffsets = Array.from({ length: this.variableColumnCount + 1 }, (_, index) =>
            index === this.variableColumnCount ? variableDataEnd : (offsets[index] ?? endOfData));
        for (let jump = 0; jump < effectiveJumps; jump++) {
            const target = (jump + 1) * 0x100;
            const first = completeOffsets.findIndex(offset => offset >= target);
            output[rowEndInclusive - nullMaskSize - jump - 1] = first < 0 ? completeOffsets.length : first;
        }
        for (let index = 0; index < completeOffsets.length; index++) {
            output[columnOffset - index] = completeOffsets[index]! % 0x100;
        }
        output[rowEndInclusive - nullMaskSize] = this.variableColumnCount;
        return rowEndInclusive + 1 - nullMaskSize;
    }

    private valueBytes(value: AccessValue): Buffer {
        if (value instanceof Uint8Array) {
            return Buffer.from(value);
        }
        const text = typeof value === 'string'
            ? value
            : value instanceof Date
                ? value.toISOString()
                : String(value ?? '');
        return Buffer.from(text, this.layout.utf16 ? 'utf16le' : 'latin1');
    }

    private encodeText(value: AccessValue, layout: JetLayout): Buffer {
        const text = String(value ?? '');
        return Buffer.from(text, layout.utf16 ? 'utf16le' : 'latin1');
    }

    private encodeFixed(column: JetColumn, value: AccessValue, layout: JetLayout): Buffer {
        const size = this.fixedSize(column);
        const output = Buffer.alloc(size);
        const numberValue = (): number => {
            if (typeof value === 'bigint') return Number(value);
            if (value instanceof Date) return value.getTime();
            if (typeof value === 'number') return value;
            if (typeof value === 'boolean') return value ? 1 : 0;
            return Number(value ?? 0);
        };
        switch (column.type) {
            case 0x02: output.writeUInt8(numberValue(), 0); break;
            case 0x03: output.writeInt16LE(numberValue(), 0); break;
            case 0x04: output.writeInt32LE(numberValue(), 0); break;
            case 0x05: {
                const text = String(value ?? '0').trim();
                const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
                if (!match) throw new AccessFileError(`Value '${text}' is not a supported currency.`);
                const negative = match[1] === '-';
                const fraction = (match[3] ?? '').padEnd(4, '0').slice(0, 4);
                const magnitude = BigInt(`${match[2] ?? '0'}${fraction}` || '0');
                output.writeBigInt64LE(negative ? -magnitude : magnitude, 0);
                break;
            }
            case 0x06: output.writeFloatLE(numberValue(), 0); break;
            case 0x07: output.writeDoubleLE(numberValue(), 0); break;
            case 0x08: output.writeDoubleLE((numberValue() - Date.UTC(1899, 11, 30)) / 86400000, 0); break;
            case 0x13: {
                const integer = this.bigIntValue(value, column);
                try {
                    output.writeBigInt64LE(integer, 0);
                } catch (error) {
                    throw new AccessFileError(
                        `Value '${String(value)}' is outside the BIGINT range for column '${column.name}'.`,
                        { cause: error },
                    );
                }
                break;
            }
            case 0x0a: this.encodeText(value, layout).copy(output, 0, 0, size); break;
            case 0x0f: this.encodeGuid(value).copy(output, 0, 0, size); break;
            case 0x10: this.encodeNumeric(column, value).copy(output, 0, 0, size); break;
            default: Buffer.from(value instanceof Uint8Array ? value : []).copy(output, 0, 0, size);
        }
        return output;
    }

    private bigIntValue(value: AccessValue, column: JetColumn): bigint {
        try {
            if (typeof value === 'bigint') {
                return value;
            }
            if (typeof value === 'number') {
                if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
                    throw new Error('number is not a safe integer');
                }
                return BigInt(value);
            }
            if (typeof value === 'string') {
                return BigInt(value.trim());
            }
        } catch (error) {
            throw new AccessFileError(
                `Value '${String(value)}' is not a supported BIGINT for column '${column.name}'.`,
                { cause: error },
            );
        }
        throw new AccessFileError(`Value '${String(value)}' is not a supported BIGINT for column '${column.name}'.`);
    }

    private encodeGuid(value: AccessValue): Buffer {
        const text = String(value ?? '').trim().replace(/[{}]/g, '');
        const groups = text.split('-');
        if (groups.length !== 5 || groups.some(group => !/^[0-9a-f]+$/i.test(group))) {
            throw new AccessFileError(`Value '${text}' is not a supported GUID.`);
        }
        const output = Buffer.alloc(16);
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

    private encodeNumeric(column: JetColumn, value: AccessValue): Buffer {
        const text = typeof value === 'bigint'
            ? value.toString()
            : typeof value === 'number'
                ? String(value)
                : String(value ?? '0').trim();
        const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
        if (!match) {
            throw new AccessFileError(`Value '${text}' is not a supported decimal.`);
        }
        const negative = match[1] === '-';
        const integerPart = match[2] ?? '0';
        const fractionPart = match[3] ?? '';
        const keptFraction = fractionPart.slice(0, column.scale).padEnd(column.scale, '0');
        let magnitude = BigInt(`${integerPart}${keptFraction}` || '0');
        const discarded = fractionPart.slice(column.scale);
        if (discarded.length > 0 && Number(discarded[0] ?? 0) >= 5) {
            magnitude += 1n;
        }
        if (column.precision > 0 && magnitude.toString().length > column.precision) {
            throw new AccessFileError(
                `Value '${String(value)}' exceeds precision ${column.precision} for column '${column.name}'.`,
            );
        }
        const output = Buffer.alloc(17);
        output[0] = negative && magnitude !== 0n ? 0x80 : 0;
        let remainder = magnitude;
        for (let index = 16; index >= 1; index--) {
            output[index] = Number(remainder & 0xffn);
            remainder >>= 8n;
        }
        if (remainder !== 0n) {
            throw new AccessFileError(`Value '${String(value)}' is too large for column '${column.name}'.`);
        }
        for (let index = 1; index < output.length; index += 4) {
            output.subarray(index, index + 4).reverse();
        }
        return output;
    }

    private setMask(mask: Buffer, index: number): void {
        mask[Math.floor(index / 8)] = (mask[Math.floor(index / 8)] ?? 0) | (1 << (index % 8));
    }

    private valuesEqual(left: AccessValue, right: AccessValue): boolean {
        if (left instanceof Uint8Array && right instanceof Uint8Array) {
            return left.length === right.length && left.every((value, index) => value === right[index]);
        }
        if (left instanceof Date && right instanceof Date) {
            return left.getTime() === right.getTime();
        }
        return left === right;
    }
}
