import type { ExcelExportMetadata, ExportMetadata } from '../../export/exportManager';
import type { ResultFormattingPayload, ResultFormattingUpdateRequest } from '../../results/resultFormattingTypes';
import type {
    DiskAggregationRequest,
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskQuerySpec,
} from '../../core/resultDataProvider/types';
import type {
    DatabaseAggregationRequest,
    DatabaseAggregationResult,
} from '../../results/databaseAggregationSql';

export type ResultPanelExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';

export type ResultPanelExecutionState =
    | 'idle'
    | 'loading'
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
    /** When true, webview may cap streamed rows above DISK_BACKED_WEBVIEW_STREAM_CAP (host-aligned). */
    diskBackedStreamCapEnabled: boolean;
    /** Bumps whenever active-source result data changes; used to avoid stale hydrate dedup. */
    dataVersion?: number;
}

export type ResultPanelWebviewToHostMessage =
  | { command: 'ready' }
  | { command: 'selectAll' }
  | { command: 'reportHydrationMetrics'; metrics: ResultPanelHydrationMetricsPayload }
    | { command: 'describeWithCopilot'; data: unknown; sql?: string }
    | { command: 'fixSqlError'; errorMessage: string; sql: string }
    | { command: 'initiateExport'; data: ExportMetadata }
    | { command: 'initiateExportWithSelection'; data: ExportMetadata; format: string; destination: string }
    | { command: 'queryLocallyDuckDB'; data: ExportMetadata }
    | { command: 'exportCsv'; data: string | ExportMetadata }
    | { command: 'openInExcel'; data: unknown; sql?: string }
    | { command: 'openInFilePreview'; data: unknown; sql?: string }
    | { command: 'copyAsExcel'; data: unknown; sql?: string }
    | { command: 'openInExcelXlsx'; data: unknown; sql?: string }
    | { command: 'exportAllResultSetsToExcel'; data: ExcelExportMetadata }
    | { command: 'exportJson'; data: string | ExportMetadata }
    | { command: 'exportXml'; data: string | ExportMetadata }
    | { command: 'exportSqlInsert'; data: string | ExportMetadata }
    | { command: 'exportMarkdown'; data: string | ExportMetadata }
    | { command: 'exportParquet'; data: string | ExportMetadata }
    | { command: 'exportToMdFile'; data: { sourceUri: string; mdDocument: string } }
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
    | {
        command: 'requestDatabaseAggregations';
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        aggregations: DatabaseAggregationRequest[];
        timeoutSeconds?: number;
        isRetry?: boolean;
      }
    | {
        command: 'requestDatabaseFilterValues';
        sourceUri: string;
        resultSetIndex: number;
        columnIndex: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
        timeoutSeconds?: number;
        isRetry?: boolean;
      }
    | {
        command: 'applyDatabaseFilter';
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
        timeoutSeconds?: number;
        isRetry?: boolean;
      }
    | { command: 'closeAllResults'; sourceUri: string }
    | { command: 'cancelQuery'; sourceUri: string; currentRowCounts?: number[] }
    | { command: 'copyToClipboard'; text: string }
    | { command: 'info'; text: string }
    | { command: 'error'; text: string }
    | { command: 'focusView' }
    | { command: 'setContext'; key: string; value: unknown }
    | { command: 'clearLogs'; sourceUri: string }
    | { command: 'switchResultSet'; sourceUri: string; resultSetIndex: number }
    | { command: 'selectionStatsChanged'; stats: SelectionStatsPayload | null }
    | { command: 'insertCellContent'; text: string; dataType?: string; sqlText?: string }
    | ({ command: 'updateResultFormatting' } & ResultFormattingUpdateRequest)
    | {
        command: 'saveEdits';
        sourceUri: string;
        resultSetIndex: number;
        editSource: { db?: string; schema?: string; table: string };
        edits: { rowIndex: number; columnIndex: number; newValue: unknown }[];
        deleteRowIndices?: number[];
      }
    | { command: 'webviewFocused' }
    | { command: 'webviewBlurred' }
    | { command: 'updateGridFontFamily'; fontFamily: string }
    | { command: 'updateGridFontSize'; fontSize: number }
    | { command: 'saveChartImage'; dataUrl: string; fileName?: string }
    | {
        command: 'requestRows';
        sourceUri: string;
        resultSetIndex: number;
        offset: number;
        limit: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
    }
    | {
        command: 'diskQuery';
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        action: 'window' | 'count' | 'distinct' | 'aggregate' | 'group';
        querySpec?: DiskQuerySpec;
        offset?: number;
        limit?: number;
        columnIndex?: number;
        distinctLimit?: number;
        aggregations?: DiskAggregationRequest[];
        grouping?: DiskGroupLevel[];
        groupPath?: DiskGroupPathItem[];
    }
    | { command: 'moveToDisk'; sourceUri: string; resultSetIndex: number }
    | { command: 'moveAllToDisk'; sourceUri: string };

export type ResultPanelHostToWebviewMessage =
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
  | { command: 'selectAll' }
    | { command: 'cancelExecution'; sourceUri: string }
    | {
        command: 'appendRows';
        sourceUri?: string;
        resultSetIndex: number;
        rows: Uint8Array | unknown[][];
        totalRows: number;
        isLastChunk: boolean;
        limitReached: boolean;
        isLog?: boolean;
        isFirstChunk?: boolean;
        columns?: { name: string; type?: string; scale?: number }[];
        sql?: string;
        refreshSql?: string;
        executionTimestamp?: number;
        /** Mirrors host isDiskBackedResultsAvailable — webview caps rows only when true. */
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
    | { command: 'saveEdits'; sourceUri: string; resultSetIndex: number; editSource: unknown; edits: unknown[]; deleteRowIndices?: number[] }
    | {
        command: 'diskBackedActivate';
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        columns: { name: string; type?: string; scale?: number }[];
        rows: Uint8Array | unknown[][];
        limitReached: boolean;
    }
    | {
        command: 'rowCountUpdate';
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        limitReached: boolean;
    }
    | {
        command: 'rowWindow';
        sourceUri: string;
        resultSetIndex: number;
        offset: number;
        rows: Uint8Array | unknown[][];
        requestId: number;
        totalRows?: number;
        filteredCount?: number;
    }
    | {
        command: 'diskQueryResult';
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
    }
    | {
        command: 'databaseAggregationResult';
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        aggregations?: DatabaseAggregationResult[];
        error?: string;
    }
    | {
        command: 'databaseFilterValuesResult';
        sourceUri: string;
        resultSetIndex: number;
        columnIndex: number;
        requestId: number;
        values?: DiskDistinctValue[];
        truncated?: boolean;
        error?: string;
    }
    | {
        command: 'databaseFilterApplyResult';
        sourceUri: string;
        resultSetIndex: number;
        requestId: number;
        error?: string;
    };

export type ResultPanelInboundMessage = ResultPanelWebviewToHostMessage;
export type ResultPanelOutboundMessage = ResultPanelHostToWebviewMessage;

export const RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS = [
  'ready',
  'selectAll',
  'reportHydrationMetrics',
  'describeWithCopilot',
  'fixSqlError',
  'initiateExport',
  'initiateExportWithSelection',
  'queryLocallyDuckDB',
  'exportCsv',
  'openInExcel',
  'openInFilePreview',
  'copyAsExcel',
  'openInExcelXlsx',
  'exportAllResultSetsToExcel',
  'exportJson',
  'exportXml',
  'exportSqlInsert',
  'exportMarkdown',
  'exportParquet',
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
  'updateGridFontSize',
  'saveChartImage',
  'webviewFocused',
  'webviewBlurred',
  'requestRows',
  'diskQuery',
  'moveToDisk',
  'moveAllToDisk'
] as const satisfies readonly ResultPanelWebviewToHostMessage['command'][];

export const RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS = [
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
  'saveEdits',
  'diskBackedActivate',
  'rowCountUpdate',
  'rowWindow',
  'diskQueryResult',
  'databaseAggregationResult',
  'databaseFilterValuesResult',
  'databaseFilterApplyResult'
] as const satisfies readonly ResultPanelHostToWebviewMessage['command'][];

export const RESULT_PANEL_INBOUND_COMMANDS = RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS;
export const RESULT_PANEL_OUTBOUND_COMMANDS = RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS;
