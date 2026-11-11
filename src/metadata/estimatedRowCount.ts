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
