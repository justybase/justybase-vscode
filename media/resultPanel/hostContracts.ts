/**
 * Webview-local copies of host message contracts.
 * Keeps `tsc --project tsconfig.media.json` from pulling src/export into the graph.
 */

export type ResultPanelExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';

export type ResultPanelExecutionState =
    | 'idle'
    | 'loading'
    | 'finalizing'
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

export interface SelectionStatsCalculatingPayload {
    state: 'calculating';
}

export interface ResultPanelTraceEventPayload {
    phase: string;
    sourceUri?: string;
    command?: string;
    resultSetIndex?: number;
    resultSetCount?: number;
    rowCount?: number;
    totalRows?: number;
    isLog?: boolean;
    isFirstChunk?: boolean;
    isLastChunk?: boolean;
    visible?: boolean;
    ready?: boolean;
    viewportWidth?: number;
    viewportHeight?: number;
    scrollTop?: number;
    reason?: string;
    delivered?: boolean;
    error?: string;
    webviewSeq?: number;
}

export type SelectionStatsUpdatePayload = SelectionStatsPayload | SelectionStatsCalculatingPayload;

/** Subset of webview → host commands used by migrated TS modules. */
export type ResultPanelWebviewToHostMessage =
    | { command: 'focusView' }
    | { command: 'logRowsApplied'; sourceUri: string; executionTimestamp: number; totalRows: number }
    | { command: 'requestLogSync'; sourceUri: string; executionTimestamp?: number; currentRows: number }
    | { command: 'requestResultSync'; sourceUri: string; reason: string }
    | { command: 'describeWithCopilot'; data: unknown[]; sql: string }
    | { command: 'closeResult'; sourceUri: string; resultSetIndex: number }
    | { command: 'closeAllResults'; sourceUri: string }
    | { command: 'switchResultSet'; sourceUri: string; resultSetIndex: number }
    | { command: 'pinResult'; sourceUri: string; resultSetIndex: number }
    | { command: 'selectionStats'; stats: SelectionStatsPayload }
    | { command: 'reportResultPanelTrace'; event: ResultPanelTraceEventPayload }
    | {
        command: 'reportUxPerf';
        event: {
            op: string;
            phase: string;
            traceId?: string;
            durationMs?: number;
            doc?: { uri?: string; chars?: number; lines?: number; ver?: number };
            meta?: Record<string, string | number | boolean | null>;
        };
    }
    | { command: string; [key: string]: unknown };

/** Host → webview messages (cast at boundary). */
export type ResultPanelHostToWebviewMessage = Record<string, unknown>;
