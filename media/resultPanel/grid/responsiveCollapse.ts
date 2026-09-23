export interface ResponsiveColumnCandidate {
    id: string;
    width: number;
    pinned?: boolean;
}

export interface ResponsiveCollapseOptions {
    enabled: boolean;
    grouped: boolean;
    viewportWidth: number;
    rowNumberWidth: number;
    columns: ResponsiveColumnCandidate[];
}

/**
 * Picks the rightmost unpinned columns to move into row details until the
 * remaining table fits. Keeps at least one regular data column visible and
 * leaves any remaining overflow to the grid's horizontal scroller.
 */
export function getResponsiveHiddenColumnIds(options: ResponsiveCollapseOptions): string[] {
    const { enabled, grouped, viewportWidth, rowNumberWidth, columns } = options;
    if (!enabled || grouped || !Number.isFinite(viewportWidth) || viewportWidth <= 0 || columns.length === 0) {
        return [];
    }

    const widths = columns.map(column => Number.isFinite(column.width) && column.width > 0
        ? column.width
        : 1);
    let totalWidth = Math.max(0, Number.isFinite(rowNumberWidth) ? rowNumberWidth : 0)
        + widths.reduce((sum, width) => sum + width, 0);
    let remainingRegularColumns = columns.reduce((count, column) => count + (column.pinned ? 0 : 1), 0);
    const hidden = new Set<string>();

    for (let index = columns.length - 1; index >= 0 && totalWidth > viewportWidth; index -= 1) {
        const column = columns[index];
        if (column.pinned || remainingRegularColumns <= 1) {
            continue;
        }
        hidden.add(column.id);
        totalWidth -= widths[index];
        remainingRegularColumns -= 1;
    }

    return columns.filter(column => hidden.has(column.id)).map(column => column.id);
}

/** Combines a data row and its optional responsive detail row into one virtual item. */
export function calculateResponsiveVirtualItemSize(
    dataRowHeight: number,
    detailsRowHeight: number,
    minimumEstimate: number,
): number {
    const dataHeight = Number.isFinite(dataRowHeight) && dataRowHeight > 0 ? dataRowHeight : 0;
    const detailsHeight = Number.isFinite(detailsRowHeight) && detailsRowHeight > 0 ? detailsRowHeight : 0;
    const minimum = Number.isFinite(minimumEstimate) && minimumEstimate > 0 ? minimumEstimate : 1;
    return Math.max(minimum, dataHeight + detailsHeight);
}
