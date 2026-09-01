/**
 * Webview-local Result Panel protocol contracts.
 *
 * The desktop contract is intentionally mirrored here instead of importing
 * the VS Code host graph. Message unions are built from finite command maps;
 * an arbitrary `{ command: string }` is not a valid protocol message.
 */

import type {
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskQuerySpec,
} from './types.js';
import type {
    ExploreComposerConfig,
    ExploreFilterModel,
    ExplorePivotConfig,
} from './explore/types.js';

export type ResultPanelExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';
export type ResultPanelExportRowScope = 'loaded' | 'all';

export type ResultPanelExecutionState =
    | 'idle'
    | 'loading'
    | 'finalizing'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'retrying';

export interface ResultPanelHydrationMetricsPayload {
    durationMs: number;
    payloadBytes?: number;
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
    executionState: ResultPanelExecutionState;
}

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
    scrollLeft?: number;
    scrollAnchorIndex?: number;
    firstVisibleRowIndex?: number;
    reason?: string;
    delivered?: boolean;
    error?: string;
    webviewSeq?: number;
}

export type UxPerfMetaValue = string | number | boolean | null;

export interface UxPerfEventPayload {
    op: string;
    phase: string;
    traceId?: string;
    durationMs?: number;
    doc?: { uri?: string; chars?: number; lines?: number; ver?: number };
    meta?: Record<string, UxPerfMetaValue>;
}

export interface ResultPanelViewData {
    sourcesJson: string;
    pinnedSourcesJson: string;
    pinnedResultsJson: string;
    activeSourceJson: string;
    resultSetsMsgPack: Uint8Array;
    activeResultSetIndex: number;
    executingSourcesJson: string;
    formatSettings: unknown;
    queryRowLimit: number;
    maxDataResults: number;
    diskBackedStreamCapEnabled: boolean;
    dataVersion?: number;
    streamingCompletedSourcesJson?: string;
    resultPanelTraceEnabled?: boolean;
    resultSyncVersion?: number;
}

export interface ResultPanelTestBridgeRequest {
    command: 'testBridge';
    requestId: string;
    action: string;
    args?: unknown;
}

export interface ResultPanelTestBridgeResult {
    command: 'testBridgeResult';
    requestId: string;
    action: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

export type ResultFormattingScope = 'global' | 'connection' | 'result' | 'column';

export interface ResultFormattingUpdateRequest {
    sourceUri: string;
    scope: ResultFormattingScope;
    resultSetIndex?: number;
    columnId?: string;
    settings: unknown;
}

type EmptyPayload = Record<never, never>;

interface ResultPanelWebviewToHostMessageMap {
    ready: EmptyPayload;
    migrateResult: { sourceUri: string; resultSetIndex: number };
    logRowsApplied: { sourceUri: string; executionTimestamp: number; totalRows: number };
    requestLogSync: { sourceUri: string; executionTimestamp?: number; currentRows: number };
    requestResultSync: { sourceUri: string; reason: string };
    selectAll: EmptyPayload;
    reportHydrationMetrics: { metrics: ResultPanelHydrationMetricsPayload };
    reportResultPanelTrace: { event: ResultPanelTraceEventPayload };
    testBridgeResult: Omit<ResultPanelTestBridgeResult, 'command'>;
    reportUxPerf: { event: UxPerfEventPayload };
    describeWithCopilot: { data: unknown; sql?: string };
    fixSqlError: { errorMessage: string; sql: string };
    initiateExport: { data: unknown };
    initiateExportWithSelection: {
        data: unknown;
        format: string;
        destination: string;
        rowScope?: ResultPanelExportRowScope;
    };
    queryLocallyDuckDB: { data: unknown };
    exportCsv: { data: string | unknown };
    openInExcel: { data: unknown; sql?: string };
    openInFilePreview: { data: unknown; sql?: string };
    addFileToDataWorkspace: EmptyPayload;
    copyAsExcel: { data: unknown; sql?: string };
    openInExcelXlsx: { data: unknown; sql?: string };
    exportAllResultSetsToExcel: { data: unknown };
    exportJson: { data: string | unknown };
    exportXml: { data: string | unknown };
    exportSqlInsert: { data: string | unknown };
    exportMarkdown: { data: string | unknown };
    exportParquet: { data: string | unknown };
    exportToMdFile: {
        data: { sourceUri: string; mdDocument: string; resultSetIndices?: number[]; rowScope?: ResultPanelExportRowScope };
    };
    export: {
        format: ResultPanelExportFormat;
        sourceUri: string;
        resultSetIndex: number;
        rowIndices?: number[];
        columnIds?: string[];
        destination?: string;
    };
    switchSource: { sourceUri: string };
    togglePin: { sourceUri: string };
    toggleResultPin: { sourceUri: string; resultSetIndex: number };
    switchToPinnedResult: { resultId: string };
    unpinResult: { resultId: string };
    closeSource: { sourceUri: string };
    closeResult: { sourceUri: string; resultSetIndex: number };
    refreshResult: { sourceUri: string; resultSetIndex: number; limitValue?: string };
    clearRefreshFailure: { sourceUri: string; resultSetIndex: number };
    requestDatabaseAggregations: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        aggregations: Array<{ columnIndex: number; fn: string }>;
        timeoutSeconds?: number;
        isRetry?: boolean;
    };
    requestDatabaseFilterValues: {
        sourceUri: string;
        resultSetIndex: number;
        columnIndex: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
        timeoutSeconds?: number;
        isRetry?: boolean;
    };
    applyDatabaseFilter: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
        timeoutSeconds?: number;
        isRetry?: boolean;
    };
    closeAllResults: { sourceUri: string };
    cancelQuery: { sourceUri: string; currentRowCounts?: number[] };
    copyToClipboard: { text: string };
    info: { text: string };
    error: { text: string };
    focusView: EmptyPayload;
    setContext: { key: string; value: unknown };
    clearLogs: { sourceUri: string };
    switchResultSet: { sourceUri: string; resultSetIndex: number };
    selectionStatsChanged: { stats: SelectionStatsUpdatePayload | null };
    insertCellContent: { text: string; dataType?: string; sqlText?: string };
    updateResultFormatting: ResultFormattingUpdateRequest;
    saveEdits: {
        sourceUri: string;
        resultSetIndex: number;
        editSource: { db?: string; schema?: string; table: string };
        edits: { rowIndex: number; columnIndex: number; newValue: unknown }[];
        deleteRowIndices?: number[];
    };
    webviewFocused: EmptyPayload;
    webviewBlurred: EmptyPayload;
    updateGridFontFamily: { fontFamily: string };
    updateGridFontSize: { fontSize: number };
    saveChartImage: { dataUrl: string; fileName?: string };
    requestRows: {
        sourceUri: string;
        resultSetIndex: number;
        offset: number;
        limit: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
    };
    diskQuery: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        action: 'window' | 'count' | 'distinct' | 'aggregate' | 'group';
        querySpec?: DiskQuerySpec;
        offset?: number;
        limit?: number;
        columnIndex?: number;
        distinctLimit?: number;
        aggregations?: Array<{ columnIndex: number; fn: string }>;
        grouping?: DiskGroupLevel[];
        groupPath?: DiskGroupPathItem[];
    };
    moveToDisk: { sourceUri: string; resultSetIndex: number };
    moveAllToDisk: { sourceUri: string };
    requestDatabaseGrouping: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        grouping: unknown;
        timeoutSeconds?: number;
    };
    cancelDatabaseGrouping: { sourceUri: string; resultSetIndex: number; requestId: number };
    previewDatabaseGrouping: { sourceUri: string; resultSetIndex: number; requestId: number; grouping: unknown };
    requestExploreFullStats: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        columnIndex: number;
        filters?: ExploreFilterModel;
        timeoutSeconds?: number;
    };
    requestExplorePivot: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        pivot: ExplorePivotConfig;
        timeoutSeconds?: number;
    };
    previewExplorePivot: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        pivot: ExplorePivotConfig;
        pivotValues: string[];
    };
    requestExploreComposer: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        composer: ExploreComposerConfig;
        timeoutSeconds?: number;
    };
    previewExploreComposer: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        composer: ExploreComposerConfig;
    };
    previewExploreFilteredSql: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        filters: ExploreFilterModel;
    };
    openExploreSqlInEditor: { sql: string; label?: string };
}

interface ResultPanelHostToWebviewMessageMap {
    hydrate: { data: ResultPanelViewData; uxTraceId?: string };
    testBridge: Omit<ResultPanelTestBridgeRequest, 'command'>;
    setActiveSource: {
        sourceUri: string;
        activeResultSetIndex: number;
        executingSourcesJson: string;
        sourcesJson: string;
        pinnedSourcesJson: string;
        formatSettings?: unknown;
        diskBackedStreamCapEnabled?: boolean;
        streamingCompletedSourcesJson?: string;
        uxTraceId?: string;
    };
    uxPerfSession: { active: boolean };
    saveScrollState: EmptyPayload;
    refreshView: EmptyPayload;
    copySelection: { copyFormat?: 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon' };
    updateCopyFormat: { copyFormat: 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon' };
    selectAll: EmptyPayload;
    cancelExecution: { sourceUri: string };
    appendRows: {
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
        resultSetId?: string;
        chunkSequence?: number;
        diskBackedStreamCapEnabled?: boolean;
    };
    streamingComplete: {
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        limitReached: boolean;
        resultSetId?: string;
        lastChunkSequence?: number;
    };
    switchToResultSet: { resultSetIndex: number };
    resultFormattingState: { data: unknown };
    saveEdits: { sourceUri: string; resultSetIndex: number; editSource: unknown; edits: unknown[]; deleteRowIndices?: number[] };
    diskBackedActivate: {
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        columns: { name: string; type?: string; scale?: number }[];
        rows: Uint8Array | unknown[][];
        limitReached: boolean;
    };
    rowCountUpdate: { sourceUri: string; resultSetIndex: number; totalRows: number; limitReached: boolean };
    rowWindow: {
        sourceUri: string;
        resultSetIndex: number;
        offset: number;
        rows: Uint8Array | unknown[][];
        requestId: number;
        totalRows?: number;
        filteredCount?: number;
    };
    diskQueryResult: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        action: 'window' | 'count' | 'distinct' | 'aggregate' | 'group';
        rows?: Uint8Array | unknown[][];
        offset?: number;
        filteredCount?: number;
        totalRows?: number;
        distinctValues?: DiskDistinctValue[];
        distinctTruncated?: boolean;
        aggregations?: DiskAggregationResult[];
        groupResult?: DiskGroupQueryResult;
    };
    databaseAggregationResult: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        aggregations?: DiskAggregationResult[];
        error?: string;
    };
    databaseFilterValuesResult: {
        sourceUri: string;
        resultSetIndex: number;
        columnIndex: number;
        requestId: number;
        values?: DiskDistinctValue[];
        truncated?: boolean;
        error?: string;
    };
    databaseFilterApplyResult: { sourceUri: string; resultSetIndex: number; requestId: number; error?: string };
    databaseGroupingResult: {
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        columns?: Array<{ name: string; type?: string; kind?: 'group' | 'count' | 'percentage' | 'aggregate'; sourceColumnIndex?: number; fn?: string }>;
        rows?: unknown[][];
        totalRows?: number;
        truncated?: boolean;
        sql?: string;
        error?: string;
    };
    databaseGroupingPreviewResult: { sourceUri?: string; resultSetIndex?: number; requestId: number; sql?: string; error?: string };
    exploreFullStatsResult: {
        requestId: number;
        columnIndex: number;
        values?: Record<string, number | null>;
        percentilesUnavailable?: boolean;
        stddevUnavailable?: boolean;
        sql?: string;
        error?: string;
    };
    explorePivotResult: {
        requestId: number;
        columns?: Array<{ name: string; type?: string; kind: 'row' | 'value' }>;
        rows?: unknown[][];
        totalRows?: number;
        pivotValues?: string[];
        truncated?: boolean;
        sql?: string;
        error?: string;
    };
    explorePivotPreviewResult: { requestId: number; sql?: string; error?: string };
    exploreComposerResult: {
        requestId: number;
        columnIndexes?: { bucket: number; dimension: number | undefined; split: number | undefined; measure: number; previous: number | undefined };
        rows?: unknown[][];
        sql?: string;
        error?: string;
    };
    exploreComposerPreviewResult: { requestId: number; sql?: string; error?: string };
    exploreFilteredSqlPreviewResult: { requestId: number; sql?: string; error?: string };
}

type MessageFromMap<M extends object> = {
    [K in keyof M]: { command: K } & M[K]
}[keyof M];

export type ResultPanelWebviewToHostMessage = MessageFromMap<ResultPanelWebviewToHostMessageMap>;
export type ResultPanelHostToWebviewMessage = MessageFromMap<ResultPanelHostToWebviewMessageMap>;

export type ResultPanelInboundMessage = ResultPanelWebviewToHostMessage;
export type ResultPanelOutboundMessage = ResultPanelHostToWebviewMessage;

export const RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS = [
    'ready', 'migrateResult', 'logRowsApplied', 'requestLogSync', 'requestResultSync', 'selectAll',
    'reportHydrationMetrics', 'reportResultPanelTrace', 'testBridgeResult', 'reportUxPerf',
    'describeWithCopilot', 'fixSqlError', 'initiateExport', 'initiateExportWithSelection',
    'queryLocallyDuckDB', 'exportCsv', 'openInExcel', 'openInFilePreview', 'addFileToDataWorkspace',
    'copyAsExcel', 'openInExcelXlsx', 'exportAllResultSetsToExcel', 'exportJson', 'exportXml',
    'exportSqlInsert', 'exportMarkdown', 'exportParquet', 'exportToMdFile', 'export', 'switchSource',
    'togglePin', 'toggleResultPin', 'switchToPinnedResult', 'unpinResult', 'closeSource', 'closeResult',
    'refreshResult', 'clearRefreshFailure', 'requestDatabaseAggregations', 'requestDatabaseFilterValues',
    'applyDatabaseFilter', 'closeAllResults', 'cancelQuery', 'copyToClipboard', 'info', 'error',
    'focusView', 'setContext', 'clearLogs', 'switchResultSet', 'selectionStatsChanged',
    'insertCellContent', 'updateResultFormatting', 'saveEdits', 'webviewFocused', 'webviewBlurred',
    'updateGridFontFamily', 'updateGridFontSize', 'saveChartImage', 'requestRows', 'diskQuery',
    'moveToDisk', 'moveAllToDisk', 'requestDatabaseGrouping', 'cancelDatabaseGrouping',
    'previewDatabaseGrouping', 'requestExploreFullStats', 'requestExplorePivot', 'previewExplorePivot',
    'requestExploreComposer', 'previewExploreComposer', 'previewExploreFilteredSql', 'openExploreSqlInEditor',
] as const satisfies readonly ResultPanelWebviewToHostMessage['command'][];

export const RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS = [
    'hydrate', 'testBridge', 'setActiveSource', 'uxPerfSession', 'saveScrollState', 'refreshView',
    'copySelection', 'updateCopyFormat', 'selectAll', 'cancelExecution', 'appendRows', 'streamingComplete',
    'switchToResultSet', 'resultFormattingState', 'saveEdits', 'diskBackedActivate', 'rowCountUpdate',
    'rowWindow', 'diskQueryResult', 'databaseAggregationResult', 'databaseFilterValuesResult',
    'databaseFilterApplyResult', 'databaseGroupingResult', 'databaseGroupingPreviewResult',
    'exploreFullStatsResult', 'explorePivotResult', 'explorePivotPreviewResult', 'exploreComposerResult',
    'exploreComposerPreviewResult', 'exploreFilteredSqlPreviewResult',
] as const satisfies readonly ResultPanelHostToWebviewMessage['command'][];

export const RESULT_PANEL_INBOUND_COMMANDS = RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS;
export const RESULT_PANEL_OUTBOUND_COMMANDS = RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS;
