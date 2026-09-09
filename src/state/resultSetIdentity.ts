import {
    createResultSetId as createSharedResultSetId,
    ensureResultSetId as ensureSharedResultSetId,
} from '@justybase/result-core';

/**
 * Compatibility facade for the desktop result identity API.
 *
 * Generation and non-mutating identity rules live in result-core. Existing
 * desktop call sites intentionally retain their historical in-place ensure
 * semantics, so this adapter copies the shared result back into its input.
 */
export const createResultSetId = createSharedResultSetId;

export function ensureResultSetId<T extends { resultSetId?: string }>(resultSet: T): T {
    const ensured = ensureSharedResultSetId(resultSet);
    if (ensured !== resultSet) {
        Object.assign(resultSet, ensured);
    }
    return resultSet;
}
