/**
 * Stable identity for a result set across host/webview hydration cycles.
 *
 * Execution timestamps are useful for display and backwards compatibility,
 * but they are not an identity: two executions can share a millisecond and a
 * result can move to another tab index when Logs or pinned results are added.
 */
let sequence = 0;

export function createResultSetId(): string {
    sequence += 1;
    return `result-set-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function ensureResultSetId<T extends { resultSetId?: string }>(resultSet: T): T {
    if (!resultSet.resultSetId) {
        resultSet.resultSetId = createResultSetId();
    }
    return resultSet;
}
