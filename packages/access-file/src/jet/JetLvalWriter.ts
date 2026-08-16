/**
 * Long-value (MEMO/OLE) writer (port of Column.WriteLongValue and the
 * long-value readers from JustyBase.UCanAccessCs / Jackcess).
 *
 * A long value is stored as a 12-byte definition in the variable-length
 * data of the row:
 *   bytes 0-3   length with the type bits in the top byte
 *   bytes 4-7   inline data (type THIS_PAGE) or first (row, page) reference
 *   bytes 8-11  unused
 *
 * Type THIS_PAGE (0x80) keeps the value inline when it fits next to the
 * 12-byte header.  Type OTHER_PAGE (0x40) stores the value as a single row
 * on a dedicated LVAL data page.  Type OTHER_PAGES (0x00) stores the value
 * across a chain of LVAL rows; each row starts with a 4-byte next
 * (row, page) reference followed by a chunk.
 */

import { AccessFileError } from '../accessFileSession';
import { LONG_VALUE_TYPES, OFFSET_MASK } from './JetLayout';
import type { JetPageChannel } from './JetPageChannel';

const LONG_VALUE_TYPE_MASK = 0xc0000000;
const LONG_VALUE_LENGTH_MASK = 0x3fffffff;

export function longValueType(def: Buffer): number {
    return (def.readUInt32LE(0) & LONG_VALUE_TYPE_MASK) >>> 24;
}

export function longValueLength(def: Buffer): number {
    return def.readUInt32LE(0) & LONG_VALUE_LENGTH_MASK;
}

function writePageNumber(buffer: Buffer, offset: number, pageNumber: number): void {
    buffer[offset] = pageNumber & 0xff;
    buffer[offset + 1] = (pageNumber >> 8) & 0xff;
    buffer[offset + 2] = (pageNumber >> 16) & 0xff;
}

function rowData(channel: JetPageChannel, pageNumber: number, rowNumber: number): Buffer {
    const layout = channel.layout;
    const page = channel.pageAt(pageNumber);
    const start = page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * rowNumber) & OFFSET_MASK;
    const end = rowNumber === 0
        ? layout.pageSize
        : page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * (rowNumber - 1)) & OFFSET_MASK;
    if (start < 0 || end < start || end > layout.pageSize) {
        throw new AccessFileError('Invalid long-value row location.');
    }
    return page.subarray(start, end);
}

/** Returns all LVAL pages referenced by an external long-value definition. */
export function longValuePageNumbers(def: Buffer, channel: JetPageChannel): number[] {
    const length = longValueLength(def);
    const type = longValueType(def);
    if (type === LONG_VALUE_TYPES.THIS_PAGE || length === 0) {
        return [];
    }

    let row = def[4] ?? 0;
    let page = (def[5] ?? 0) | ((def[6] ?? 0) << 8) | ((def[7] ?? 0) << 16);
    if (page <= 0) {
        throw new AccessFileError('Long-value definition has no first page.');
    }
    if (type === LONG_VALUE_TYPES.OTHER_PAGE) {
        return [page];
    }

    const pages: number[] = [];
    const visited = new Set<string>();
    let remaining = length;
    while (remaining > 0 && page > 0) {
        const key = `${page}:${row}`;
        if (visited.has(key)) {
            throw new AccessFileError(`Cyclic long-value chain at page ${page}, row ${row}.`);
        }
        visited.add(key);
        pages.push(page);
        const data = rowData(channel, page, row);
        if (data.length <= 4) {
            break;
        }
        const chunkLength = data.length - 4;
        remaining -= chunkLength;
        row = data[0] ?? 0;
        page = (data[1] ?? 0) | ((data[2] ?? 0) << 8) | ((data[3] ?? 0) << 16);
    }
    if (remaining > 0) {
        throw new AccessFileError('Long-value chain ended before its declared length.');
    }
    return pages;
}

/**
 * Reads the bytes stored by an LVAL definition (used to preserve the value
 * of an unchanged MEMO/OLE column during an update).
 */
export function readLongValueBytes(
    def: Buffer,
    channel: JetPageChannel,
): Buffer {
    const layout = channel.layout;
    const length = longValueLength(def);
    const type = longValueType(def);
    if (type === LONG_VALUE_TYPES.THIS_PAGE) {
        return Buffer.from(def.subarray(layout.sizeLongValueDef, layout.sizeLongValueDef + length));
    }
    if (length === 0) {
        return Buffer.alloc(0);
    }

    const firstRow = def[4] ?? 0;
    const firstPage = (def[5] ?? 0) | ((def[6] ?? 0) << 8) | ((def[7] ?? 0) << 16);
    if (type === LONG_VALUE_TYPES.OTHER_PAGE) {
        const data = rowData(channel, firstPage, firstRow);
        return Buffer.from(data.subarray(0, Math.min(length, data.length)));
    }

    const result = Buffer.alloc(length);
    let offset = 0;
    let row = firstRow;
    let page = firstPage;
    while (offset < length && page > 0) {
        const data = rowData(channel, page, row);
        if (data.length <= 4) {
            break;
        }
        row = data[0] ?? 0;
        page = (data[1] ?? 0) | ((data[2] ?? 0) << 8) | ((data[3] ?? 0) << 16);
        const chunk = data.subarray(4);
        chunk.copy(result, offset, 0, Math.min(chunk.length, length - offset));
        offset += chunk.length;
    }
    return result.subarray(0, offset);
}

/** Appends a row to an LVAL data page and returns the row start offset. */
function appendRowToLvalPage(
    channel: JetPageChannel,
    page: Buffer,
    rowSize: number,
): { rowNumber: number; rowStart: number } {
    const layout = channel.layout;
    const freeSpace = page.readUInt16LE(layout.offsetFreeSpace);
    const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
    const rowSpaceUsage = rowSize + layout.sizeRowLocation;
    if (rowSpaceUsage > freeSpace || rowCount >= layout.maxNumRowsOnDataPage) {
        throw new AccessFileError('Long-value page has no free space for a chain row.');
    }
    page.writeUInt16LE(freeSpace - rowSpaceUsage, layout.offsetFreeSpace);
    page.writeUInt16LE(rowCount + 1, layout.offsetNumRowsOnDataPage);
    const end = rowCount === 0
        ? layout.pageSize
        : page.readUInt16LE(layout.offsetRowStart + layout.sizeRowLocation * (rowCount - 1)) & OFFSET_MASK;
    const rowStart = end - rowSize;
    page.writeUInt16LE(rowStart, layout.offsetRowStart + layout.sizeRowLocation * rowCount);
    return { rowNumber: rowCount, rowStart };
}

/**
 * Writes a long value, returning the LVAL definition bytes.  Long-value
 * pages are allocated through the channel and reported to the table so it
 * can keep its long-value page set consistent.
 */
export function writeLongValue(
    value: Buffer,
    remainingRowLength: number,
    channel: JetPageChannel,
    registerLongValuePage: (pageNumber: number) => void,
): Buffer {
    const layout = channel.layout;
    if (value.length > 0x3fffffff) {
        throw new AccessFileError(`Long value is too large (${value.length} bytes).`);
    }

    let type: number;
    let defLength = layout.sizeLongValueDef;
    if (layout.sizeLongValueDef + value.length <= remainingRowLength
        && value.length <= layout.maxInlineLongValueSize) {
        type = LONG_VALUE_TYPES.THIS_PAGE;
        defLength += value.length;
    } else if (value.length <= layout.maxLongValueRowSize) {
        type = LONG_VALUE_TYPES.OTHER_PAGE;
    } else {
        type = LONG_VALUE_TYPES.OTHER_PAGES;
    }

    const def = Buffer.alloc(defLength);
    def.writeUInt32LE((value.length | (type << 24)) >>> 0, 0);

    if (type === LONG_VALUE_TYPES.THIS_PAGE) {
        value.copy(def, layout.sizeLongValueDef, 0, value.length);
        return def;
    }

    if (type === LONG_VALUE_TYPES.OTHER_PAGE) {
        const page = channel.newLongValuePage();
        registerLongValuePage(page.pageNumber);
        const { rowNumber, rowStart } = appendRowToLvalPage(channel, page.buffer, value.length);
        value.copy(page.buffer, rowStart, 0, value.length);
        def[4] = rowNumber;
        writePageNumber(def, 5, page.pageNumber);
        return def;
    }

    // OTHER_PAGES: chain of rows, each holding a 4-byte next reference + chunk
    let currentPage = channel.newLongValuePage();
    registerLongValuePage(currentPage.pageNumber);
    const firstPageNumber = currentPage.pageNumber;
    const firstRowNumber = 0;
    let remaining = value.length;
    let valueOffset = 0;
    while (remaining > 0) {
        const chunkLength = Math.min(layout.maxLongValueRowSize - 4, remaining);
        let nextPage: Buffer | undefined;
        let nextPageNumber = 0;
        if (chunkLength < remaining) {
            const allocated = channel.newLongValuePage();
            registerLongValuePage(allocated.pageNumber);
            nextPage = allocated.buffer;
            nextPageNumber = allocated.pageNumber;
        }
        const { rowStart } = appendRowToLvalPage(
            channel,
            currentPage.buffer,
            chunkLength + 4,
        );
        currentPage.buffer[rowStart] = 0; // next row number
        writePageNumber(currentPage.buffer, rowStart + 1, nextPageNumber);
        value.copy(currentPage.buffer, rowStart + 4, valueOffset, valueOffset + chunkLength);
        valueOffset += chunkLength;
        remaining -= chunkLength;
        if (nextPage) {
            currentPage = { pageNumber: nextPageNumber, buffer: nextPage };
        }
    }

    def[4] = firstRowNumber;
    writePageNumber(def, 5, firstPageNumber);
    return def;
}
