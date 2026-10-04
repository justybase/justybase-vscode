/** Optional third log-row field; legacy two-column transcripts remain readable. */
export interface ExecutionLogDetails {
    executionId: string;
    event: 'start' | 'end' | 'message';
    status?: 'running' | 'success' | 'error' | 'cancelled' | 'retrying';
    sql?: string;
    connectionName?: string;
    durationMs?: number;
    rowCount?: number;
}
