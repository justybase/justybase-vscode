/**
 * DDL operations for the direct-mutation writer (port of TableCreator,
 * IndexMutator, QueryDefWriter and Database.DeleteTable from
 * JustyBase.UCanAccessCs).
 *
 * Supports CREATE/DROP TABLE, CREATE/DROP INDEX, and CREATE/DROP VIEW on
 * Jet 4 / ACCDB files.
 */

import { AccessFileError } from '../accessFileSession';
import type { AccessValue } from '../types';
import { JET_PAGE_TYPES } from './JetLayout';
import type { JetLayout } from './JetLayout';
import { JetPageChannel } from './JetPageChannel';
import { JetTable } from './JetTable';
import type { JetIndexData } from './JetIndexData';
import { JetRowId } from './JetIndexEntry';

const MAGIC_TABLE_NUMBER = 1625;
const MAGIC_INDEX_NUMBER = 1923;
const TYPE_USER = 0x4e;
const TYPE_TABLE = 1;
const UPGRADEABLE_FLAG = 0x02;
const FIXED_LEN_FLAG = 0x01;
const AUTO_NUMBER_FLAG = 0x04;
const AUTO_NUMBER_GUID_FLAG = 0x40;
const INVALID_INDEX_NUMBER = -1;
const TYPE_PRIMARY_KEY = 1;

export interface JetDdlColumn {
    readonly name: string;
    readonly type: number;
    readonly length?: number;
    readonly precision?: number;
    readonly scale?: number;
    readonly notNull?: boolean;
    readonly autoNumber?: boolean;
}

export interface JetDdlIndex {
    readonly name: string;
    readonly columns: readonly { readonly name: string; readonly ascending: boolean }[];
    readonly primaryKey?: boolean;
    readonly unique?: boolean;
    readonly ignoreNulls?: boolean;
    readonly required?: boolean;
}

interface ColumnState {
    variableLength: boolean;
    longValue: boolean;
    varLenTableIndex: number;
    fixedDataOffset: number;
}

interface IndexState {
    rootPageNumber: number;
    umapRowNumber: number;
    umapPageNumber: number;
}

function isLongValueType(type: number): boolean {
    return type === 0x0b || type === 0x0c; // OLE / MEMO
}

function isVariableLength(type: number): boolean {
    switch (type) {
        case 0x01: // boolean
        case 0x02: // byte
        case 0x03: // int
        case 0x04: // long
        case 0x05: // money
        case 0x06: // float
        case 0x07: // double
        case 0x08: // date
        case 0x0f: // guid
        case 0x10: // numeric
        case 0x13: // bigint
            return false;
        default:
            return true;
    }
}

function fixedDataSize(column: JetDdlColumn, _layout: JetLayout): number {
    switch (column.type) {
        case 0x02: return 1;
        case 0x03: return 2;
        case 0x04: return 4;
        case 0x05:
        case 0x07:
        case 0x08:
        case 0x13: return 8;
        case 0x06: return 4;
        case 0x0f: return 16;
        case 0x10: return 17;
        case 0x01: return 0; // boolean lives in the null mask
        default: return column.length ?? 1;
    }
}

function computeStoredLength(column: JetDdlColumn, layout: JetLayout): number {
    if (isVariableLength(column.type)) {
        return column.length ?? (column.type === 0x0c ? 0 : 1);
    }
    if (isLongValueType(column.type)) {
        return 0;
    }
    return fixedDataSize(column, layout);
}

function buildColumnStates(columns: readonly JetDdlColumn[], layout: JetLayout): ColumnState[] {
    const result: ColumnState[] = [];
    let varOffset = 0;
    let longVarOffset = columns.filter(c => isVariableLength(c.type) && !isLongValueType(c.type)).length;
    let fixedOffset = 0;
    for (const column of columns) {
        const variableLength = isVariableLength(column.type);
        if (variableLength) {
            result.push({
                variableLength: true,
                longValue: isLongValueType(column.type),
                varLenTableIndex: isLongValueType(column.type) ? longVarOffset++ : varOffset++,
                fixedDataOffset: 0,
            });
        } else {
            result.push({
                variableLength: false,
                longValue: false,
                varLenTableIndex: varOffset,
                fixedDataOffset: column.type === 0x01 ? 0 : fixedOffset,
            });
            if (column.type !== 0x01) {
                fixedOffset += fixedDataSize(column, layout);
            }
        }
    }
    return result;
}

function calculateNameLength(name: string, layout: JetLayout): number {
    return name.length * (layout.utf16 ? 2 : 1) + layout.sizeNameLength;
}

function calculateTableDefinitionSize(
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[],
    layout: JetLayout,
): number {
    const idxDataLen = indexes.length * (layout.sizeIndexDefinition + layout.sizeIndexColumnBlock)
        + indexes.length * layout.sizeIndexInfoBlock;
    const colUmapLen = columns.filter(c => isLongValueType(c.type)).length * 10;
    let total = layout.offsetIndexDefBlock
        + layout.sizeIndexDefinition * indexes.length
        + layout.sizeColumnHeader * columns.length
        + idxDataLen
        + colUmapLen
        + 2; // trailer 0xFF 0xFF
    for (const column of columns) {
        total += calculateNameLength(column.name, layout);
    }
    for (const index of indexes) {
        total += calculateNameLength(index.name, layout);
    }
    return total;
}

function findColumnNumber(columns: readonly JetDdlColumn[], name: string): number {
    return columns.findIndex(column => column.name.toLowerCase() === name.toLowerCase());
}

function writeShort(buffer: Buffer, position: { value: number }, value: number): void {
    buffer.writeInt16LE(value, position.value);
    position.value += 2;
}

function writeInt(buffer: Buffer, position: { value: number }, value: number): void {
    buffer.writeInt32LE(value, position.value);
    position.value += 4;
}

function write3ByteInt(buffer: Buffer, position: { value: number }, value: number): void {
    buffer[position.value] = value & 0xff;
    buffer[position.value + 1] = (value >> 8) & 0xff;
    buffer[position.value + 2] = (value >> 16) & 0xff;
    position.value += 3;
}

function writeName(buffer: Buffer, position: { value: number }, name: string, layout: JetLayout): void {
    const bytes = Buffer.from(name, layout.utf16 ? 'utf16le' : 'latin1');
    if (layout.sizeNameLength === 2) {
        writeShort(buffer, position, bytes.length);
    } else {
        buffer[position.value++] = bytes.length;
    }
    bytes.copy(buffer, position.value);
    position.value += bytes.length;
}

function writeTableDefinitionHeader(
    buffer: Buffer,
    _tdefPageNumber: number,
    umapPageNumber: number,
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[],
    layout: JetLayout,
    rowCount = 0,
    nextAutoNumber = 0,
): void {
    buffer[0] = JET_PAGE_TYPES.TABLE_DEF;
    buffer[1] = 0x01;
    buffer.writeUInt32LE(0, 4); // next table def page
    buffer.writeUInt32LE(0, 8); // table def length (patched later)
    buffer.writeUInt32LE(MAGIC_TABLE_NUMBER, 12);
    buffer.writeUInt32LE(rowCount, layout.offsetNumRows);
    buffer.writeUInt32LE(nextAutoNumber, layout.offsetNextAutoNumber);
    buffer[24] = 1; // makes autonumbering work in Access
    buffer.fill(0, 25, 40);
    buffer[40] = TYPE_USER; // table type (offset 40 for Jet 4/ACCDB)
    buffer.writeUInt16LE(columns.length, layout.offsetMaxCols);
    buffer.writeUInt16LE(columns.filter(c => isVariableLength(c.type)).length, layout.offsetNumVarCols);
    buffer.writeUInt16LE(columns.length, layout.offsetNumCols);
    buffer.writeUInt32LE(indexes.length, layout.offsetNumIndexSlots);
    buffer.writeUInt32LE(indexes.length, layout.offsetNumIndexes);
    // owned pages map: row 0 on the umap page; free space pages map: row 1
    buffer[layout.offsetOwnedPages] = 0;
    write3ByteInt(buffer, { value: layout.offsetOwnedPages + 1 }, umapPageNumber);
    buffer[layout.offsetFreeSpacePages] = 1;
    write3ByteInt(buffer, { value: layout.offsetFreeSpacePages + 1 }, umapPageNumber);
}

function writeColumnDefinitions(
    buffer: Buffer,
    position: { value: number },
    columns: readonly JetDdlColumn[],
    states: readonly ColumnState[],
    layout: JetLayout,
): void {
    for (let index = 0; index < columns.length; index++) {
        const column = columns[index]!;
        const state = states[index]!;
        buffer[position.value++] = column.type;
        writeInt(buffer, position, MAGIC_TABLE_NUMBER);
        writeShort(buffer, position, index);
        writeShort(buffer, position, state.varLenTableIndex);
        writeShort(buffer, position, index);

        if (column.type === 0x0a || column.type === 0x0c) {
            // sort order: LCID 1033 + version (General Legacy for Jet 4)
            writeShort(buffer, position, 1033);
            buffer[position.value++] = 0;
            buffer[position.value++] = 0;
        } else if (column.type === 0x10 || column.type === 0x13) {
            buffer[position.value++] = column.precision ?? 0;
            buffer[position.value++] = column.scale ?? 0;
            writeShort(buffer, position, 0);
        } else {
            buffer[position.value++] = 0;
            buffer[position.value++] = 0;
            writeShort(buffer, position, 0);
        }

        let flags = UPGRADEABLE_FLAG;
        if (!state.variableLength) {
            flags |= FIXED_LEN_FLAG;
        }
        if (column.autoNumber) {
            flags |= column.type === 0x0f ? AUTO_NUMBER_GUID_FLAG : AUTO_NUMBER_FLAG;
        }
        buffer[position.value++] = flags;
        buffer[position.value++] = 0; // extended flags

        writeInt(buffer, position, 0); // unknown
        writeShort(buffer, position, state.variableLength ? 0 : state.fixedDataOffset);
        writeShort(buffer, position, computeStoredLength(column, layout));
    }
    for (const column of columns) {
        writeName(buffer, position, column.name, layout);
    }
}

function writeIndexDefinitions(
    buffer: Buffer,
    position: { value: number },
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[],
    states: readonly IndexState[],
    tdefPageNumber: number,
    layout: JetLayout,
    channel: JetPageChannel,
): void {
    for (let index = 0; index < indexes.length; index++) {
        const idx = indexes[index]!;
        const state = states[index]!;
        writeInt(buffer, position, MAGIC_INDEX_NUMBER);

        for (let slot = 0; slot < 10; slot++) {
            if (slot < idx.columns.length) {
                const colNumber = findColumnNumber(columns, idx.columns[slot]!.name);
                if (colNumber < 0) {
                    throw new AccessFileError(`Unknown column '${idx.columns[slot]!.name}' for index '${idx.name}'.`);
                }
                writeShort(buffer, position, colNumber);
                buffer[position.value++] = idx.columns[slot]!.ascending ? 0x01 : 0x00;
            } else {
                writeShort(buffer, position, -1);
                buffer[position.value++] = 0;
            }
        }

        // index usage map reference
        buffer[position.value] = state.umapRowNumber;
        const umapPage = position.value + 1;
        buffer[umapPage] = state.umapPageNumber & 0xff;
        buffer[umapPage + 1] = (state.umapPageNumber >> 8) & 0xff;
        buffer[umapPage + 2] = (state.umapPageNumber >> 16) & 0xff;
        position.value += 4;

        // fresh root page
        const rootPage = Buffer.alloc(layout.pageSize);
        rootPage[0] = JET_PAGE_TYPES.INDEX_LEAF;
        rootPage[1] = 0x01;
        rootPage.writeUInt32LE(tdefPageNumber, 4);
        rootPage.writeUInt16LE(layout.pageSize - (layout.offsetIndexEntryMask + layout.sizeIndexEntryMask), 2);
        rootPage.copy(channel.pageAt(state.rootPageNumber), 0, 0, layout.pageSize);
        writeInt(buffer, position, state.rootPageNumber);
        writeInt(buffer, position, 0); // unknown

        let indexFlags = 0x80; // unknown flag, always set on Access 2000+
        if (idx.unique) indexFlags |= 0x01;
        if (idx.ignoreNulls) indexFlags |= 0x02;
        if (idx.required) indexFlags |= 0x08;
        buffer[position.value++] = indexFlags;
        position.value += 5; // unknown
    }

    // logical index definitions
    for (let index = 0; index < indexes.length; index++) {
        const idx = indexes[index]!;
        writeInt(buffer, position, MAGIC_TABLE_NUMBER);
        writeInt(buffer, position, index); // index number
        writeInt(buffer, position, index); // index data number
        buffer[position.value++] = 0; // related table type
        writeInt(buffer, position, INVALID_INDEX_NUMBER);
        writeInt(buffer, position, 0);
        buffer[position.value++] = 0; // cascade updates
        buffer[position.value++] = 0; // cascade deletes
        buffer[position.value++] = idx.primaryKey ? TYPE_PRIMARY_KEY : 0;
        position.value += layout.skipAfterIndexSlot;
    }
}

function writeIndexNames(
    buffer: Buffer,
    position: { value: number },
    indexes: readonly JetDdlIndex[],
    layout: JetLayout,
): void {
    for (const index of indexes) {
        writeName(buffer, position, index.name, layout);
    }
}

/**
 * Creates the usage-map page(s) holding the table's owned/free space maps
 * (rows 0/1), one map per index (rows 2+), and two maps per long-value
 * column.
 */
interface ExistingIndexDefinition {
    readonly rootPageNumber: number;
    readonly ownedPages: readonly number[];
}

function createUsageMapDefinitionPage(
    channel: JetPageChannel,
    umapPageNumber: number,
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[],
    indexStates: IndexState[],
    layout: JetLayout,
    existingIndexes: readonly (ExistingIndexDefinition | null)[] = [],
    existingOwnedPages: readonly number[] = [],
    existingFreePages: readonly number[] = [],
): void {
    const indexUmapEnd = 2 + indexes.length;
    const lvalCount = columns.filter(c => isLongValueType(c.type)).length;
    const umapNum = indexUmapEnd + lvalCount * 2;

    const umapRowLength = layout.offsetUsageMapStart + layout.usageMapTableByteLength;
    const umapSpaceUsage = umapRowLength + layout.sizeRowLocation;

    let page: Buffer | null = null;
    let curUmapPage = 0;
    let freeSpace = 0;
    let rowStart = 0;
    let umapRowNum = 0;

    for (let i = 0; i < umapNum; i++) {
        if (page === null) {
            if (curUmapPage === 0) {
                curUmapPage = umapPageNumber;
            } else {
                curUmapPage = channel.allocateNewPage();
            }
            freeSpace = layout.dataPageInitialFreeSpace;
            page = channel.pageAt(curUmapPage);
            page.fill(0);
            page[0] = JET_PAGE_TYPES.DATA;
            page[1] = 0x01;
            page.writeUInt16LE(freeSpace, layout.offsetFreeSpace);
            page.writeUInt16LE(0, layout.offsetNumRowsOnDataPage);
            rowStart = layout.pageSize - umapRowLength;
            umapRowNum = 0;
        }

        page.writeUInt16LE(rowStart, layout.offsetRowStart + layout.sizeRowLocation * umapRowNum);

        if (i === 0) {
            // table "owned pages" map (reference type so it can grow)
            page[rowStart] = 0x01;
            if (existingOwnedPages.length > 0) {
                writeReferenceMapRow(channel, page, rowStart, existingOwnedPages, layout);
            }
        } else if (i === 1) {
            // table "free space pages" map (reference type)
            page[rowStart] = 0x01;
            if (existingFreePages.length > 0) {
                writeReferenceMapRow(channel, page, rowStart, existingFreePages, layout);
            }
        } else if (i < indexUmapEnd) {
            const indexIdx = i - 2;
            const state = indexStates[indexIdx]!;
            state.umapRowNumber = umapRowNum;
            state.umapPageNumber = curUmapPage;
            // retained indexes reuse their existing root pages and owned maps
            const existingIndex = existingIndexes[indexIdx];
            if (existingIndex) {
                state.rootPageNumber = existingIndex.rootPageNumber;
                // reference-type map pointing at the existing owned pages
                writeReferenceMapRow(channel, page, rowStart, existingIndex.ownedPages, layout);
            } else {
                // new index map: inline, starting at the index root page
                const rootPageNumber = channel.allocateNewPage();
                state.rootPageNumber = rootPageNumber;
                page[rowStart] = 0x00;
                page.writeUInt32LE(rootPageNumber, rowStart + 1);
                page[rowStart + 5] = 1; // mark the root page as owned
            }
        } else {
            // long value column maps (inline); both maps on the same page
            page[rowStart] = 0x00;
            page.writeUInt32LE(0, rowStart + 1);
        }

        rowStart -= umapRowLength;
        freeSpace -= umapSpaceUsage;
        umapRowNum++;

        if (freeSpace <= umapSpaceUsage || i === umapNum - 1) {
            page.writeUInt16LE(freeSpace, layout.offsetFreeSpace);
            page.writeUInt16LE(umapRowNum, layout.offsetNumRowsOnDataPage);
            page = null;
        }
    }
}

/**
 * Writes a reference-type usage map row containing the given pages.
 * The reference bytes hold 4-byte usage-map page numbers; each map page
 * stores one bit per page (offset 4 = first bit).
 */
function writeReferenceMapRow(
    channel: JetPageChannel,
    page: Buffer,
    rowStart: number,
    pages: readonly number[],
    layout: JetLayout,
): void {
    page[rowStart] = 0x01; // reference type
    const referenceBytes = layout.usageMapTableByteLength - 1;
    page.fill(0, rowStart + 1, rowStart + 1 + referenceBytes);

    if (pages.length === 0) {
        return;
    }
    const maxPagesPerMapPage = (layout.pageSize - layout.offsetUsageMapPageData) * 8;
    const buckets = new Map<number, number[]>();
    let maxPage = 0;
    for (const pageNumber of pages) {
        if (pageNumber > 0) {
            const bucket = Math.floor(pageNumber / maxPagesPerMapPage);
            const list = buckets.get(bucket) ?? [];
            list.push(pageNumber);
            buckets.set(bucket, list);
            maxPage = Math.max(maxPage, pageNumber);
        }
    }
    const numReferencePages = Math.floor(maxPage / maxPagesPerMapPage) + 1;
    if (numReferencePages > Math.floor(referenceBytes / 4)) {
        throw new AccessFileError('The table usage map reference row is full.');
    }
    let bucketIndex = 0;
    for (const [bucket, bucketPages] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        const mapPageNumber = channel.allocateNewPage();
        const mapPage = channel.pageAt(mapPageNumber);
        mapPage.fill(0);
        mapPage[0] = JET_PAGE_TYPES.USAGE_MAP;
        mapPage[1] = 0x01;
        for (const pageNumber of bucketPages) {
            const relative = pageNumber - bucket * maxPagesPerMapPage;
            const offset = layout.offsetUsageMapPageData + Math.floor(relative / 8);
            if (offset < mapPage.length) {
                mapPage[offset] = (mapPage[offset] ?? 0) | (1 << (relative % 8));
            }
        }
        page.writeUInt32LE(mapPageNumber, rowStart + 1 + bucketIndex * 4);
        bucketIndex++;
    }
    void numReferencePages;
}

function writeTableDefinitionBuffer(
    channel: JetPageChannel,
    buffer: Buffer,
    totalTableDefSize: number,
    tdefPageNumber: number,
    layout: JetLayout,
): void {
    buffer.writeUInt32LE(totalTableDefSize, 8);
    let pos = 0;
    let curPage = tdefPageNumber;
    let nextPage = 0;
    while (pos < totalTableDefSize) {
        const page = channel.pageAt(curPage);
        page.fill(0);
        let used: number;
        if (pos === 0) {
            used = Math.min(layout.pageSize, totalTableDefSize);
            buffer.copy(page, 0, 0, used);
            pos = used;
        } else {
            page[0] = JET_PAGE_TYPES.TABLE_DEF;
            page[1] = 0x01;
            used = Math.min(layout.pageSize - 8, totalTableDefSize - pos);
            buffer.copy(page, 8, pos, pos + used);
            pos += used;
            used += 8;
        }
        if (pos < totalTableDefSize) {
            nextPage = channel.allocateNewPage();
            page.writeUInt32LE(nextPage, 4);
        }
        const freeSpace = Math.max(layout.pageSize - used - 8, 0);
        page.writeUInt16LE(freeSpace, layout.offsetFreeSpace);
        curPage = nextPage;
    }
}

interface CatalogRow {
    readonly name: string;
    readonly id: number;
    readonly parentId: number;
    readonly type: number;
    readonly flags: number;
}

function catalogRows(channel: JetPageChannel, _layout: JetLayout): CatalogRow[] {
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    return catalog.rowLocations()
        .map(location => catalog.readRowValues(location))
        .map(row => ({
            name: String(row[2] ?? ''),
            id: Number(row[0] ?? 0),
            parentId: Number(row[1] ?? 0),
            type: Number(row[3] ?? 0),
            flags: Number(row[7] ?? 0),
        }));
}

function findTablesParentId(channel: JetPageChannel, _layout: JetLayout): number {
    for (const row of catalogRows(channel, _layout)) {
        if (row.name.toLowerCase() === 'tables') {
            return row.id;
        }
    }
    return -1;
}

function findObjectOwner(_channel: JetPageChannel, _layout: JetLayout): Uint8Array {
    return new Uint8Array([0xa6, 0x33]);
}

/**
 * Creates a new table with the given columns and indexes.
 * Returns the new table's definition page number.
 */
export function createTable(
    channel: JetPageChannel,
    name: string,
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[] = [],
    relationships: readonly JetRelationship[] = [],
): number {
    const layout = channel.layout;
    if (!name || name.length === 0) {
        throw new AccessFileError('Table name is required.');
    }
    if (columns.length === 0) {
        throw new AccessFileError('A table must have at least one column.');
    }
    if (catalogRows(channel, layout).some(row => row.name.toLowerCase() === name.toLowerCase())) {
        throw new AccessFileError(`An object named '${name}' already exists.`);
    }
    for (const index of indexes) {
        for (const column of index.columns) {
            if (findColumnNumber(columns, column.name) < 0) {
                throw new AccessFileError(`Index '${index.name}' refers to unknown column '${column.name}'.`);
            }
        }
    }

    const states = buildColumnStates(columns, layout);
    const indexStates: IndexState[] = indexes.map(() => ({ rootPageNumber: 0, umapRowNumber: 0, umapPageNumber: 0 }));

    const tdefPageNumber = channel.allocateNewPage();
    const umapPageNumber = channel.allocateNewPage();

    createUsageMapDefinitionPage(channel, umapPageNumber, columns, indexes, indexStates, layout);

    const totalTableDefSize = calculateTableDefinitionSize(columns, indexes, layout);
    const buffer = Buffer.alloc(Math.max(totalTableDefSize, layout.pageSize));
    writeTableDefinitionHeader(buffer, tdefPageNumber, umapPageNumber, columns, indexes, layout);

    const position = { value: layout.offsetIndexDefBlock };
    for (let index = 0; index < indexes.length; index++) {
        buffer.writeUInt32LE(0, position.value + 4);
        position.value += layout.sizeIndexDefinition;
    }
    writeColumnDefinitions(buffer, position, columns, states, layout);
    if (indexes.length > 0) {
        writeIndexDefinitions(buffer, position, columns, indexes, indexStates, tdefPageNumber, layout, channel);
        writeIndexNames(buffer, position, indexes, layout);
    }
    // column usage map definitions (long-value columns); no LVAL columns are
    // created by this writer, so nothing is written here
    buffer[position.value++] = 0xff;
    buffer[position.value++] = 0xff;

    writeTableDefinitionBuffer(channel, buffer, totalTableDefSize, tdefPageNumber, layout);

    // register in the system catalog
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    const tablesParentId = findTablesParentId(channel, layout);
    const owner = findObjectOwner(channel, layout);
    const values: AccessValue[] = catalog.columns.map(column => {
        switch (column.name.toLowerCase()) {
            case 'id': return tdefPageNumber;
            case 'name': return name;
            case 'type': return TYPE_TABLE;
            case 'parentid': return tablesParentId;
            case 'datecreate':
            case 'dateupdate': return new Date();
            case 'owner': return owner;
            case 'flags': return 0;
            default: return null;
        }
    });
    catalog.addRowWithIndexes(values);
    catalog.writeDefinitionCounters();
    for (const relationship of relationships) {
        addRelationship(channel, relationship);
    }
    return tdefPageNumber;
}

/** Deletes a table (data, index and table-definition pages) and removes it from the catalog. */
export function dropTable(channel: JetPageChannel, name: string): void {
    const layout = channel.layout;
    const tables = catalogRows(channel, layout).filter(row => row.type === TYPE_TABLE);
    const tableRow = tables.find(row => row.name.toLowerCase() === name.toLowerCase())
        ?? (tables.find(row => row.name === name));
    if (!tableRow) {
        throw new AccessFileError(`Table '${name}' does not exist.`);
    }
    const tdefPage = tableRow.id & 0x00ffffff;
    if (tdefPage <= 1) {
        throw new AccessFileError(`Cannot drop table '${name}'.`);
    }

    // remove the catalog row first
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    for (const location of catalog.rowLocations()) {
        const row = catalog.readRowValues(location);
        if (String(row[2] ?? '').toLowerCase() === name.toLowerCase()) {
            catalog.deleteRowWithIndexes(location, row);
            break;
        }
    }

    // deallocate data pages
    const table = new JetTable(channel, name, tdefPage);
    for (const pageNumber of table.ownedPages.cursor()) {
        channel.deallocatePage(pageNumber);
    }
    // deallocate index pages
    for (const indexData of table.indexDatas) {
        for (const pageNumber of indexData.ownedPages.cursor()) {
            channel.deallocatePage(pageNumber);
        }
    }
    // deallocate LVAL pages
    for (const pageNumber of table.longValuePages) {
        channel.deallocatePage(pageNumber);
    }
    // deallocate the table definition page chain
    let current = tdefPage;
    while (current !== 0) {
        const page = channel.pageAt(current);
        const next = page.readUInt32LE(4);
        channel.deallocatePage(current);
        current = next;
    }
}

/**
 * Adds an index to an existing table.  A replacement table definition is
 * written with the new index included; the new B-tree is populated from the
 * existing rows and the old definition page is deallocated.
 */
export function addIndex(channel: JetPageChannel, tableName: string, index: JetDdlIndex): void {
    const table = findTable(channel, tableName);
    if (!table) {
        throw new AccessFileError(`Table '${tableName}' does not exist.`);
    }
    const existingNames = new Set(indexNamesFor(table));
    if (existingNames.has(index.name.toLowerCase())) {
        throw new AccessFileError(`Index '${index.name}' already exists on table '${tableName}'.`);
    }
    for (const column of index.columns) {
        if (findColumnNumber(table.columns, column.name) < 0) {
            throw new AccessFileError(`Index '${index.name}' refers to unknown column '${column.name}'.`);
        }
    }

    const columns: JetDdlColumn[] = table.columns.map(column => ({
        name: column.name,
        type: column.type,
        length: column.size,
        precision: column.precision,
        scale: column.scale,
        notNull: !column.variable,
        autoNumber: column.autoLong || column.autoUuid,
    }));
    const names = indexNamesFor(table);
    const indexes: JetDdlIndex[] = [
        ...table.indexDatas.map((data, i) => indexFromData(data, table, names[i] ?? `idx${data.number}`)),
        index,
    ];
    recreateTableDefinition(channel, tableName, table.definitionPage, columns, indexes, table.rowCount, table.nextAutoNumber);

    // populate the new index B-tree from the existing rows
    const replacement = findTable(channel, tableName)!;
    const newIndexData = replacement.indexDatas[replacement.indexDatas.length - 1]!;
    for (const location of replacement.rowLocations()) {
        const change = newIndexData.prepareAddRow(replacement.readRowValues(location), new JetRowId(location.pageNumber, location.rowNumber));
        if (change) {
            change.commit();
        }
    }
    replacement.writeDefinitionCounters();
}

/** Removes an index from an existing table. */
export function dropIndex(channel: JetPageChannel, tableName: string, indexName: string): void {
    const table = findTable(channel, tableName);
    if (!table) {
        throw new AccessFileError(`Table '${tableName}' does not exist.`);
    }
    const names = indexNamesFor(table);
    const target = table.indexDatas.find((_data, i) => (names[i] ?? `idx${_data.number}`).toLowerCase() === indexName.toLowerCase());
    if (!target) {
        throw new AccessFileError(`Index '${indexName}' does not exist on table '${tableName}'.`);
    }
    if (target.backingPrimaryKey) {
        throw new AccessFileError(`Cannot drop the primary key of table '${tableName}'.`);
    }

    const columns: JetDdlColumn[] = table.columns.map(column => ({
        name: column.name,
        type: column.type,
        length: column.size,
        precision: column.precision,
        scale: column.scale,
        notNull: !column.variable,
        autoNumber: column.autoLong || column.autoUuid,
    }));
    const indexes: JetDdlIndex[] = [];
    for (let i = 0; i < table.indexDatas.length; i++) {
        const data = table.indexDatas[i]!;
        const name = names[i] ?? `idx${data.number}`;
        if (name.toLowerCase() !== indexName.toLowerCase()) {
            indexes.push(indexFromData(data, table, name));
        }
    }
    recreateTableDefinition(channel, tableName, table.definitionPage, columns, indexes, table.rowCount, table.nextAutoNumber);
}

/** Foreign-key relationship attributes (DAO RelationshipAttribute values). */
const RELATIONSHIP_ENFORCED = 0x01;
const RELATIONSHIP_UPDATE_CASCADE = 0x08;
const RELATIONSHIP_DELETE_CASCADE = 0x10;

export interface JetRelationship {
    readonly name: string;
    readonly table: string;
    readonly columns: readonly string[];
    readonly foreignTable: string;
    readonly foreignColumns: readonly string[];
    readonly enforced?: boolean;
    readonly updateCascade?: boolean;
    readonly deleteCascade?: boolean;
}

/**
 * Creates a foreign-key relationship: writes MSysRelationships rows (one per
 * referenced column, matching the ACE layout) and ensures an index exists on
 * the referencing columns.
 */
export function addRelationship(channel: JetPageChannel, relationship: JetRelationship): void {
    const child = findTable(channel, relationship.table);
    if (!child) {
        throw new AccessFileError(`Table '${relationship.table}' does not exist.`);
    }
    const parent = findTable(channel, relationship.foreignTable);
    if (!parent) {
        throw new AccessFileError(`Referenced table '${relationship.foreignTable}' does not exist.`);
    }
    if (relationship.columns.length === 0 || relationship.columns.length !== relationship.foreignColumns.length) {
        throw new AccessFileError('A relationship must pair each column with a referenced column.');
    }
    for (const column of relationship.columns) {
        if (findColumnNumber(child.columns, column) < 0) {
            throw new AccessFileError(`Relationship '${relationship.name}' refers to unknown column '${column}'.`);
        }
    }
    for (const column of relationship.foreignColumns) {
        if (findColumnNumber(parent.columns, column) < 0) {
            throw new AccessFileError(`Relationship '${relationship.name}' refers to unknown column '${column}' in '${relationship.foreignTable}'.`);
        }
    }
    if (listRelationships(channel).some(existing => existing.name.toLowerCase() === relationship.name.toLowerCase())) {
        throw new AccessFileError(`A relationship named '${relationship.name}' already exists.`);
    }

    // Access maintains an index on the referencing columns for each
    // relationship; create it when no index already covers the same columns.
    const hasCoveringIndex = indexNamesFor(child).some((_name, index) => {
        const data = child.indexDatas[index];
        if (!data || data.columns.length !== relationship.columns.length) {
            return false;
        }
        return relationship.columns.every((columnName, slot) => {
            const descriptor = data.columns[slot];
            const column = child.columns.find(candidate => candidate.columnNumber === descriptor?.columnNumber);
            return column?.name.toLowerCase() === columnName.toLowerCase();
        });
    });
    if (!hasCoveringIndex) {
        addIndex(channel, relationship.table, {
            name: relationship.name,
            columns: relationship.columns.map(name => ({ name, ascending: true })),
        });
    }

    const relationshipsTable = new JetTable(channel, 'MSysRelationships', systemTablePage(channel, 'MSysRelationships'));
    const grbit = (relationship.enforced === false ? 0 : RELATIONSHIP_ENFORCED)
        | (relationship.updateCascade ? RELATIONSHIP_UPDATE_CASCADE : 0)
        | (relationship.deleteCascade ? RELATIONSHIP_DELETE_CASCADE : 0);
    for (let columnIndex = 0; columnIndex < relationship.columns.length; columnIndex++) {
        const row: AccessValue[] = relationshipsTable.columns.map(column => {
            switch (column.name.toLowerCase()) {
                case 'szrelationship': return relationship.name;
                case 'grbit': return grbit;
                case 'ccolumn': return relationship.columns.length;
                case 'icolumn': return columnIndex;
                case 'szobject': return relationship.table;
                case 'szcolumn': return relationship.columns[columnIndex];
                case 'szreferencedobject': return relationship.foreignTable;
                case 'szreferencedcolumn': return relationship.foreignColumns[columnIndex];
                default: return null;
            }
        });
        relationshipsTable.addRowWithIndexes(row);
    }
    relationshipsTable.writeDefinitionCounters();
}

/** Removes a foreign-key relationship from MSysRelationships. */
export function dropRelationship(channel: JetPageChannel, relationshipName: string): void {
    const relationshipsTable = new JetTable(channel, 'MSysRelationships', systemTablePage(channel, 'MSysRelationships'));
    let removed = false;
    for (const location of relationshipsTable.rowLocations()) {
        const row = relationshipsTable.readRowValues(location);
        if (String(row[0] ?? '').toLowerCase() === relationshipName.toLowerCase()) {
            relationshipsTable.deleteRowWithIndexes(location, row);
            removed = true;
        }
    }
    if (!removed) {
        throw new AccessFileError(`Relationship '${relationshipName}' does not exist.`);
    }
    relationshipsTable.writeDefinitionCounters();
}

interface RelationshipRow {
    readonly name: string;
    readonly table: string;
    readonly columns: readonly string[];
    readonly foreignTable: string;
    readonly foreignColumns: readonly string[];
}

function listRelationships(channel: JetPageChannel): RelationshipRow[] {
    let rows: ReturnType<JetTable['readRowValues']>[];
    try {
        const relationshipsTable = new JetTable(channel, 'MSysRelationships', systemTablePage(channel, 'MSysRelationships'));
        rows = relationshipsTable.rowLocations().map(location => relationshipsTable.readRowValues(location));
    } catch {
        return [];
    }
    const grouped = new Map<string, { table: string; columns: string[]; foreignTable: string; foreignColumns: string[] }>();
    for (const row of rows) {
        const name = String(row[0] ?? '');
        if (!name) continue;
        const table = String(row[4] ?? '');
        const column = String(row[5] ?? '');
        const foreignTable = String(row[6] ?? '');
        const foreignColumn = String(row[7] ?? '');
        const existing = grouped.get(name);
        if (existing) {
            existing.columns.push(column);
            existing.foreignColumns.push(foreignColumn);
            continue;
        }
        grouped.set(name, {
            table,
            columns: [column],
            foreignTable,
            foreignColumns: [foreignColumn],
        });
    }
    return Array.from(grouped.entries()).map(([name, relationship]) => ({
        name,
        table: relationship.table,
        columns: relationship.columns,
        foreignTable: relationship.foreignTable,
        foreignColumns: relationship.foreignColumns,
    }));
}

function systemTablePage(channel: JetPageChannel, name: string): number {
    const rows = catalogRows(channel, channel.layout);
    const match = rows.find(row => row.name.toLowerCase() === name.toLowerCase());
    if (!match) {
        throw new AccessFileError(`System table '${name}' is not present in the database.`);
    }
    return match.id & 0x00ffffff;
}

function indexNamesFor(table: JetTable): string[] {
    const names = table.indexNames();
    return table.indexDatas.map((data, index) => names[index] ?? `idx${data.number}`);
}

function indexFromData(data: JetIndexData, table: JetTable, name: string): JetDdlIndex {
    const columns = data.columns.map(descriptor => {
        const column = table.columns.find(candidate => candidate.columnNumber === descriptor.columnNumber);
        return {
            name: column?.name ?? `col${descriptor.columnNumber}`,
            ascending: descriptor.isAscending,
        };
    });
    return {
        name,
        columns,
        primaryKey: data.backingPrimaryKey,
        unique: data.isUnique,
        ignoreNulls: data.shouldIgnoreNulls,
        required: data.isRequired,
    };
}

/**
 * Writes a replacement table definition for existing data.  The row pages
 * and retained index B-trees are referenced in place; only the definition
 * page is replaced (the old one is deallocated).
 */
function recreateTableDefinition(
    channel: JetPageChannel,
    name: string,
    oldTdefPage: number,
    columns: readonly JetDdlColumn[],
    indexes: readonly JetDdlIndex[],
    rowCount: number,
    nextAutoNumber: number,
): void {
    const layout = channel.layout;
    const states = buildColumnStates(columns, layout);
    const oldTable = new JetTable(channel, name, oldTdefPage);

    // map retained indexes (by name) to their existing B-tree state
    const oldNames = oldTable.indexNames();
    const existingByName = new Map<string, ExistingIndexDefinition>();
    for (let i = 0; i < oldTable.indexDatas.length; i++) {
        const data = oldTable.indexDatas[i]!;
        existingByName.set((oldNames[i] ?? `idx${data.number}`).toLowerCase(), {
            rootPageNumber: data.rootPageNumber,
            ownedPages: [...data.ownedPages.cursor()],
        });
    }
    const existingIndexes: (ExistingIndexDefinition | null)[] = indexes.map(index => {
        return existingByName.get(index.name.toLowerCase()) ?? null;
    });

    const indexStates: IndexState[] = indexes.map(() => ({ rootPageNumber: 0, umapRowNumber: 0, umapPageNumber: 0 }));

    const tdefPageNumber = channel.allocateNewPage();
    const umapPageNumber = channel.allocateNewPage();
    createUsageMapDefinitionPage(
        channel,
        umapPageNumber,
        columns,
        indexes,
        indexStates,
        layout,
        existingIndexes,
        [...oldTable.ownedPages.cursor()],
        [...oldTable.freeSpacePages.cursor()],
    );

    const totalTableDefSize = calculateTableDefinitionSize(columns, indexes, layout);
    const buffer = Buffer.alloc(Math.max(totalTableDefSize, layout.pageSize));
    writeTableDefinitionHeader(buffer, tdefPageNumber, umapPageNumber, columns, indexes, layout, rowCount, nextAutoNumber);

    const position = { value: layout.offsetIndexDefBlock };
    for (let index = 0; index < indexes.length; index++) {
        const existing = existingIndexes[index];
        buffer.writeUInt32LE(existing ? oldUniqueCountFor(oldTable, index) : 0, position.value + 4);
        position.value += layout.sizeIndexDefinition;
    }
    writeColumnDefinitions(buffer, position, columns, states, layout);
    if (indexes.length > 0) {
        writeIndexDefinitions(buffer, position, columns, indexes, indexStates, tdefPageNumber, layout, channel);
        writeIndexNames(buffer, position, indexes, layout);
    }
    buffer[position.value++] = 0xff;
    buffer[position.value++] = 0xff;
    writeTableDefinitionBuffer(channel, buffer, totalTableDefSize, tdefPageNumber, layout);

    // retarget data pages and retained index pages to the new definition
    for (const pageNumber of oldTable.ownedPages.cursor()) {
        const page = channel.pageAt(pageNumber);
        page.writeUInt32LE(tdefPageNumber, 4);
    }
    for (const indexData of oldTable.indexDatas) {
        for (const pageNumber of indexData.ownedPages.cursor()) {
            const page = channel.pageAt(pageNumber);
            page.writeUInt32LE(tdefPageNumber, 4);
        }
    }

    // deallocate the old table-definition page and its usage-map page
    const oldDef = channel.pageAt(oldTdefPage);
    const ownedRefPage = (oldDef[layout.offsetOwnedPages + 1] ?? 0)
        | ((oldDef[layout.offsetOwnedPages + 2] ?? 0) << 8)
        | ((oldDef[layout.offsetOwnedPages + 3] ?? 0) << 16);
    channel.deallocatePage(oldTdefPage);
    if (ownedRefPage > 1 && ownedRefPage !== tdefPageNumber && ownedRefPage !== umapPageNumber) {
        channel.deallocatePage(ownedRefPage);
    }

    // update the catalog row's Id (the object id of a table is its tdef page)
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    for (const location of catalog.rowLocations()) {
        const row = catalog.readRowValues(location);
        if (String(row[2] ?? '').toLowerCase() === name.toLowerCase()) {
            const values = [...row];
            values[0] = tdefPageNumber;
            catalog.updateRowWithIndexes(location, row, values);
            break;
        }
    }
}

function oldUniqueCountFor(table: JetTable, indexNumber: number): number {
    return table.indexDatas[indexNumber]?.uniqueEntryCount ?? 0;
}

function findTable(channel: JetPageChannel, name: string): JetTable | null {
    const layout = channel.layout;
    for (const row of catalogRows(channel, layout)) {
        if (row.type === TYPE_TABLE && row.name.toLowerCase() === name.toLowerCase()) {
            return new JetTable(channel, row.name, row.id & 0x00ffffff);
        }
    }
    return null;
}

// ----------------------------------------------------------------------
// Views (saved SELECT QueryDefs)
// ----------------------------------------------------------------------

const QUERY_ATTRIBUTE_START = 0;
const QUERY_ATTRIBUTE_FLAG = 3;
const QUERY_ATTRIBUTE_TABLE = 5;
const QUERY_ATTRIBUTE_COLUMN = 6;
const QUERY_ATTRIBUTE_WHERE = 8;
const QUERY_ATTRIBUTE_GROUP_BY = 9;
const QUERY_ATTRIBUTE_HAVING = 10;
const QUERY_ATTRIBUTE_ORDER_BY = 11;
const QUERY_ATTRIBUTE_END = 255;

const QUERY_FLAG_SELECT_STAR = 0x01;
const QUERY_FLAG_DISTINCT = 0x02;
const QUERY_FLAG_DISTINCT_ROW = 0x08;
const QUERY_FLAG_TOP = 0x10;

const DEFAULT_ORDER = new Uint8Array([0, 0, 0, 1]);

function splitTopLevel(text: string, separator: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quote) {
            if (c === quote && text[i + 1] === quote) {
                i++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"' || c === '[' || c === ']') {
            if (c === '[') depth++;
            else if (c === ']') depth--;
            else quote = c;
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && c === separator) {
            result.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    result.push(text.slice(start).trim());
    return result;
}

function findTopLevelKeyword(text: string, keyword: string, start: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < text.length; i++) {
        const c = text[i]!;
        if (quote) {
            if (c === quote && text[i + 1] === quote) i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"') {
            quote = c;
            continue;
        }
        if (c === '[') {
            const end = text.indexOf(']', i + 1);
            if (end >= 0) i = end;
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && text.slice(i, i + keyword.length).toUpperCase() === keyword
            && (i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1]!))
            && (i + keyword.length >= text.length || !/[A-Za-z0-9_$]/.test(text[i + keyword.length]!))) {
            return i;
        }
    }
    return -1;
}

interface QueryRowSpec {
    readonly attribute: number;
    readonly order: Uint8Array | null;
    readonly name1: string | null;
    readonly name2: string | null;
    readonly expression: string | null;
    readonly flag: number;
}

function assignOrders(rows: QueryRowSpec[]): QueryRowSpec[] {
    const counters = new Map<number, number>();
    return rows.map(row => {
        if (row.order !== null) {
            return row;
        }
        const current = (counters.get(row.attribute) ?? 0) + 1;
        counters.set(row.attribute, current);
        return {
            ...row,
            order: new Uint8Array([0, 0, (current >> 8) & 0xff, current & 0xff]),
        };
    });
}

function splitAlias(projection: string): { expression: string; alias: string | null } {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < projection.length; i++) {
        const c = projection[i]!;
        if (quote) {
            if (c === quote && projection[i + 1] === quote) i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '[') {
            if (c === '[') {
                const end = projection.indexOf(']', i + 1);
                if (end >= 0) i = end;
            } else {
                quote = c;
            }
            continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && projection.slice(i, i + 5).toUpperCase() === ' AS ' && i + 5 <= projection.length) {
            return {
                expression: projection.slice(0, i).trim(),
                alias: projection.slice(i + 4).trim(),
            };
        }
    }
    return { expression: projection.trim(), alias: null };
}

/**
 * Parses a conservative SELECT statement into the MSysQueries row
 * representation (port of QueryDefWriter.Parse).
 */
export function parseQueryDefSql(sql: string): QueryRowSpec[] {
    let input = sql.trim();
    while (input.endsWith(';')) {
        input = input.slice(0, -1).trimEnd();
    }
    if (input.length === 0) {
        throw new AccessFileError('CREATE VIEW requires a SELECT query.');
    }
    const rows: QueryRowSpec[] = [{ attribute: QUERY_ATTRIBUTE_START, order: null, name1: null, name2: null, expression: null, flag: 0 }];
    const statement = input;
    if (statement.toUpperCase().startsWith('PARAMETERS')) {
        throw new AccessFileError('CREATE VIEW does not support PARAMETERS clauses.');
    }
    if (!statement.toUpperCase().startsWith('SELECT')) {
        throw new AccessFileError('Only SELECT QueryDef definitions are supported.');
    }

    const selectStart = statement.indexOf('SELECT') + 6;
    const from = findTopLevelKeyword(statement, 'FROM', selectStart);
    const where = findTopLevelKeyword(statement, 'WHERE', from < 0 ? selectStart : from + 4);
    const groupBy = findTopLevelKeyword(statement, 'GROUP BY', from < 0 ? selectStart : from + 4);
    const having = findTopLevelKeyword(statement, 'HAVING', groupBy < 0 ? (from < 0 ? selectStart : from + 4) : groupBy + 8);
    const orderBy = findTopLevelKeyword(statement, 'ORDER BY',
        having >= 0 ? having + 6 : groupBy >= 0 ? groupBy + 8 : where >= 0 ? where + 5 : from >= 0 ? from + 4 : selectStart);

    const selectEnd = from >= 0 ? from : statement.length;
    let selectPart = statement.slice(selectStart, selectEnd).trim();
    let selectFlags = 0;
    let topValue: string | null = null;
    if (selectPart.toUpperCase().startsWith('DISTINCTROW')) {
        selectFlags |= QUERY_FLAG_DISTINCT_ROW;
        selectPart = selectPart.slice(11).trimStart();
    } else if (selectPart.toUpperCase().startsWith('DISTINCT')) {
        selectFlags |= QUERY_FLAG_DISTINCT;
        selectPart = selectPart.slice(8).trimStart();
    }
    if (selectPart.toUpperCase().startsWith('TOP')) {
        const afterTop = selectPart.slice(3).trimStart();
        const numberEnd = afterTop.search(/[^0-9]/);
        const top = numberEnd < 0 ? afterTop : afterTop.slice(0, numberEnd);
        if (!/^\d+$/.test(top)) {
            throw new AccessFileError('CREATE VIEW supports only numeric TOP values.');
        }
        topValue = top;
        selectFlags |= QUERY_FLAG_TOP;
        selectPart = (numberEnd < 0 ? '' : afterTop.slice(numberEnd)).trimStart();
        if (selectPart.toUpperCase().startsWith('PERCENT')) {
            throw new AccessFileError('TOP PERCENT is not supported.');
        }
    }
    if (selectPart.length === 0) {
        throw new AccessFileError('SELECT must contain at least one projection.');
    }
    if (selectPart === '*') {
        selectFlags |= QUERY_FLAG_SELECT_STAR;
    } else {
        for (const projection of splitTopLevel(selectPart, ',')) {
            if (projection.length === 0) {
                throw new AccessFileError('SELECT contains an empty projection.');
            }
            const { expression, alias } = splitAlias(projection);
            rows.push({ attribute: QUERY_ATTRIBUTE_COLUMN, order: null, name1: alias, name2: null, expression, flag: 0 });
        }
    }
    if (selectFlags !== 0) {
        rows.push({ attribute: QUERY_ATTRIBUTE_FLAG, order: null, name1: topValue, name2: null, expression: null, flag: selectFlags });
    }

    if (from >= 0) {
        const fromEnd = [where, groupBy, having, orderBy, statement.length]
            .filter(v => v >= 0)
            .reduce((min, v) => Math.min(min, v), statement.length);
        const fromPart = statement.slice(from + 4, fromEnd).trim();
        if (fromPart.length === 0) {
            throw new AccessFileError('FROM requires at least one table source.');
        }
        const sources = splitTopLevel(fromPart, ',');
        for (let index = 0; index < sources.length; index++) {
            const source = sources[index]!;
            const parts = source.split(/\s+/);
            if (parts.length === 0 || parts[0]!.length === 0) {
                continue;
            }
            let tableName = parts[0]!;
            if (tableName.startsWith('[') && tableName.endsWith(']')) {
                tableName = tableName.slice(1, -1).replace(/]]/g, ']');
            }
            const rest = source.slice(parts[0]!.length).trim();
            let alias: string | null = null;
            if (/^AS\s+/i.test(rest)) {
                alias = rest.replace(/^AS\s+/i, '').trim();
            } else if (rest.length > 0 && !rest.includes(' ')) {
                alias = rest.trim();
            }
            rows.push({ attribute: QUERY_ATTRIBUTE_TABLE, order: null, name1: tableName, name2: alias, expression: null, flag: 0 });
        }
    }

    if (where >= 0) {
        const end = [groupBy, having, orderBy, statement.length].filter(v => v >= 0).reduce((min, v) => Math.min(min, v), statement.length);
        rows.push({ attribute: QUERY_ATTRIBUTE_WHERE, order: null, name1: null, name2: null, expression: statement.slice(where + 5, end).trim(), flag: 0 });
    }
    if (groupBy >= 0) {
        const end = [having, orderBy, statement.length].filter(v => v >= 0).reduce((min, v) => Math.min(min, v), statement.length);
        for (const expression of splitTopLevel(statement.slice(groupBy + 8, end), ',')) {
            rows.push({ attribute: QUERY_ATTRIBUTE_GROUP_BY, order: null, name1: null, name2: null, expression: expression.trim(), flag: 0 });
        }
    }
    if (having >= 0) {
        const end = [orderBy, statement.length].filter(v => v >= 0).reduce((min, v) => Math.min(min, v), statement.length);
        rows.push({ attribute: QUERY_ATTRIBUTE_HAVING, order: null, name1: null, name2: null, expression: statement.slice(having + 6, end).trim(), flag: 0 });
    }
    if (orderBy >= 0) {
        for (let expression of splitTopLevel(statement.slice(orderBy + 8), ',')) {
            expression = expression.trim();
            let direction: string | null = null;
            if (expression.toUpperCase().endsWith(' DESC')) {
                direction = 'D';
                expression = expression.slice(0, -5).trimEnd();
            } else if (expression.toUpperCase().endsWith(' ASC')) {
                direction = 'A';
                expression = expression.slice(0, -4).trimEnd();
            }
            rows.push({ attribute: QUERY_ATTRIBUTE_ORDER_BY, order: null, name1: direction, name2: null, expression, flag: 0 });
        }
    }
    rows.push({ attribute: QUERY_ATTRIBUTE_END, order: null, name1: null, name2: null, expression: null, flag: 0 });
    return assignOrders(rows);
}

/** Allocates a negative query object id that is not already in use. */
function allocateQueryObjectId(channel: JetPageChannel, layout: JetLayout): number {
    const used = new Set(catalogRows(channel, layout).map(row => row.id));
    for (let candidate = -2147483647; candidate < 0; candidate++) {
        if (!used.has(candidate)) {
            return candidate;
        }
    }
    throw new AccessFileError('The database has no free QueryDef object id.');
}

/** Creates a saved SELECT QueryDef (view) in the catalog. */
export function createView(channel: JetPageChannel, viewName: string, selectSql: string): void {
    const layout = channel.layout;
    if (!viewName || catalogRows(channel, layout).some(row => row.name.toLowerCase() === viewName.toLowerCase())) {
        throw new AccessFileError(`An object named '${viewName}' already exists.`);
    }
    const specification = parseQueryDefSql(selectSql);
    const objectId = allocateQueryObjectId(channel, layout);

    // register in MSysObjects
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    const tablesParentId = findTablesParentId(channel, layout);
    const owner = findObjectOwner(channel, layout);
    const catalogValues: AccessValue[] = catalog.columns.map(column => {
        switch (column.name.toLowerCase()) {
            case 'id': return objectId;
            case 'name': return viewName;
            case 'type': return 5; // query
            case 'parentid': return tablesParentId;
            case 'datecreate':
            case 'dateupdate': return new Date();
            case 'owner': return owner;
            case 'flags': return 0;
            default: return null;
        }
    });
    catalog.addRowWithIndexes(catalogValues);

    // write MSysQueries rows
    const queries = new JetTable(channel, 'MSysQueries', 4);
    for (const row of specification) {
        const values: AccessValue[] = queries.columns.map(column => {
            switch (column.name.toLowerCase()) {
                case 'objectid': return objectId;
                case 'attribute': return row.attribute;
                case 'order': return row.order ?? DEFAULT_ORDER;
                case 'name1': return row.name1;
                case 'name2': return row.name2;
                case 'expression': return row.expression;
                case 'flag': return row.flag;
                default: return null;
            }
        });
        queries.addRowWithIndexes(values);
    }
    catalog.writeDefinitionCounters();
    queries.writeDefinitionCounters();
}

/** Drops a saved SELECT QueryDef (view) from the catalog. */
export function dropView(channel: JetPageChannel, viewName: string): void {
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    let objectId: number | null = null;
    for (const location of catalog.rowLocations()) {
        const row = catalog.readRowValues(location);
        if (String(row[2] ?? '').toLowerCase() === viewName.toLowerCase() && Number(row[3]) === 5) {
            objectId = Number(row[0]);
            catalog.deleteRowWithIndexes(location, row);
            break;
        }
    }
    if (objectId === null) {
        throw new AccessFileError(`View '${viewName}' does not exist.`);
    }

    const queries = new JetTable(channel, 'MSysQueries', 4);
    for (const location of queries.rowLocations()) {
        const row = queries.readRowValues(location);
        if (Number(row[0]) === objectId) {
            queries.deleteRowWithIndexes(location, row);
        }
    }
    catalog.writeDefinitionCounters();
    queries.writeDefinitionCounters();
}

export { catalogRows };
export type { CatalogRow };
