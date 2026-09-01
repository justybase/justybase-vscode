import type {
    ResultPanelHostToWebviewMessage,
    ResultPanelWebviewToHostMessage,
} from './hostContracts.js';
import {
    RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS,
    RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS,
} from './hostContracts.js';

interface ResultPanelVsCodeApi {
    postMessage(message: ResultPanelWebviewToHostMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}

const fallbackVsCodeApi: ResultPanelVsCodeApi = {
    postMessage() {},
    getState() {
        return undefined;
    },
    setState() {},
};

const vscodeApi: ResultPanelVsCodeApi = (() => {
    try {
        const acquireVsCodeApiFn = (globalThis as { acquireVsCodeApi?: () => ResultPanelVsCodeApi })
            .acquireVsCodeApi;
        return typeof acquireVsCodeApiFn === 'function' ? acquireVsCodeApiFn() : fallbackVsCodeApi;
    } catch {
        return fallbackVsCodeApi;
    }
})();

export function postHostMessage(message: ResultPanelWebviewToHostMessage): void {
    vscodeApi.postMessage(message);
}

export function getHostState(): unknown {
    return vscodeApi.getState();
}

export function setHostState(state: unknown): void {
    vscodeApi.setState(state);
}

type MessageRecord = { command: string; [key: string]: unknown };

function isRecord(value: unknown): value is MessageRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isIndex(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function hasString(message: MessageRecord, key: string): boolean {
    return typeof message[key] === 'string' && (message[key] as string).length > 0;
}

function hasRows(message: MessageRecord): boolean {
    return message.rows instanceof Uint8Array || Array.isArray(message.rows);
}

function hasKnownCommand(message: MessageRecord, commands: readonly string[]): boolean {
    return commands.includes(message.command);
}

function validateWebviewMessage(message: MessageRecord): boolean {
    switch (message.command) {
        case 'ready':
        case 'selectAll':
        case 'addFileToDataWorkspace':
        case 'focusView':
        case 'webviewFocused':
        case 'webviewBlurred':
            return true;
        case 'migrateResult':
        case 'closeResult':
        case 'switchResultSet':
        case 'toggleResultPin':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex);
        case 'logRowsApplied':
            return hasString(message, 'sourceUri') && isFiniteNumber(message.executionTimestamp)
                && isIndex(message.totalRows);
        case 'requestLogSync':
            return hasString(message, 'sourceUri') && isIndex(message.currentRows)
                && (message.executionTimestamp === undefined || isFiniteNumber(message.executionTimestamp));
        case 'requestResultSync':
            return hasString(message, 'sourceUri') && hasString(message, 'reason');
        case 'reportHydrationMetrics':
            return isRecord(message.metrics)
                && isFiniteNumber(message.metrics.durationMs)
                && (message.metrics.activeSource === null || typeof message.metrics.activeSource === 'string')
                && isIndex(message.metrics.resultSetCount)
                && isIndex(message.metrics.totalRowCount)
                && typeof message.metrics.executionState === 'string';
        case 'reportResultPanelTrace':
            return isRecord(message.event) && hasString(message.event, 'phase');
        case 'testBridgeResult':
            return hasString(message, 'requestId') && hasString(message, 'action')
                && typeof message.ok === 'boolean';
        case 'reportUxPerf':
            return isRecord(message.event) && hasString(message.event, 'op')
                && hasString(message.event, 'phase');
        case 'describeWithCopilot':
        case 'initiateExport':
        case 'queryLocallyDuckDB':
        case 'exportCsv':
        case 'openInExcel':
        case 'openInFilePreview':
        case 'copyAsExcel':
        case 'openInExcelXlsx':
        case 'exportAllResultSetsToExcel':
        case 'exportJson':
        case 'exportXml':
        case 'exportSqlInsert':
        case 'exportMarkdown':
        case 'exportParquet':
            return message.data !== undefined;
        case 'initiateExportWithSelection':
            return message.data !== undefined && hasString(message, 'format') && hasString(message, 'destination');
        case 'exportToMdFile':
            return isRecord(message.data) && hasString(message.data, 'sourceUri')
                && hasString(message.data, 'mdDocument');
        case 'export':
            return hasString(message, 'format') && hasString(message, 'sourceUri')
                && isIndex(message.resultSetIndex);
        case 'switchSource':
        case 'togglePin':
        case 'closeSource':
        case 'closeAllResults':
        case 'clearLogs':
        case 'moveAllToDisk':
            return hasString(message, 'sourceUri');
        case 'switchToPinnedResult':
        case 'unpinResult':
            return hasString(message, 'resultId');
        case 'refreshResult':
        case 'clearRefreshFailure':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex);
        case 'requestDatabaseAggregations':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && Array.isArray(message.aggregations);
        case 'requestDatabaseFilterValues':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.columnIndex) && isIndex(message.requestId);
        case 'applyDatabaseFilter':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId);
        case 'cancelQuery':
            return hasString(message, 'sourceUri')
                && (message.currentRowCounts === undefined || Array.isArray(message.currentRowCounts));
        case 'copyToClipboard':
        case 'info':
        case 'error':
            return hasString(message, 'text');
        case 'setContext':
            return hasString(message, 'key') && message.value !== undefined;
        case 'selectionStatsChanged':
            return message.stats === null || isRecord(message.stats);
        case 'insertCellContent':
            return hasString(message, 'text');
        case 'updateResultFormatting':
            return hasString(message, 'sourceUri')
                && ['global', 'connection', 'result', 'column'].includes(String(message.scope))
                && message.settings !== undefined;
        case 'saveEdits':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isRecord(message.editSource) && hasString(message.editSource, 'table')
                && Array.isArray(message.edits);
        case 'updateGridFontFamily':
            return hasString(message, 'fontFamily');
        case 'updateGridFontSize':
            return isFiniteNumber(message.fontSize) && message.fontSize > 0;
        case 'saveChartImage':
            return hasString(message, 'dataUrl');
        case 'requestRows':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.offset) && isIndex(message.limit) && isIndex(message.requestId);
        case 'diskQuery':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId)
                && ['window', 'count', 'distinct', 'aggregate', 'group'].includes(String(message.action));
        case 'moveToDisk':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex);
        case 'requestDatabaseGrouping':
        case 'previewDatabaseGrouping':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && message.grouping !== undefined;
        case 'cancelDatabaseGrouping':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId);
        case 'requestExploreFullStats':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && isIndex(message.columnIndex);
        case 'requestExplorePivot':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && message.pivot !== undefined;
        case 'previewExplorePivot':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && message.pivot !== undefined
                && Array.isArray(message.pivotValues);
        case 'requestExploreComposer':
        case 'previewExploreComposer':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && message.composer !== undefined;
        case 'previewExploreFilteredSql':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId) && message.filters !== undefined;
        case 'openExploreSqlInEditor':
            return hasString(message, 'sql');
        default:
            return false;
    }
}

function validateHostMessage(message: MessageRecord): boolean {
    switch (message.command) {
        case 'saveScrollState':
        case 'refreshView':
        case 'selectAll':
            return true;
        case 'hydrate':
            return isRecord(message.data);
        case 'testBridge':
            return hasString(message, 'requestId') && hasString(message, 'action');
        case 'setActiveSource':
            return hasString(message, 'sourceUri') && isIndex(message.activeResultSetIndex)
                && hasString(message, 'executingSourcesJson') && hasString(message, 'sourcesJson')
                && hasString(message, 'pinnedSourcesJson');
        case 'uxPerfSession':
            return typeof message.active === 'boolean';
        case 'copySelection':
            return message.copyFormat === undefined
                || ['tabbed', 'markdown', 'csv', 'csv-semicolon'].includes(String(message.copyFormat));
        case 'updateCopyFormat':
            return ['tabbed', 'markdown', 'csv', 'csv-semicolon'].includes(String(message.copyFormat));
        case 'cancelExecution':
            return hasString(message, 'sourceUri');
        case 'appendRows':
            return isIndex(message.resultSetIndex) && hasRows(message)
                && isIndex(message.totalRows) && typeof message.isLastChunk === 'boolean'
                && typeof message.limitReached === 'boolean'
                && (message.resultSetId === undefined || hasString(message, 'resultSetId'))
                && (message.chunkSequence === undefined || isIndex(message.chunkSequence))
                && (message.fromRow === undefined || isIndex(message.fromRow));
        case 'streamingComplete':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.totalRows) && typeof message.limitReached === 'boolean'
                && (message.resultSetId === undefined || hasString(message, 'resultSetId'))
                && (message.lastChunkSequence === undefined || isIndex(message.lastChunkSequence));
        case 'rowCountUpdate':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.totalRows) && typeof message.limitReached === 'boolean';
        case 'diskBackedActivate':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.totalRows) && hasRows(message)
                && Array.isArray(message.columns) && typeof message.limitReached === 'boolean';
        case 'rowWindow':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.offset) && hasRows(message) && isIndex(message.requestId);
        case 'diskQueryResult':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId)
                && ['window', 'count', 'distinct', 'aggregate', 'group'].includes(String(message.action));
        case 'databaseAggregationResult':
        case 'databaseFilterValuesResult':
        case 'databaseFilterApplyResult':
        case 'databaseGroupingResult':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex)
                && isIndex(message.requestId);
        case 'databaseGroupingPreviewResult':
            return isIndex(message.requestId);
        case 'switchToResultSet':
            return isIndex(message.resultSetIndex);
        case 'resultFormattingState':
            return message.data !== undefined;
        case 'saveEdits':
            return hasString(message, 'sourceUri') && isIndex(message.resultSetIndex);
        case 'exploreFullStatsResult':
            return isIndex(message.requestId) && isIndex(message.columnIndex);
        case 'explorePivotResult':
        case 'explorePivotPreviewResult':
        case 'exploreComposerResult':
        case 'exploreComposerPreviewResult':
        case 'exploreFilteredSqlPreviewResult':
            return isIndex(message.requestId);
        default:
            return false;
    }
}

export function asWebviewMessage(message: unknown): ResultPanelWebviewToHostMessage | undefined {
    if (!isRecord(message) || !hasKnownCommand(message, RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS)) {
        return undefined;
    }
    return validateWebviewMessage(message) ? message as ResultPanelWebviewToHostMessage : undefined;
}

export function asHostMessage(message: unknown): ResultPanelHostToWebviewMessage | undefined {
    if (!isRecord(message) || !hasKnownCommand(message, RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS)) {
        return undefined;
    }
    return validateHostMessage(message) ? message as ResultPanelHostToWebviewMessage : undefined;
}
