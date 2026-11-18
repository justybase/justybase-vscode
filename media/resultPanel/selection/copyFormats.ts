/**
 * Legacy facade for the shared typed clipboard formats.
 *
 * The implementation lives in `@justybase/ui-core` so the shared React grid
 * and the DOM grid cannot drift on JSON/SQL INSERT/SQL IN-list output.
 */
export {
    formatCellsAsInList,
    formatCellsAsInsert,
    formatCellsAsJson,
    INSERT_TARGET_PLACEHOLDER,
    insertTargetName,
} from '@justybase/ui-core';
export type { CopyFormatCell, CopyFormatTarget } from '@justybase/ui-core';
