/**
 * The physical data behind an index (port of IndexData from
 * JustyBase.UCanAccessCs / Jackcess).
 */

import { AccessFileError } from '../accessFileSession';
import type { AccessValue } from '../types';
import {
    JetBooleanColumnDescriptor,
    JetByteColumnDescriptor,
    JetBinaryColumnDescriptor,
    JetColumnDescriptor,
    JetFixedPointColumnDescriptor,
    JetFloatingPointColumnDescriptor,
    JetGuidColumnDescriptor,
    JetIntegerColumnDescriptor,
    JetLegacyFixedPointColumnDescriptor,
    JetTextColumnDescriptor,
} from './JetColumnDescriptor';
import { ByteStream } from './JetTextSortOrder';
import {
    FIRST_ENTRY,
    JetIndexEntry,
    JetRowId,
    byteCodeCompare,
} from './JetIndexEntry';
import type { JetLayout } from './JetLayout';
import type { JetTable } from './JetTable';
import { JetUsageMap } from './JetUsageMap';
import { JetIndexPageCache } from './JetIndexPageCache';
import { JetIndexPosition } from './JetIndexPageCacheTypes';
import type { JetIndexDataPage } from './JetIndexPageCacheTypes';

export const INDEX_MAX_COLUMNS = 10;
export const INDEX_COLUMN_UNUSED = -1;
export const INDEX_MAGIC_NUMBER = 1923;
export const INVALID_INDEX_PAGE_NUMBER = 0;

export const UNIQUE_INDEX_FLAG = 0x01;
export const IGNORE_NULLS_INDEX_FLAG = 0x02;
export const REQUIRED_INDEX_FLAG = 0x08;
export const UNKNOWN_INDEX_FLAG = 0x80;

const TEXT_TYPE = 0x0a;
const MEMO_TYPE = 0x0c;
const BOOLEAN_TYPE = 0x01;
const GUID_TYPE = 0x0f;

/** special objects which sort outside any valid value range */
export const MIN_INDEX_VALUE: unique symbol = Symbol('min');
export const MAX_INDEX_VALUE: unique symbol = Symbol('max');

export interface JetIndexColumnRef {
    readonly descriptor: JetColumnDescriptor;
}

export class JetIndexData {
    public readonly number: number;
    public readonly uniqueEntryCountOffset: number;
    public columns: readonly JetColumnDescriptor[] = [];
    public indexFlags = 0;
    public ownedPages!: JetUsageMap;
    public rootPageNumber = 0;
    public backingPrimaryKey = false;

    private _uniqueEntryCount: number;
    private _initialized = false;
    private readonly _pageCache: JetIndexPageCache;
    private readonly _table: JetTable;

    private constructor(
        table: JetTable,
        number: number,
        uniqueEntryCount: number,
        uniqueEntryCountOffset: number,
    ) {
        this._table = table;
        this.number = number;
        this._uniqueEntryCount = uniqueEntryCount;
        this.uniqueEntryCountOffset = uniqueEntryCountOffset;
        this._pageCache = new JetIndexPageCache(this);
    }

    public get table(): JetTable {
        return this._table;
    }

    /** Creates an IndexData for the given table, reading the unique-entry count from the table-definition buffer. */
    public static create(table: JetTable, tableBuffer: Buffer, number: number, layout: JetLayout): JetIndexData {
        const uniqueEntryCountOffset = layout.offsetIndexDefBlock + number * layout.sizeIndexDefinition + 4;
        const uniqueEntryCount = tableBuffer.readUInt32LE(uniqueEntryCountOffset);
        return new JetIndexData(table, number, uniqueEntryCount, uniqueEntryCountOffset);
    }

    public static read(
        table: JetTable,
        tableBuffer: Buffer,
        number: number,
        layout: JetLayout,
        position: { value: number },
    ): JetIndexData {
        const data = JetIndexData.create(table, tableBuffer, number, layout);
        data.readFrom(tableBuffer, layout, position);
        return data;
    }

    private readFrom(tableBuffer: Buffer, layout: JetLayout, position: { value: number }): void {
        position.value += layout.skipBeforeIndex;

        const columns: JetColumnDescriptor[] = [];
        for (let index = 0; index < INDEX_MAX_COLUMNS; index++) {
            const columnNumber = tableBuffer.readInt16LE(position.value);
            position.value += 2;
            const colFlags = tableBuffer[position.value] ?? 0;
            position.value += 1;
            if (columnNumber !== INDEX_COLUMN_UNUSED) {
                const column = this._table.columns.find(candidate => candidate.columnNumber === columnNumber);
                if (!column) {
                    throw new AccessFileError(`Could not find column with number ${columnNumber} for index`);
                }
                columns.push(createColumnDescriptor(this._table, column, colFlags));
            }
        }
        this.columns = columns;

        // usage map for the index's owned pages
        this.ownedPages = readIndexOwnedPages(this._table, tableBuffer, position);

        this.rootPageNumber = tableBuffer.readUInt32LE(position.value);
        position.value += 4;

        position.value += layout.skipBeforeIndexFlags;
        this.indexFlags = tableBuffer[position.value] ?? 0;
        position.value += 1;
        position.value += layout.skipAfterIndexFlags;

        this._pageCache.setRootPageNumber(this.rootPageNumber);
        this._initialized = true;
        this.backingPrimaryKey = false;
    }

    public get uniqueEntryCount(): number {
        return this._uniqueEntryCount;
    }

    public get shouldIgnoreNulls(): boolean {
        return (this.indexFlags & IGNORE_NULLS_INDEX_FLAG) !== 0;
    }

    public get isUnique(): boolean {
        return this.backingPrimaryKey || (this.indexFlags & UNIQUE_INDEX_FLAG) !== 0;
    }

    public get isRequired(): boolean {
        return (this.indexFlags & REQUIRED_INDEX_FLAG) !== 0;
    }

    public get maxPageEntrySize(): number {
        return calcMaxPageEntrySize(this._table.layout);
    }

    /** encodes column values into the byte sequences that make up an index entry */
    public createEntryBytes(values: readonly (AccessValue | null | typeof MIN_INDEX_VALUE | typeof MAX_INDEX_VALUE)[]): Uint8Array {
        const bout = new ByteStream(32);
        for (const column of this.columns) {
            const value = values[column.columnNumber];
            if (value === MIN_INDEX_VALUE) {
                bout.writeByte(0x00);
                continue;
            }
            if (value === MAX_INDEX_VALUE) {
                bout.writeByte(0xff);
                continue;
            }
            column.writeValue(value as AccessValue | null, bout);
        }
        return bout.getBytes();
    }

    /** prepares to add a row to this index (all constraints checked before returning) */
    public prepareAddRow(row: readonly AccessValue[], rowId: JetRowId): JetPendingChange | null {
        const nullCount = this.countNullValues(row);
        const isNullEntry = nullCount === this.columns.length;
        if (this.shouldIgnoreNulls && isNullEntry) {
            return null;
        }
        if (nullCount > 0 && (this.backingPrimaryKey || this.isRequired)) {
            throw new AccessFileError(`Null value found in row [${row.join(',')}] for primary key or required index`);
        }

        this.initialize();
        return this.prepareAddEntry(new JetIndexEntry(this.createEntryBytes(row), rowId), isNullEntry, row);
    }

    private prepareAddEntry(newEntry: JetIndexEntry, isNullEntry: boolean, row: readonly AccessValue[]): JetPendingChange {
        const dataPage = this._pageCache.findCacheDataPage(newEntry);
        const idx = binarySearch(dataPage.entries, newEntry);
        if (idx < 0) {
            const insertIdx = missingIndexToInsertionPoint(idx);
            const newPos = new JetIndexPosition(dataPage, insertIdx, newEntry, true);
            const nextPos = this.getNextPosition(newPos);
            const prevPos = this.getPreviousPosition(newPos);

            const isDupeEntry = (nextPos !== null && newEntry.equalsEntryBytes(nextPos.entry))
                || (prevPos !== null && newEntry.equalsEntryBytes(prevPos.entry));
            if (this.isUnique && !isNullEntry && isDupeEntry) {
                throw new AccessFileError(`New row [${row.join(',')}] violates uniqueness constraint for index`);
            }
            return new JetAddRowPendingChange(this, newEntry, dataPage, insertIdx, isDupeEntry, null);
        }
        return new JetAddRowPendingChange(this, null, dataPage, idx, false, dataPage.entries[idx] ?? null);
    }

    /** completes a prepared row addition */
    public commitAddRow(newEntry: JetIndexEntry | null, dataPage: JetIndexDataPage, idx: number, isDupeEntry: boolean, oldEntry: JetIndexEntry | null): void {
        if (newEntry !== null) {
            dataPage.addEntry(idx, newEntry);
            if (!isDupeEntry && oldEntry === null) {
                this._uniqueEntryCount++;
            }
        }
    }

    /** removes a row from this index */
    public deleteRow(row: readonly AccessValue[], rowId: JetRowId): void {
        const nullCount = this.countNullValues(row);
        if (this.shouldIgnoreNulls && nullCount === this.columns.length) {
            return;
        }
        this.initialize();
        const oldEntry = new JetIndexEntry(this.createEntryBytes(row), rowId);
        this.removeEntry(oldEntry);
    }

    private removeEntry(oldEntry: JetIndexEntry): JetIndexEntry | null {
        const dataPage = this._pageCache.findCacheDataPage(oldEntry);
        const idx = binarySearch(dataPage.entries, oldEntry);
        if (idx < 0) {
            const found = this.findEntryByRowId(oldEntry.rowId);
            if (found) {
                return found.dataPage.removeEntry(found.index);
            }
            return null;
        }
        return dataPage.removeEntry(idx);
    }

    private findEntryByRowId(rowId: JetRowId): { dataPage: JetIndexDataPage; index: number } | null {
        let page: JetIndexDataPage | null = this._pageCache.findCacheDataPage(FIRST_ENTRY);
        while (page) {
            for (let index = 0; index < page.entries.length; index++) {
                if (page.entries[index]!.rowId.equals(rowId)) {
                    return { dataPage: page, index };
                }
            }
            const next = page.nextPageNumber;
            if (next === INVALID_INDEX_PAGE_NUMBER) {
                break;
            }
            page = this._pageCache.getCacheDataPage(next);
        }
        return null;
    }

    /** finds the data page for the given entry */
    public findDataPage(entry: JetIndexEntry): JetIndexDataPage {
        return this._pageCache.findCacheDataPage(entry);
    }

    public findEntryPosition(entry: JetIndexEntry): JetIndexPosition {
        const dataPage = this.findDataPage(entry);
        const idx = binarySearch(dataPage.entries, entry);
        const between = idx < 0;
        return new JetIndexPosition(dataPage, between ? missingIndexToInsertionPoint(idx) : idx, entry, between);
    }

    public getNextPosition(curPos: JetIndexPosition): JetIndexPosition | null {
        const nextIdx = curPos.nextIndex;
        if (nextIdx < curPos.dataPage.entries.length) {
            return new JetIndexPosition(curPos.dataPage, nextIdx, curPos.dataPage.entries[nextIdx]!, false);
        }
        let nextPageNumber = curPos.dataPage.nextPageNumber;
        let nextDataPage: JetIndexDataPage | null = null;
        while (nextPageNumber !== INVALID_INDEX_PAGE_NUMBER) {
            const dp = this._pageCache.getCacheDataPage(nextPageNumber);
            if (dp && !dp.isEmpty) {
                nextDataPage = dp;
                break;
            }
            if (!dp) break;
            nextPageNumber = dp.nextPageNumber;
        }
        return nextDataPage ? new JetIndexPosition(nextDataPage, 0, nextDataPage.entries[0] ?? FIRST_ENTRY, false) : null;
    }

    public getPreviousPosition(curPos: JetIndexPosition): JetIndexPosition | null {
        const prevIdx = curPos.prevIndex;
        if (prevIdx >= 0) {
            return new JetIndexPosition(curPos.dataPage, prevIdx, curPos.dataPage.entries[prevIdx]!, false);
        }
        let prevPageNumber = curPos.dataPage.prevPageNumber;
        let prevDataPage: JetIndexDataPage | null = null;
        while (prevPageNumber !== INVALID_INDEX_PAGE_NUMBER) {
            const dp = this._pageCache.getCacheDataPage(prevPageNumber);
            if (dp && !dp.isEmpty) {
                prevDataPage = dp;
                break;
            }
            if (!dp) break;
            prevPageNumber = dp.prevPageNumber;
        }
        return prevDataPage
            ? new JetIndexPosition(prevDataPage, prevDataPage.entries.length - 1, prevDataPage.entries[prevDataPage.entries.length - 1] ?? FIRST_ENTRY, false)
            : null;
    }

    private countNullValues(values: readonly (AccessValue | null | typeof MIN_INDEX_VALUE | typeof MAX_INDEX_VALUE)[]): number {
        let nullCount = 0;
        for (const column of this.columns) {
            const value = values[column.columnNumber];
            if (column.isNullValue(value as AccessValue | null)) {
                nullCount++;
            }
        }
        return nullCount;
    }

    public initialize(): void {
        if (!this._initialized) {
            this._pageCache.setRootPageNumber(this.rootPageNumber);
            this._initialized = true;
        }
    }

    public write(): void {
        this.initialize();
        this._pageCache.write();
    }

    public addOwnedPage(pageNumber: number): void {
        this.ownedPages.addPageNumber(pageNumber);
    }

    public setBackingPrimaryKey(value: boolean): void {
        this.backingPrimaryKey = value;
    }

    /** updates the unique entry count stored in the table definition */
    public writeUniqueEntryCount(tableBuffer: Buffer): void {
        tableBuffer.writeUInt32LE(this._uniqueEntryCount, this.uniqueEntryCountOffset);
    }
}

function readIndexOwnedPages(table: JetTable, tableBuffer: Buffer, position: { value: number }): JetUsageMap {
    // the usage map declaration is 4 bytes: row number (1) + page number (3)
    const map = JetUsageMap.read(table.channel, tableBuffer, position.value);
    position.value += 4;
    return map;
}

export abstract class JetPendingChange {
    public constructor(protected readonly index: JetIndexData) {
    }

    public abstract commit(): void;
    public abstract rollback(): void;
}

class JetAddRowPendingChange extends JetPendingChange {
    public constructor(
        index: JetIndexData,
        private readonly _addEntry: JetIndexEntry | null,
        private readonly _addDataPage: JetIndexDataPage | null,
        private readonly _addIdx: number,
        private readonly _isDupe: boolean,
        private readonly _oldEntry: JetIndexEntry | null,
    ) {
        super(index);
    }

    public override commit(): void {
        this.index.commitAddRow(this._addEntry, this._addDataPage!, this._addIdx, this._isDupe, this._oldEntry);
    }

    public override rollback(): void {
        // nothing to undo (the entry was never inserted)
    }
}

function missingIndexToInsertionPoint(idx: number): number {
    return -(idx + 1);
}

function binarySearch(entries: readonly JetIndexEntry[], entry: JetIndexEntry): number {
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const cmp = entries[mid]!.compareTo(entry);
        if (cmp < 0) {
            low = mid + 1;
        } else if (cmp > 0) {
            high = mid - 1;
        } else {
            return mid;
        }
    }
    return -(low + 1);
}

function calcMaxPageEntrySize(layout: JetLayout): number {
    const pageDataSize = layout.pageSize - (layout.offsetIndexEntryMask + layout.sizeIndexEntryMask);
    const entryMaskSize = layout.sizeIndexEntryMask * 8;
    return Math.min(pageDataSize, entryMaskSize);
}

function createColumnDescriptor(table: JetTable, column: JetTable['columns'][number], flags: number): JetColumnDescriptor {
    switch (column.type) {
        case 0x02:
            return new JetByteColumnDescriptor(column, flags);
        case 0x03:
        case 0x04:
        case 0x05:
        case 0x12: // complex columns store their child-table pointer as an integer
        case 0x13:
            return new JetIntegerColumnDescriptor(column, flags);
        case 0x06:
        case 0x07:
        case 0x08:
            return new JetFloatingPointColumnDescriptor(column, flags);
        case 0x10:
            return table.layout.utf16
                ? new JetFixedPointColumnDescriptor(column, flags)
                : new JetLegacyFixedPointColumnDescriptor(column, flags);
        case BOOLEAN_TYPE:
            return new JetBooleanColumnDescriptor(column, flags);
        case GUID_TYPE:
            return new JetGuidColumnDescriptor(column, flags);
        case 0x09:
        case 0x0b:
            return new JetBinaryColumnDescriptor(column, flags);
        case TEXT_TYPE:
        case MEMO_TYPE: {
            const sortOrder = table.columnSortOrder(column);
            return new JetTextColumnDescriptor(column, flags, sortOrder);
        }
        default:
            throw new AccessFileError(`Unsupported data type ${column.type} for index`);
    }
}

export { byteCodeCompare };
