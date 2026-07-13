import type { HistoryFilter, QueryParameter } from '../../core/queryHistoryManager';
import type { ConnectionDetails } from '../../core/connectionManager';
import type { DiskDistinctValue, DiskQuerySpec } from '../../core/resultDataProvider/types';
import type { ExcelExportMetadata, ExportMetadata } from '../../export/exportManager';
import type { DatabaseAggregationRequest, DatabaseAggregationResult } from '../../results/databaseAggregationSql';
import type { ResultFormattingPayload, ResultFormattingUpdateRequest } from '../../results/resultFormattingTypes';

export type ResultPanelExportFormat = 'csv' | 'json' | 'xml' | 'sql' | 'markdown';
export type ResultPanelExportRowScope = 'loaded' | 'all';

// ============================================================================
// Result Panel — Inbound (Webview → Extension Host)
// ============================================================================

export type ResultPanelInboundMessage =
    | { command: 'ready' }
    | { command: 'logRowsApplied'; sourceUri: string; executionTimestamp: number; totalRows: number }
    | { command: 'requestLogSync'; sourceUri: string; executionTimestamp?: number; currentRows: number }
    | { command: 'reportHydrationMetrics'; metrics: ResultPanelHydrationMetricsPayload }
    | { command: 'describeWithCopilot'; data: unknown; sql?: string }
    | { command: 'fixSqlError'; errorMessage: string; sql: string }
    | { command: 'initiateExport'; data: ExportMetadata }
    | {
        command: 'initiateExportWithSelection';
        data: ExportMetadata;
        format: string;
        destination: string;
        rowScope?: ResultPanelExportRowScope;
      }
    | { command: 'queryLocallyDuckDB'; data: ExportMetadata }
    | { command: 'exportCsv'; data: string | ExportMetadata }
    | { command: 'openInExcel'; data: unknown; sql?: string }
    | { command: 'copyAsExcel'; data: unknown; sql?: string }
    | { command: 'openInExcelXlsx'; data: unknown; sql?: string }
    | { command: 'exportAllResultSetsToExcel'; data: ExcelExportMetadata }
    | { command: 'exportJson'; data: string | ExportMetadata }
    | { command: 'exportXml'; data: string | ExportMetadata }
    | { command: 'exportSqlInsert'; data: string | ExportMetadata }
    | { command: 'exportMarkdown'; data: string | ExportMetadata }
    | {
        command: 'exportToMdFile';
        data: { sourceUri: string; mdDocument: string; resultSetIndices?: number[]; rowScope?: ResultPanelExportRowScope };
      }
    | {
        command: 'export';
        format: ResultPanelExportFormat;
        sourceUri: string;
        resultSetIndex: number;
        rowIndices?: number[];
        columnIds?: string[];
    }
    | { command: 'switchSource'; sourceUri: string }
    | { command: 'togglePin'; sourceUri: string }
    | { command: 'toggleResultPin'; sourceUri: string; resultSetIndex: number }
    | { command: 'switchToPinnedResult'; resultId: string }
    | { command: 'unpinResult'; resultId: string }
    | { command: 'closeSource'; sourceUri: string }
    | { command: 'closeResult'; sourceUri: string; resultSetIndex: number }
    | { command: 'refreshResult'; sourceUri: string; resultSetIndex: number; limitValue?: string }
    | { command: 'clearRefreshFailure'; sourceUri: string; resultSetIndex: number }
    | { command: 'requestDatabaseAggregations'; sourceUri: string; resultSetIndex: number; requestId: number; aggregations: DatabaseAggregationRequest[]; timeoutSeconds?: number; isRetry?: boolean }
    | { command: 'requestDatabaseFilterValues'; sourceUri: string; resultSetIndex: number; columnIndex: number; requestId: number; querySpec?: DiskQuerySpec; timeoutSeconds?: number; isRetry?: boolean }
    | { command: 'applyDatabaseFilter'; sourceUri: string; resultSetIndex: number; requestId: number; querySpec?: DiskQuerySpec; timeoutSeconds?: number; isRetry?: boolean }
    | { command: 'closeAllResults'; sourceUri: string }
    | { command: 'cancelQuery'; sourceUri: string; currentRowCounts?: number[] }
    | { command: 'copyToClipboard'; text: string }
    | { command: 'info'; text: string }
    | { command: 'error'; text: string }
    | { command: 'focusView' }
    | { command: 'setContext'; key: string; value: unknown }
    | { command: 'clearLogs'; sourceUri: string }
    | { command: 'switchResultSet'; sourceUri: string; resultSetIndex: number }
    | { command: 'selectionStatsChanged'; stats: SelectionStatsUpdatePayload | null }
    | { command: 'insertCellContent'; text: string; dataType?: string; sqlText?: string }
    | ({ command: 'updateResultFormatting' } & ResultFormattingUpdateRequest)
    | { command: 'saveEdits'; sourceUri: string; resultSetIndex: number; editSource: unknown; edits: unknown[]; deleteRowIndices?: number[] }
    | { command: 'updateGridFontFamily'; fontFamily: string }
    | { command: 'updateGridFontSize'; fontSize: number };

/** Selection statistics sent from the webview grid */
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

export type SelectionStatsUpdatePayload = SelectionStatsPayload | SelectionStatsCalculatingPayload;

export interface ResultPanelHydrationMetricsPayload {
    durationMs: number;
    payloadBytes?: number;
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
    executionState: 'idle' | 'loading' | 'success' | 'error' | 'cancelled' | 'retrying';
}

// ============================================================================
// Result Panel — Outbound (Extension Host → Webview)
// ============================================================================

export type ResultPanelOutboundMessage =
    | { command: 'hydrate'; data: ResultPanelViewData }
    | {
        command: 'setActiveSource';
        sourceUri: string;
        activeResultSetIndex: number;
        executingSourcesJson: string;
        sourcesJson: string;
        pinnedSourcesJson: string;
        formatSettings?: ResultFormattingPayload;
        diskBackedStreamCapEnabled?: boolean;
    }
    | { command: 'saveScrollState' }
    | { command: 'refreshView' }
    | { command: 'copySelection'; copyFormat?: 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon' }
    | { command: 'updateCopyFormat'; copyFormat: 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon' }
    | {
        command: 'cancelExecution';
        sourceUri: string;
    }
    | {
        command: 'appendRows';
        sourceUri?: string;
        resultSetIndex: number;
        rows: Uint8Array | unknown[][];
        totalRows: number;
        isLastChunk: boolean;
        limitReached: boolean;
        isLog?: boolean;
        fromRow?: number;
        logExecutionTimestamp?: number;
        isFirstChunk?: boolean;
        columns?: { name: string; type?: string; scale?: number }[];
        sql?: string;
        refreshSql?: string;
        executionTimestamp?: number;
        diskBackedStreamCapEnabled?: boolean;
    }
    | {
        command: 'streamingComplete';
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        limitReached: boolean;
    }
    | { command: 'switchToResultSet'; resultSetIndex: number }
    | { command: 'resultFormattingState'; data: ResultFormattingPayload }
    | { command: 'selectAll'; selected: boolean }
    | { command: 'databaseAggregationResult'; sourceUri: string; resultSetIndex: number; requestId: number; aggregations?: DatabaseAggregationResult[]; error?: string }
    | { command: 'databaseFilterValuesResult'; sourceUri: string; resultSetIndex: number; columnIndex: number; requestId: number; values?: DiskDistinctValue[]; truncated?: boolean; error?: string }
    | { command: 'databaseFilterApplyResult'; sourceUri: string; resultSetIndex: number; requestId: number; error?: string }
    | { command: 'saveEdits'; sourceUri: string; resultSetIndex: number; editSource: unknown; edits: unknown[]; deleteRowIndices?: number[] };

/** Shape of the full hydrate payload sent to the result panel webview */
export interface ResultPanelViewData {
    sourcesJson: string;
    pinnedSourcesJson: string;
    pinnedResultsJson: string;
    activeSourceJson: string;
    resultSetsMsgPack: Uint8Array;
    activeResultSetIndex: number;
    executingSourcesJson: string;
    formatSettings: ResultFormattingPayload;
    queryRowLimit: number;
    maxDataResults: number;
    diskBackedStreamCapEnabled: boolean;
    dataVersion?: number;
}

// ============================================================================
// Query History — Inbound (Webview → Extension Host)
// Discriminant field: `type`
// ============================================================================

export type QueryHistoryInboundMessage =
    | { type: 'refresh' }
    | { type: 'loadMore' }
    | { type: 'searchArchive'; term: string }
    | { type: 'search'; term: string }
    | { type: 'clearAll' }
    | { type: 'deleteEntry'; id: string; query?: string }
    | { type: 'copyQuery'; query: string }
    | { type: 'executeQuery'; query: string }
    | { type: 'getHistory' }
    | { type: 'toggleFavorite'; id: string }
    | { type: 'updateEntry'; id: string; tags?: string; description?: string }
    | { type: 'requestEdit'; id: string }
    | { type: 'requestTagFilter'; tags: string[] }
    | { type: 'showFavoritesOnly' }
    | { type: 'filterByTag'; tag: string }
    | { type: 'showExtendedView' }
    | { type: 'exportHistory' }
    | { type: 'getSavedViews' }
    | { type: 'saveView'; name: string; filter: HistoryFilter; description?: string }
    | { type: 'deleteView'; viewId: string }
    | { type: 'applyView'; viewId: string }
    | { type: 'parseQueryParameters'; query: string }
    | { type: 'quickRerun'; queryId: string; parameters: QueryParameter[] };

// ============================================================================
// Query History — Outbound (Extension Host → Webview)
// ============================================================================

export type QueryHistoryOutboundMessage =
    | { type: 'historyData'; history: unknown[]; stats: unknown; reset?: boolean; filter?: string }
    | { type: 'searchResults'; history: unknown[]; stats: unknown; term: string; source?: string }
    | { type: 'archiveSearchResults'; history: unknown[]; stats: unknown; term: string }
    | { type: 'entryDeleted'; id: string }
    | { type: 'updateStats'; stats: unknown }
    | { type: 'debug'; msg?: string }
    | { type: 'savedViewsData'; views: unknown[] }
    | { type: 'viewSaved'; view: unknown }
    | { type: 'viewDeleted'; viewId: string }
    | { type: 'queryParameters'; parameters: unknown[] };

// ============================================================================
// Session Monitor — Inbound (Webview → Extension Host)
// ============================================================================

export type SessionMonitorInboundMessage =
    | { command: 'refresh' }
    | { command: 'killSession'; sessionId: number }
    | { command: 'toggleAutoRefresh'; enabled: boolean }
    | { command: 'updateAlertSettings'; settings: Partial<SessionMonitorAlertSettings> };

/** Alert threshold settings from the session monitor UI */
export interface SessionMonitorAlertSettings {
    enabled: boolean;
    sessionThreshold: number;
    queryThreshold: number;
    hostCpuThreshold: number;
    spuCpuThreshold: number;
    memoryThreshold: number;
}

// ============================================================================
// Session Monitor — Outbound (Extension Host → Webview)
// ============================================================================

export type SessionMonitorOutboundMessage =
    | { command: 'setLoading'; loading: boolean }
    | { command: 'updateData'; data: SessionMonitorData }
    | { command: 'error'; text: string };

/** Full data payload sent from the session monitor backend */
export interface SessionMonitorData {
    sessions: unknown[];
    queries: unknown[];
    storage: unknown[];
    resources: unknown;
    overview: unknown;
    alertSettings: SessionMonitorAlertSettings;
    alerts: unknown[];
    refreshedAt: string;
}

// ============================================================================
// Login Panel — Inbound (Webview → Extension Host)
// ============================================================================

export type LoginPanelConnectionDraft = Partial<ConnectionDetails>;

export type LoginPanelInboundMessage =
    | {
        command: 'save';
        data: LoginPanelConnectionDraft;
        originalName?: string;
        passwordChanged?: boolean;
    }
    | {
        command: 'test';
        data: LoginPanelConnectionDraft;
        originalName?: string;
        passwordChanged?: boolean;
    }
    | { command: 'delete'; name: string }
    | { command: 'loadConnections' };

// ============================================================================
// Login Panel — Outbound (Extension Host → Webview)
// ============================================================================

export type LoginPanelOutboundMessage = {
    command: 'updateConnections';
    connections: ConnectionDetails[];
    activeName: string | undefined;
};

export const RESULT_PANEL_INBOUND_COMMANDS = [
    'ready',
    'logRowsApplied',
    'requestLogSync',
    'reportHydrationMetrics',
    'describeWithCopilot',
    'fixSqlError',
    'initiateExport',
    'initiateExportWithSelection',
    'queryLocallyDuckDB',
    'exportCsv',
    'openInExcel',
    'copyAsExcel',
    'openInExcelXlsx',
    'exportAllResultSetsToExcel',
    'exportJson',
    'exportXml',
    'exportSqlInsert',
    'exportMarkdown',
    'exportToMdFile',
    'export',
    'switchSource',
    'togglePin',
    'toggleResultPin',
    'switchToPinnedResult',
    'unpinResult',
    'closeSource',
    'closeResult',
    'refreshResult',
    'clearRefreshFailure',
    'requestDatabaseAggregations',
    'requestDatabaseFilterValues',
    'applyDatabaseFilter',
    'closeAllResults',
    'cancelQuery',
    'copyToClipboard',
    'info',
    'error',
    'focusView',
    'setContext',
    'clearLogs',
    'switchResultSet',
    'selectionStatsChanged',
    'insertCellContent',
    'updateResultFormatting',
    'saveEdits',
    'updateGridFontFamily',
    'updateGridFontSize'
] as const satisfies readonly ResultPanelInboundMessage['command'][];

export const RESULT_PANEL_OUTBOUND_COMMANDS = [
    'hydrate',
    'setActiveSource',
    'saveScrollState',
    'refreshView',
    'copySelection',
    'updateCopyFormat',
    'selectAll',
    'cancelExecution',
    'appendRows',
    'streamingComplete',
    'switchToResultSet',
    'resultFormattingState',
    'databaseAggregationResult',
    'databaseFilterValuesResult',
    'databaseFilterApplyResult'
] as const satisfies readonly ResultPanelOutboundMessage['command'][];

export const QUERY_HISTORY_INBOUND_TYPES = [
    'refresh',
    'loadMore',
    'searchArchive',
    'search',
    'clearAll',
    'deleteEntry',
    'copyQuery',
    'executeQuery',
    'getHistory',
    'toggleFavorite',
    'updateEntry',
    'requestEdit',
    'requestTagFilter',
    'showFavoritesOnly',
    'filterByTag',
    'showExtendedView',
    'exportHistory',
    'getSavedViews',
    'saveView',
    'deleteView',
    'applyView',
    'parseQueryParameters',
    'quickRerun'
] as const satisfies readonly QueryHistoryInboundMessage['type'][];

export const QUERY_HISTORY_OUTBOUND_TYPES = [
    'historyData',
    'searchResults',
    'archiveSearchResults',
    'entryDeleted',
    'updateStats',
    'debug',
    'savedViewsData',
    'viewSaved',
    'viewDeleted',
    'queryParameters'
] as const satisfies readonly QueryHistoryOutboundMessage['type'][];

export const SESSION_MONITOR_INBOUND_COMMANDS = [
    'refresh',
    'killSession',
    'toggleAutoRefresh',
    'updateAlertSettings'
] as const satisfies readonly SessionMonitorInboundMessage['command'][];

export const SESSION_MONITOR_OUTBOUND_COMMANDS = [
    'setLoading',
    'updateData',
    'error'
] as const satisfies readonly SessionMonitorOutboundMessage['command'][];

export const LOGIN_PANEL_INBOUND_COMMANDS = [
    'save',
    'test',
    'delete',
    'loadConnections'
] as const satisfies readonly LoginPanelInboundMessage['command'][];

export const LOGIN_PANEL_OUTBOUND_COMMANDS = [
    'updateConnections'
] as const satisfies readonly LoginPanelOutboundMessage['command'][];
