/**
 * Stable identities for result data, independent of transport and rendering.
 *
 * Four distinct identity levels exist and must not be conflated:
 *
 * - `SourceId` — the document/editor that produced the execution.
 * - `ExecutionId` — one logical execution of a source.
 * - `ResultSetId` — one result set inside an execution.
 * - `StorageSessionId` — the storage session that holds the data (API
 *   `queryId`/`sessionId`), when the host keeps data outside the renderer.
 *
 * Tab indices, offsets, and timestamps are display/transport hints, not
 * identities: a result moves to another index when Logs or pinned results
 * are added, and two executions can share a millisecond. `resultSetId` is
 * the stable identity preserved across host/webview hydration cycles; a
 * legacy timestamp-only fallback is recognized but never minted here.
 */

/** Identity of the source document/editor that produced the execution. */
export type SourceId = string;

/** Identity of one logical execution of a source. */
export type ExecutionId = string;

/** Stable identity of one result set inside an execution. */
export type ResultSetId = string;

/** Identity of the storage session holding the data (queryId/sessionId). */
export type StorageSessionId = string;

/** Full identity of a result set within its source and execution. */
export interface ResultSetIdentity {
  readonly sourceId: SourceId;
  readonly executionId: ExecutionId;
  readonly resultSetId: ResultSetId;
  readonly statementIndex: number;
  readonly storageSessionId?: StorageSessionId;
}

const RESULT_SET_ID_PREFIX = 'result-set-';

let sequence = 0;

/**
 * Creates a stable result-set id. The timestamp is only a collision guard,
 * never the identity; the monotonic sequence keeps ids unique within a
 * process even when two executions share a millisecond.
 */
export function createResultSetId(): ResultSetId {
  sequence += 1;
  return `${RESULT_SET_ID_PREFIX}${Date.now().toString(36)}-${sequence.toString(36)}`;
}

/** Assigns a stable id when a result set was produced without one. */
export function ensureResultSetId<T extends object>(
  resultSet: T & { resultSetId?: ResultSetId },
): T & { resultSetId: ResultSetId } {
  if (resultSet.resultSetId) {
    return resultSet as T & { resultSetId: ResultSetId };
  }
  return { ...resultSet, resultSetId: createResultSetId() } as T & { resultSetId: ResultSetId };
}

/** True when the id comes from the legacy timestamp-only identity scheme. */
export function isLegacyTimestampIdentity(id: ResultSetId): boolean {
  return !id.startsWith(RESULT_SET_ID_PREFIX);
}

/** Order-preserving key that scopes a result set to its source. */
export function resultSetKey(identity: Pick<ResultSetIdentity, 'sourceId' | 'resultSetId'>): string {
  return `${identity.sourceId}\u0000${identity.resultSetId}`;
}
