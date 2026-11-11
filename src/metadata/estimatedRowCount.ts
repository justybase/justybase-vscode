/**
 * Helpers for catalog row-count estimates.
 *
 * Netezza exposes `RELTUPLES` on `_V_TABLE`: an optimizer estimate, not an
 * exact `COUNT(*)`. Keep the value rounded and never show negative sentinels
 * (an unanalyzed relation can report a negative value).
 */

export function normalizeEstimatedRowCount(value: unknown): number | undefined {
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < 0) {
        return undefined;
    }
    return Math.round(numeric);
}

export function formatEstimatedRowCount(value: number): string {
    return `~${Math.max(0, Math.round(value)).toLocaleString('en-US')}`;
}

/**
 * Appends the catalog row estimate to a completion detail line, e.g.
 * `Table (ADMIN) · ~18,484 rows`. Keeping this next to the object type makes
 * the estimate visible in the suggestion list without opening documentation.
 */
export function appendEstimatedRowCount(
    detail: string | undefined,
    rowCount: number | undefined,
): string | undefined {
    const normalized = normalizeEstimatedRowCount(rowCount);
    if (normalized === undefined) {
        return detail;
    }
    const rows = `${formatEstimatedRowCount(normalized)} rows`;
    return detail ? `${detail} · ${rows}` : rows;
}
