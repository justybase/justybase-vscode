/**
 * Webview-local copies of host message contracts.
 * Keeps `tsc --project tsconfig.media.json` from pulling src/export into the graph.
 */

export type ResultPanelExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';

export type ResultPanelExecutionState =
    | 'idle'
    | 'loading'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'retrying';

export interface SelectionStatsPayload {
    cellCount: number;
    type: 'numeric' | 'date' | 'text' | 'mixed';
    count?: number;
    distinctCount?: number;
    sum?: number;
    min?: string | number;
    max?: string | number;
}

/** Subset of webview → host commands used by migrated TS modules. */
export type ResultPanelWebviewToHostMessage =
    | { command: 'focusView' }
    | { command: 'logRowsApplied'; sourceUri: string; executionTimestamp: number; totalRows: number }
    | { command: 'requestLogSync'; sourceUri: string; executionTimestamp?: number; currentRows: number }
    | { command: 'describeWithCopilot'; data: unknown[]; sql: string }
    | { command: 'closeResult'; sourceUri: string; resultSetIndex: number }
    | { command: 'closeAllResults'; sourceUri: string }
    | { command: 'switchResultSet'; sourceUri: string; resultSetIndex: number }
    | { command: 'pinResult'; sourceUri: string; resultSetIndex: number }
    | { command: 'selectionStats'; stats: SelectionStatsPayload }
    | { command: string; [key: string]: unknown };

/** Host → webview messages (cast at boundary). */
export type ResultPanelHostToWebviewMessage = Record<string, unknown>;
