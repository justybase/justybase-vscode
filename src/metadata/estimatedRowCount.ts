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
        : typeof value === 'bigint'
            // Drivers that map Netezza's int8 to BigInt must not lose the
            // estimate: Number() converts it, and the value is approximate anyway.
            ? Number(value)
            : typeof value === 'string' && value.trim() !== ''
                ? Number(value)
                : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < 0) {
        return undefined;
    }
    return Math.round(numeric);
}

export function formatEstimatedRowCount(value: number): string {
    const rounded = Math.max(0, Math.round(value));
    if (rounded >= 1_000_000) {
        return `~${Math.round(rounded / 1_000_000)}m`;
    }
    if (rounded >= 1_000) {
        const thousands = Math.round(rounded / 1_000);
        return thousands >= 1_000
            ? `~${Math.round(rounded / 1_000_000)}m`
            : `~${thousands}k`;
    }
    return `~${rounded}`;
}

/**
 * Appends the catalog row estimate to a completion detail line, e.g.
 * `Table (ADMIN) · ~18k rows`. Keeping this next to the object type makes
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

/**
 * Carries a previously known estimate into refreshed rows that do not report one.
 *
 * `_V_TABLE.RELTUPLES` is `NULL` while the optimizer has no statistics, and
 * several refresh paths do not select the column at all (generic type-group
 * queries, mirrored system catalog reads, external-only passes). Because the
 * table cache treats a refresh as authoritative for a known identity, such a
 * row would silently remove the `~4k rows` hint from the schema tree and from
 * suggestions. Keeping the last known estimate by identity makes the hint
 * stable across refreshes while still letting a real estimate replace it.
 */
export function carryForwardRowCounts<T extends { rowCount?: number }>(
    previous: readonly T[],
    next: readonly T[],
    getIdentity: (value: T) => string | undefined,
): T[] {
    if (previous.length === 0 || next.length === 0) {
        return next as T[];
    }

    const previousByIdentity = new Map<string, number>();
    for (const row of previous) {
        if (row.rowCount === undefined) {
            continue;
        }
        const identity = getIdentity(row);
        if (identity !== undefined) {
            previousByIdentity.set(identity, row.rowCount);
        }
    }
    if (previousByIdentity.size === 0) {
        return next as T[];
    }

    let carried = false;
    const rows = next.map((row) => {
        if (row.rowCount !== undefined) {
            return row;
        }
        const identity = getIdentity(row);
        const previousRowCount = identity === undefined
            ? undefined
            : previousByIdentity.get(identity);
        if (previousRowCount === undefined) {
            return row;
        }
        carried = true;
        return { ...row, rowCount: previousRowCount };
    });
    return carried ? rows : (next as T[]);
}
