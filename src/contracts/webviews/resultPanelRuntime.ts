import {
    RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS,
    RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS,
    type ResultPanelHostToWebviewMessage,
    type ResultPanelWebviewToHostMessage,
} from './resultPanelContracts';

type MessageRecord = { command: string; [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function hasString(message: MessageRecord, key: string): boolean {
    return typeof message[key] === 'string' && (message[key] as string).length > 0;
}

function hasNumber(message: MessageRecord, key: string): boolean {
    return isFiniteNumber(message[key]);
}

function hasBoolean(message: MessageRecord, key: string): boolean {
    return typeof message[key] === 'boolean';
}

function hasArray(message: MessageRecord, key: string): boolean {
    return Array.isArray(message[key]);
}

function hasRows(message: MessageRecord): boolean {
    return message.rows instanceof Uint8Array || Array.isArray(message.rows);
}

function hasCommand(
    message: MessageRecord,
    commands: readonly string[],
): boolean {
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
            return hasString(message, 'sourceUri') && isNonNegativeInteger(message.resultSetIndex);
        case 'requestDatabaseGrouping':
        case 'previewDatabaseGrouping':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && message.grouping !== undefined;
        case 'requestExplorePivot':
        case 'previewExplorePivot':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && message.pivot !== undefined
                && (message.command === 'requestExplorePivot' || Array.isArray(message.pivotValues));
        case 'requestExploreComposer':
        case 'previewExploreComposer':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && message.composer !== undefined;
        case 'previewExploreFilteredSql':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && message.filters !== undefined;
        case 'logRowsApplied':
            return hasString(message, 'sourceUri')
                && hasNumber(message, 'executionTimestamp')
                && hasNumber(message, 'totalRows');
        case 'requestLogSync':
            return hasString(message, 'sourceUri') && hasNumber(message, 'currentRows')
                && (message.executionTimestamp === undefined || hasNumber(message, 'executionTimestamp'));
        case 'requestResultSync':
            return hasString(message, 'sourceUri') && hasString(message, 'reason');
        case 'reportHydrationMetrics':
            return isRecord(message.metrics)
                && hasNumber(message.metrics as MessageRecord, 'durationMs')
                && (message.metrics as MessageRecord).activeSource !== undefined
                && hasNumber(message.metrics as MessageRecord, 'resultSetCount')
                && hasNumber(message.metrics as MessageRecord, 'totalRowCount')
                && hasString(message.metrics as MessageRecord, 'executionState');
        case 'reportResultPanelTrace':
            return isRecord(message.event) && hasString(message.event as MessageRecord, 'phase');
        case 'testBridgeResult':
            return hasString(message, 'requestId') && hasString(message, 'action') && hasBoolean(message, 'ok');
        case 'reportUxPerf':
            return isRecord(message.event)
                && hasString(message.event as MessageRecord, 'op')
                && hasString(message.event as MessageRecord, 'phase');
        case 'fixSqlError':
            return hasString(message, 'errorMessage') && hasString(message, 'sql');
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
            return message.data !== undefined
                && hasString(message, 'format')
                && hasString(message, 'destination');
        case 'exportToMdFile':
            return isRecord(message.data)
                && hasString(message.data as MessageRecord, 'sourceUri')
                && hasString(message.data as MessageRecord, 'mdDocument');
        case 'export':
            return hasString(message, 'format')
                && hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex);
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
            return hasString(message, 'sourceUri') && isNonNegativeInteger(message.resultSetIndex);
        case 'requestDatabaseAggregations':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && hasArray(message, 'aggregations');
        case 'requestDatabaseFilterValues':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.columnIndex)
                && isNonNegativeInteger(message.requestId);
        case 'applyDatabaseFilter':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId);
        case 'cancelQuery':
            return hasString(message, 'sourceUri')
                && (message.currentRowCounts === undefined || hasArray(message, 'currentRowCounts'));
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
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isRecord(message.editSource)
                && hasString(message.editSource as MessageRecord, 'table')
                && hasArray(message, 'edits');
        case 'updateGridFontFamily':
            return hasString(message, 'fontFamily');
        case 'updateGridFontSize':
            return isFiniteNumber(message.fontSize) && message.fontSize > 0;
        case 'saveChartImage':
            return hasString(message, 'dataUrl');
        case 'requestRows':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.offset)
                && isNonNegativeInteger(message.limit)
                && isNonNegativeInteger(message.requestId);
        case 'diskQuery':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && ['window', 'count', 'distinct', 'aggregate', 'group'].includes(String(message.action));
        case 'moveToDisk':
            return hasString(message, 'sourceUri') && isNonNegativeInteger(message.resultSetIndex);
        case 'cancelDatabaseGrouping':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId);
        case 'requestExploreFullStats':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && isNonNegativeInteger(message.columnIndex);
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
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.activeResultSetIndex)
                && hasString(message, 'executingSourcesJson')
                && hasString(message, 'sourcesJson')
                && hasString(message, 'pinnedSourcesJson');
        case 'uxPerfSession':
            return hasBoolean(message, 'active');
        case 'copySelection':
            return message.copyFormat === undefined
                || ['tabbed', 'markdown', 'csv', 'csv-semicolon'].includes(String(message.copyFormat));
        case 'updateCopyFormat':
            return ['tabbed', 'markdown', 'csv', 'csv-semicolon'].includes(String(message.copyFormat));
        case 'cancelExecution':
            return hasString(message, 'sourceUri');
        case 'streamingComplete':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.totalRows)
                && hasBoolean(message, 'limitReached');
        case 'rowCountUpdate':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.totalRows)
                && hasBoolean(message, 'limitReached');
        case 'diskBackedActivate':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.totalRows)
                && hasRows(message)
                && hasArray(message, 'columns')
                && hasBoolean(message, 'limitReached');
        case 'rowWindow':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.offset)
                && hasRows(message)
                && isNonNegativeInteger(message.requestId);
        case 'diskQueryResult':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId)
                && ['window', 'count', 'distinct', 'aggregate', 'group'].includes(String(message.action));
        case 'databaseAggregationResult':
        case 'databaseFilterValuesResult':
        case 'databaseFilterApplyResult':
        case 'databaseGroupingResult':
            return hasString(message, 'sourceUri')
                && isNonNegativeInteger(message.resultSetIndex)
                && isNonNegativeInteger(message.requestId);
        case 'switchToResultSet':
            return isNonNegativeInteger(message.resultSetIndex);
        case 'resultFormattingState':
            return message.data !== undefined;
        case 'appendRows':
            return isNonNegativeInteger(message.resultSetIndex)
                && hasRows(message)
                && isNonNegativeInteger(message.totalRows)
                && hasBoolean(message, 'isLastChunk')
                && hasBoolean(message, 'limitReached');
        case 'exploreFullStatsResult':
            return isNonNegativeInteger(message.requestId) && isNonNegativeInteger(message.columnIndex);
        case 'explorePivotResult':
        case 'explorePivotPreviewResult':
        case 'exploreComposerResult':
        case 'exploreComposerPreviewResult':
        case 'exploreFilteredSqlPreviewResult':
            return isNonNegativeInteger(message.requestId);
        case 'saveEdits':
            return hasString(message, 'sourceUri') && isNonNegativeInteger(message.resultSetIndex);
        case 'databaseGroupingPreviewResult':
            return isNonNegativeInteger(message.requestId);
        default:
            return false;
    }
}

export function parseResultPanelWebviewMessage(
    value: unknown,
): ResultPanelWebviewToHostMessage | undefined {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return undefined;
    }
    if (!hasCommand(value as MessageRecord, RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS)) {
        return undefined;
    }
    return validateWebviewMessage(value as MessageRecord)
        ? value as ResultPanelWebviewToHostMessage
        : undefined;
}

export function parseResultPanelHostMessage(
    value: unknown,
): ResultPanelHostToWebviewMessage | undefined {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return undefined;
    }
    if (!hasCommand(value as MessageRecord, RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS)) {
        return undefined;
    }
    return validateHostMessage(value as MessageRecord)
        ? value as ResultPanelHostToWebviewMessage
        : undefined;
}
