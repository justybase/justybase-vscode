/**
 * Jet file-format layout constants for the direct-mutation writer
 * (port of the JetFormat table from JustyBase.UCanAccessCs, which itself
 * is a port of Jackcess JetFormat).
 *
 * Only the constants needed to read and mutate existing tables are
 * included; index writing is Phase 1.
 */

import type { AccessFileFormat } from '../types';

export const JET_PAGE_TYPES = {
    INVALID: 0x00,
    DATA: 0x01,
    TABLE_DEF: 0x02,
    INDEX_NODE: 0x03,
    INDEX_LEAF: 0x04,
    USAGE_MAP: 0x05,
} as const;

/** row start/end offset mask (strip deleted/overflow flags) */
export const OFFSET_MASK = 0x1fff;
/** row is deleted */
export const DELETED_ROW_MASK = 0x8000;
/** row data has been relocated to another page/row (overflow pointer) */
export const OVERFLOW_ROW_MASK = 0x4000;
/** unknown value used for "no page" */
export const INVALID_PAGE_NUMBER = 0;

export interface JetLayout {
    readonly pageSize: number;
    readonly sizeRowLocation: number;
    readonly offsetRowStart: number;
    readonly offsetFreeSpace: number;
    readonly offsetNumRowsOnDataPage: number;
    readonly dataPageInitialFreeSpace: number;
    readonly maxNumRowsOnDataPage: number;
    readonly maxRowSize: number;

    readonly offsetNumRows: number;
    readonly offsetNextAutoNumber: number;
    readonly offsetMaxCols: number;
    readonly offsetNumVarCols: number;
    readonly offsetNumCols: number;
    readonly offsetNumIndexSlots: number;
    readonly offsetNumIndexes: number;
    readonly offsetOwnedPages: number;
    readonly offsetFreeSpacePages: number;
    readonly offsetIndexDefBlock: number;
    readonly sizeIndexDefinition: number;

    readonly sizeColumnHeader: number;
    readonly offsetColumnType: number;
    readonly offsetColumnNumber: number;
    readonly offsetColumnVariableTableIndex: number;
    readonly offsetColumnFlags: number;
    readonly offsetColumnLength: number;
    readonly offsetColumnFixedDataOffset: number;
    readonly offsetColumnPrecision: number;
    readonly offsetColumnScale: number;
    readonly sizeNameLength: number;

    readonly sizeRowColumnCount: number;
    readonly sizeRowVarColOffset: number;

    readonly offsetUsageMapStart: number;
    readonly offsetUsageMapPageData: number;
    readonly offsetReferenceMapPageNumbers: number;
    readonly usageMapTableByteLength: number;

    readonly sizeLongValueDef: number;
    readonly maxInlineLongValueSize: number;
    readonly maxLongValueRowSize: number;

    readonly sizeIndexColumnBlock: number;
    readonly sizeIndexInfoBlock: number;
    readonly offsetIndexCompressedByteCount: number;
    readonly offsetIndexEntryMask: number;
    readonly sizeIndexEntryMask: number;
    readonly offsetPrevIndexPage: number;
    readonly offsetNextIndexPage: number;
    readonly offsetChildTailIndexPage: number;
    readonly skipBeforeIndexFlags: number;
    readonly skipAfterIndexFlags: number;
    readonly skipBeforeIndexSlot: number;
    readonly skipAfterIndexSlot: number;
    readonly skipBeforeIndex: number;
    readonly skipAfterIndex: number;
    readonly offsetColumnSortOrder: number;
    readonly sizeSortOrder: number;

    readonly utf16: boolean;
}

function jet4Layout(pageSize = 4096): JetLayout {
    return {
        pageSize,
        sizeRowLocation: 2,
        offsetRowStart: 14,
        offsetFreeSpace: 2,
        offsetNumRowsOnDataPage: 12,
        dataPageInitialFreeSpace: pageSize - 14,
        maxNumRowsOnDataPage: 255,
        maxRowSize: 4060,

        offsetNumRows: 16,
        offsetNextAutoNumber: 20,
        offsetMaxCols: 41,
        offsetNumVarCols: 43,
        offsetNumCols: 45,
        offsetNumIndexSlots: 47,
        offsetNumIndexes: 51,
        offsetOwnedPages: 55,
        offsetFreeSpacePages: 59,
        offsetIndexDefBlock: 63,
        sizeIndexDefinition: 12,

        sizeColumnHeader: 25,
        offsetColumnType: 0,
        offsetColumnNumber: 5,
        offsetColumnVariableTableIndex: 7,
        offsetColumnFlags: 15,
        offsetColumnLength: 23,
        offsetColumnFixedDataOffset: 21,
        offsetColumnPrecision: 11,
        offsetColumnScale: 12,
        sizeNameLength: 2,

        sizeRowColumnCount: 2,
        sizeRowVarColOffset: 2,

        offsetUsageMapStart: 5,
        offsetUsageMapPageData: 4,
        offsetReferenceMapPageNumbers: 1,
        usageMapTableByteLength: 64,

        sizeLongValueDef: 12,
        maxInlineLongValueSize: 64,
        maxLongValueRowSize: 4076,

        sizeIndexColumnBlock: 52,
        sizeIndexInfoBlock: 28,
        offsetIndexCompressedByteCount: 24,
        offsetIndexEntryMask: 27,
        sizeIndexEntryMask: 453,
        offsetPrevIndexPage: 12,
        offsetNextIndexPage: 16,
        offsetChildTailIndexPage: 20,
        skipBeforeIndexFlags: 4,
        skipAfterIndexFlags: 5,
        skipBeforeIndexSlot: 4,
        skipAfterIndexSlot: 4,
        skipBeforeIndex: 4,
        skipAfterIndex: 0,
        offsetColumnSortOrder: 11,
        sizeSortOrder: 4,

        utf16: true,
    };
}

function jet3Layout(pageSize = 2048): JetLayout {
    return {
        pageSize,
        sizeRowLocation: 2,
        offsetRowStart: 10,
        offsetFreeSpace: 2,
        offsetNumRowsOnDataPage: 8,
        dataPageInitialFreeSpace: pageSize - 14,
        maxNumRowsOnDataPage: 255,
        maxRowSize: 2012,

        offsetNumRows: 12,
        offsetNextAutoNumber: 20,
        offsetMaxCols: 21,
        offsetNumVarCols: 23,
        offsetNumCols: 25,
        offsetNumIndexSlots: 27,
        offsetNumIndexes: 31,
        offsetOwnedPages: 35,
        offsetFreeSpacePages: 39,
        offsetIndexDefBlock: 43,
        sizeIndexDefinition: 8,

        sizeColumnHeader: 18,
        offsetColumnType: 0,
        offsetColumnNumber: 1,
        offsetColumnVariableTableIndex: 3,
        offsetColumnFlags: 13,
        offsetColumnLength: 16,
        offsetColumnFixedDataOffset: 14,
        offsetColumnPrecision: 11,
        offsetColumnScale: 12,
        sizeNameLength: 1,

        sizeRowColumnCount: 1,
        sizeRowVarColOffset: 1,

        offsetUsageMapStart: 5,
        offsetUsageMapPageData: 4,
        offsetReferenceMapPageNumbers: 1,
        usageMapTableByteLength: 128,

        sizeLongValueDef: 12,
        maxInlineLongValueSize: 64,
        maxLongValueRowSize: 2032,

        sizeIndexColumnBlock: 39,
        sizeIndexInfoBlock: 20,
        offsetIndexCompressedByteCount: 20,
        offsetIndexEntryMask: 22,
        sizeIndexEntryMask: 226,
        offsetPrevIndexPage: 8,
        offsetNextIndexPage: 12,
        offsetChildTailIndexPage: 16,
        skipBeforeIndexFlags: 0,
        skipAfterIndexFlags: 0,
        skipBeforeIndexSlot: 0,
        skipAfterIndexSlot: 0,
        skipBeforeIndex: 0,
        skipAfterIndex: 0,
        offsetColumnSortOrder: 9,
        sizeSortOrder: 2,

        utf16: false,
    };
}

export function jetLayoutFor(format: AccessFileFormat): JetLayout {
    if (format === 'jet3') {
        return jet3Layout();
    }
    if (format === 'jet4' || format.startsWith('accdb')) {
        return jet4Layout();
    }
    throw new Error(`Unknown Access file format '${format}'.`);
}

export const LONG_VALUE_TYPES = {
    THIS_PAGE: 0x80,
    OTHER_PAGE: 0x40,
    OTHER_PAGES: 0x00,
} as const;
