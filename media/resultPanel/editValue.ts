/**
 * Legacy facade for the shared typed cell-editing parser.
 *
 * The implementation lives in `@justybase/ui-core` so the React grid and the
 * DOM grid validate edits and preserve high-precision decimals identically.
 */
export {
    editValuesEqual,
    isBooleanEditType,
    isDateOnlyEditType,
    isNumericEditType,
    parseTypedEditValue,
    resolveGridCellEditKind,
    toEditableCellText,
} from '@justybase/ui-core';
export type { GridCellEditKind, TypedEditResult } from '@justybase/ui-core';
