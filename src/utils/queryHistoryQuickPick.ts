import type { QueryHistoryEntry } from '../core/history/types';

export const QUERY_HISTORY_QUICK_PICK_LIMIT = 100;
export const QUERY_HISTORY_QUICK_PICK_LABEL_LIMIT = 80;
export const QUERY_HISTORY_QUICK_PICK_DETAIL_LIMIT = 300;
export const QUERY_HISTORY_QUICK_PICK_DEBOUNCE_MS = 100;

/**
 * First non-empty line of the SQL, truncated for QuickPick labels.
 */
export function firstLineOfSql(sql: string, limit: number = QUERY_HISTORY_QUICK_PICK_LABEL_LIMIT): string {
    const line = sql
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0) ?? '';
    if (!line) {
        return '(empty query)';
    }
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Compact relative timestamp: `18:51` today, `Yesterday`, else `Oct 3` / `Oct 3, 2025`.
 */
export function formatHistoryTime(timestamp: number, now: number = Date.now()): string {
    const entry = new Date(timestamp);
    const current = new Date(now);
    const time = `${String(entry.getHours()).padStart(2, '0')}:${String(entry.getMinutes()).padStart(2, '0')}`;

    const startOfToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
    const startOfEntryDay = new Date(entry.getFullYear(), entry.getMonth(), entry.getDate()).getTime();
    const dayDiff = Math.round((startOfToday - startOfEntryDay) / 86400000);

    if (dayDiff <= 0) {
        return time;
    }
    if (dayDiff === 1) {
        return 'Yesterday';
    }
    const month = entry.toLocaleString('en-US', { month: 'short' });
    const day = entry.getDate();
    if (entry.getFullYear() === current.getFullYear()) {
        return `${month} ${day}`;
    }
    return `${month} ${day}, ${entry.getFullYear()}`;
}

export function toHistoryQuickPickLabel(entry: QueryHistoryEntry): string {
    const line = firstLineOfSql(entry.query);
    return entry.is_favorite ? `$(star-full) ${line}` : line;
}

export function toHistoryQuickPickDescription(entry: QueryHistoryEntry, now?: number): string {
    const parts = [
        formatHistoryTime(entry.timestamp, now),
        entry.connectionName ?? entry.host,
        entry.database,
    ].filter((part): part is string => Boolean(part && part.trim()));
    let description = parts.join(' · ');
    if (entry.status === 'error') {
        description += ' · $(error)';
    } else if (entry.status === 'cancelled') {
        description += ' · $(circle-slash)';
    }
    return description;
}

export function toHistoryQuickPickDetail(entry: QueryHistoryEntry): string {
    return entry.query.slice(0, QUERY_HISTORY_QUICK_PICK_DETAIL_LIMIT);
}

/**
 * Favorites first, then newest. Inputs from the manager are already
 * newest-first; this keeps recency ranking while boosting favorites.
 */
export function rankHistoryEntries(entries: QueryHistoryEntry[]): QueryHistoryEntry[] {
    return [...entries].sort((left, right) => {
        const favoriteBoost = Number(right.is_favorite ?? false) - Number(left.is_favorite ?? false);
        if (favoriteBoost !== 0) {
            return favoriteBoost;
        }
        return right.timestamp - left.timestamp;
    });
}

/**
 * Merge active + archive results, newest first, deduped by id.
 */
export function mergeHistorySearchResults(
    active: QueryHistoryEntry[],
    archive: QueryHistoryEntry[],
): QueryHistoryEntry[] {
    const seen = new Set<string>();
    const merged: QueryHistoryEntry[] = [];
    for (const entry of [...active, ...archive]) {
        if (seen.has(entry.id)) {
            continue;
        }
        seen.add(entry.id);
        merged.push(entry);
    }
    return merged;
}
