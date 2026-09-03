import {
    RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS,
    RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS,
    type ResultPanelHostToWebviewMessage,
    type ResultPanelWebviewToHostMessage,
} from './resultPanelContracts';

type MessageRecord = { command: string; [key: string]: unknown };
type FieldRule = (message: MessageRecord) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
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

function all(...rules: FieldRule[]): FieldRule {
    return message => rules.every(rule => rule(message));
}

function stringField(key: string): FieldRule {
    return message => hasString(message, key);
}

function stringValueField(key: string): FieldRule {
    return message => typeof message[key] === 'string';
}

function indexField(key: string): FieldRule {
    return message => isIndex(message[key]);
}

function numberField(key: string): FieldRule {
    return message => isFiniteNumber(message[key]);
}

function booleanField(key: string): FieldRule {
    return message => typeof message[key] === 'boolean';
}

function arrayField(key: string): FieldRule {
    return message => Array.isArray(message[key]);
}

function optional(key: string, rule: FieldRule): FieldRule {
    return message => message[key] === undefined || rule(message);
}

function objectField(key: string): FieldRule {
    return message => isRecord(message[key]);
}

function oneOfField(key: string, values: readonly string[]): FieldRule {
    return message => typeof message[key] === 'string' && values.includes(message[key] as string);
}

const noPayload = all();
const stringSource = stringField('sourceUri');
const resultIndex = indexField('resultSetIndex');
const requestIndex = indexField('requestId');
const rowsPayload = all(indexField('resultSetIndex'), message => hasRows(message));

const webviewRules: Record<string, FieldRule> = {
    ready: noPayload,
    migrateResult: all(stringSource, resultIndex),
    logRowsApplied: all(stringSource, numberField('executionTimestamp'), indexField('totalRows')),
    requestLogSync: all(stringSource, indexField('currentRows'), optional('executionTimestamp', numberField('executionTimestamp'))),
    requestResultSync: all(stringSource, stringField('reason')),
    selectAll: noPayload,
    reportHydrationMetrics: all(
        objectField('metrics'),
        message => {
            const metrics = message.metrics as MessageRecord;
            return numberField('durationMs')(metrics)
                && (metrics.activeSource === null || typeof metrics.activeSource === 'string')
                && indexField('resultSetCount')(metrics)
                && indexField('totalRowCount')(metrics)
                && oneOfField('executionState', ['idle', 'loading', 'finalizing', 'success', 'error', 'cancelled', 'retrying'])(metrics);
        },
    ),
    reportResultPanelTrace: all(objectField('event'), message => hasString(message.event as MessageRecord, 'phase')),
    testBridgeResult: all(stringField('requestId'), stringField('action'), booleanField('ok')),
    reportUxPerf: all(objectField('event'), message => all(stringField('op'), stringField('phase'))(message.event as MessageRecord)),
    describeWithCopilot: message => message.data !== undefined,
    fixSqlError: all(stringField('errorMessage'), stringField('sql')),
    initiateExport: message => message.data !== undefined,
    initiateExportWithSelection: all(message => message.data !== undefined, stringField('format'), stringField('destination')),
    queryLocallyDuckDB: message => message.data !== undefined,
    exportCsv: message => message.data !== undefined,
    openInExcel: message => message.data !== undefined,
    openInFilePreview: message => message.data !== undefined,
    addFileToDataWorkspace: noPayload,
    copyAsExcel: message => message.data !== undefined,
    openInExcelXlsx: message => message.data !== undefined,
    exportAllResultSetsToExcel: message => message.data !== undefined,
    exportJson: message => message.data !== undefined,
    exportXml: message => message.data !== undefined,
    exportSqlInsert: message => message.data !== undefined,
    exportMarkdown: message => message.data !== undefined,
    exportParquet: message => message.data !== undefined,
    exportToMdFile: all(objectField('data'), message => {
        const data = message.data as MessageRecord;
        return hasString(data, 'sourceUri') && hasString(data, 'mdDocument');
    }),
    export: all(oneOfField('format', ['csv', 'csv.gz', 'csv.zst', 'json', 'xml', 'sql', 'markdown', 'parquet']), stringSource, resultIndex),
    switchSource: stringSource,
    togglePin: stringSource,
    toggleResultPin: all(stringSource, resultIndex),
    switchToPinnedResult: stringField('resultId'),
    unpinResult: stringField('resultId'),
    closeSource: stringSource,
    closeResult: all(stringSource, resultIndex),
    refreshResult: all(stringSource, resultIndex),
    clearRefreshFailure: all(stringSource, resultIndex),
    requestDatabaseAggregations: all(stringSource, resultIndex, requestIndex, arrayField('aggregations')),
    requestDatabaseFilterValues: all(stringSource, resultIndex, indexField('columnIndex'), requestIndex),
    applyDatabaseFilter: all(stringSource, resultIndex, requestIndex),
    closeAllResults: stringSource,
    cancelQuery: all(stringSource, optional('currentRowCounts', arrayField('currentRowCounts'))),
    copyToClipboard: stringField('text'),
    info: stringField('text'),
    error: stringField('text'),
    focusView: noPayload,
    setContext: all(stringField('key'), message => message.value !== undefined),
    clearLogs: stringSource,
    switchResultSet: all(stringSource, resultIndex),
    selectionStatsChanged: message => message.stats === null || isRecord(message.stats),
    insertCellContent: all(
        stringValueField('text'),
        optional('dataType', stringValueField('dataType')),
        optional('sqlText', stringValueField('sqlText')),
    ),
    updateResultFormatting: all(stringSource, oneOfField('scope', ['global', 'connection', 'result', 'column']), message => message.settings !== undefined),
    saveEdits: all(stringSource, resultIndex, objectField('editSource'), arrayField('edits'), message => hasString(message.editSource as MessageRecord, 'table')),
    webviewFocused: noPayload,
    webviewBlurred: noPayload,
    updateGridFontFamily: stringField('fontFamily'),
    updateGridFontSize: all(numberField('fontSize'), message => (message.fontSize as number) > 0),
    saveChartImage: stringField('dataUrl'),
    requestRows: all(stringSource, resultIndex, indexField('offset'), indexField('limit'), requestIndex),
    diskQuery: all(stringSource, resultIndex, requestIndex, oneOfField('action', ['window', 'count', 'distinct', 'aggregate', 'group'])),
    moveToDisk: all(stringSource, resultIndex),
    moveAllToDisk: stringSource,
    requestDatabaseGrouping: all(stringSource, resultIndex, requestIndex, message => message.grouping !== undefined),
    cancelDatabaseGrouping: all(stringSource, resultIndex, requestIndex),
    previewDatabaseGrouping: all(stringSource, resultIndex, requestIndex, message => message.grouping !== undefined),
    requestExploreFullStats: all(stringSource, resultIndex, requestIndex, indexField('columnIndex')),
    requestExplorePivot: all(stringSource, resultIndex, requestIndex, message => message.pivot !== undefined),
    previewExplorePivot: all(stringSource, resultIndex, requestIndex, message => message.pivot !== undefined, arrayField('pivotValues')),
    requestExploreComposer: all(stringSource, resultIndex, requestIndex, message => message.composer !== undefined),
    previewExploreComposer: all(stringSource, resultIndex, requestIndex, message => message.composer !== undefined),
    previewExploreFilteredSql: all(stringSource, resultIndex, requestIndex, message => message.filters !== undefined),
    openExploreSqlInEditor: stringField('sql'),
};

const hostRules: Record<string, FieldRule> = {
    hydrate: objectField('data'),
    testBridge: all(stringField('requestId'), stringField('action')),
    setActiveSource: all(stringSource, indexField('activeResultSetIndex'), stringField('executingSourcesJson'), stringField('sourcesJson'), stringField('pinnedSourcesJson')),
    uxPerfSession: booleanField('active'),
    saveScrollState: noPayload,
    refreshView: noPayload,
    copySelection: optional('copyFormat', oneOfField('copyFormat', ['tabbed', 'markdown', 'csv', 'csv-semicolon'])),
    updateCopyFormat: oneOfField('copyFormat', ['tabbed', 'markdown', 'csv', 'csv-semicolon']),
    selectAll: noPayload,
    cancelExecution: stringSource,
    appendRows: all(
        rowsPayload,
        indexField('totalRows'),
        booleanField('isLastChunk'),
        booleanField('limitReached'),
        optional('resultSetId', stringField('resultSetId')),
        optional('chunkSequence', indexField('chunkSequence')),
        optional('fromRow', indexField('fromRow')),
    ),
    streamingComplete: all(
        stringSource,
        resultIndex,
        indexField('totalRows'),
        booleanField('limitReached'),
        optional('resultSetId', stringField('resultSetId')),
        optional('lastChunkSequence', indexField('lastChunkSequence')),
    ),
    switchToResultSet: resultIndex,
    resultFormattingState: message => message.data !== undefined,
    saveEdits: all(stringSource, resultIndex),
    diskBackedActivate: all(stringSource, resultIndex, indexField('totalRows'), message => hasRows(message), arrayField('columns'), booleanField('limitReached'), optional('resultSetId', stringField('resultSetId'))),
    rowCountUpdate: all(stringSource, resultIndex, indexField('totalRows'), booleanField('limitReached'), optional('resultSetId', stringField('resultSetId'))),
    rowWindow: all(stringSource, resultIndex, indexField('offset'), message => hasRows(message), requestIndex),
    diskQueryResult: all(stringSource, resultIndex, requestIndex, oneOfField('action', ['window', 'count', 'distinct', 'aggregate', 'group'])),
    databaseAggregationResult: all(stringSource, resultIndex, requestIndex),
    databaseFilterValuesResult: all(stringSource, resultIndex, requestIndex),
    databaseFilterApplyResult: all(stringSource, resultIndex, requestIndex),
    databaseGroupingResult: all(stringSource, resultIndex, requestIndex),
    databaseGroupingPreviewResult: requestIndex,
    exploreFullStatsResult: all(requestIndex, indexField('columnIndex')),
    explorePivotResult: requestIndex,
    explorePivotPreviewResult: requestIndex,
    exploreComposerResult: requestIndex,
    exploreComposerPreviewResult: requestIndex,
    exploreFilteredSqlPreviewResult: requestIndex,
};

function parseMessage<T>(value: unknown, commands: readonly string[], rules: Record<string, FieldRule>): T | undefined {
    if (!isRecord(value) || typeof value.command !== 'string' || !commands.includes(value.command)) {
        return undefined;
    }
    const rule = rules[value.command];
    return rule && rule(value as MessageRecord) ? value as T : undefined;
}

export function parseResultPanelWebviewMessage(value: unknown): ResultPanelWebviewToHostMessage | undefined {
    return parseMessage<ResultPanelWebviewToHostMessage>(value, RESULT_PANEL_WEBVIEW_TO_HOST_COMMANDS, webviewRules);
}

export function parseResultPanelHostMessage(value: unknown): ResultPanelHostToWebviewMessage | undefined {
    return parseMessage<ResultPanelHostToWebviewMessage>(value, RESULT_PANEL_HOST_TO_WEBVIEW_COMMANDS, hostRules);
}
