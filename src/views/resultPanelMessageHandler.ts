import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { encode } from '@msgpack/msgpack';
import type {
    ResultPanelInboundMessage,
    ResultPanelOutboundMessage,
    ResultPanelHydrationMetricsPayload,
    SelectionStatsPayload
} from '../contracts/webviews';
import { ResultStateManager } from '../state/resultStateManager';
import { ExportManager } from '../export/exportManager';
import { DuckDbResultBridge } from '../services/duckdbResultBridge';
import { MessagePackEncoder } from '../core/streaming';
import { ResultFormattingSettingsStore } from '../results/resultFormattingSettingsStore';
import { ResultFormattingUpdateRequest } from '../results/resultFormattingTypes';
import type {
    DiskAggregationRequest,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskQuerySpec,
} from '../core/resultDataProvider/types';
import type {
    DatabaseAggregationRequest,
    DatabaseAggregationResult,
} from '../results/databaseAggregationSql';
import { diskQuerySpecIsActive } from '../core/resultDataProvider/types';
import { bucketizePayloadSize, formatPerformanceEvent } from '../services/perf/performanceEvents';
import type { ResultSet } from '../types';
import { getLogger } from '../utils/logger';

export interface EditChange {
    rowIndex: number;
    columnIndex: number;
    newValue: unknown;
}

export interface SaveEditsRequest {
    sourceUri: string;
    resultSetIndex: number;
    editSource: { db?: string; schema?: string; table: string };
    edits: EditChange[];
    deleteRowIndices?: number[];
}

export interface MessageHandlerCallbacks {
    onUpdateWebview: () => void;
    onPostMessage: (message: ResultPanelOutboundMessage) => void;
    onForceHydrate: () => void;
    onSelectionStatsChanged?: (stats: SelectionStats | null) => void;
    onRecordHydrationMetrics?: (metrics: ResultPanelHydrationMetricsPayload) => void;
    onSaveEdits?: (request: SaveEditsRequest) => Promise<{ success: boolean; message: string }>;
    onGetWebviewUri?: (uri: vscode.Uri) => string;
    onRefreshResult?: (sourceUri: string, resultSetIndex: number, limitValue?: string) => Promise<void>;
    onRequestDatabaseAggregations?: (
        sourceUri: string,
        resultSetIndex: number,
        aggregations: DatabaseAggregationRequest[],
        timeoutSeconds?: number,
        isRetry?: boolean,
    ) => Promise<DatabaseAggregationResult[]>;
    onRequestDatabaseFilterValues?: (
        sourceUri: string,
        resultSetIndex: number,
        columnIndex: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ) => Promise<{ values: DiskDistinctValue[]; truncated: boolean }>;
    onApplyDatabaseFilter?: (
        sourceUri: string,
        resultSetIndex: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ) => Promise<void>;
    onClearRefreshFailure?: (sourceUri: string, resultSetIndex: number) => void;
}

export type SelectionStats = SelectionStatsPayload;

export class ResultPanelMessageHandler {
    private readonly _encoder = new MessagePackEncoder();

    constructor(
        private _stateManager: ResultStateManager,
        private _exportManager: ExportManager,
        private _callbacks: MessageHandlerCallbacks,
        private _duckDbResultBridge?: DuckDbResultBridge,
        private _formattingStore?: ResultFormattingSettingsStore
    ) { }

    public handleMessage(message: ResultPanelInboundMessage): void {
        switch (message.command) {
            case 'ready':
                this._callbacks.onForceHydrate();
                return;

            case 'selectAll':
                this._callbacks.onPostMessage({ command: 'selectAll' });
                return;

            case 'reportHydrationMetrics':
                console.log(formatPerformanceEvent({
                    operation: 'result_panel.first_paint',
                    duration_ms: Math.round(Math.max(0, message.metrics.durationMs) * 10) / 10,
                    result: 'ok',
                    payload_size_bucket: bucketizePayloadSize(message.metrics.payloadBytes),
                    timestamp: new Date().toISOString(),
                    metadata: {
                        active_source: message.metrics.activeSource,
                        result_set_count: message.metrics.resultSetCount,
                        total_row_count: message.metrics.totalRowCount,
                        execution_state: message.metrics.executionState
                    }
                }));
                this._callbacks.onRecordHydrationMetrics?.(message.metrics);
                return;

            case 'describeWithCopilot':
                vscode.commands.executeCommand('netezza.describeDataWithCopilot', message.data, message.sql);
                return;

            case 'fixSqlError':
                vscode.commands.executeCommand('netezza.fixSqlError', message.errorMessage, message.sql);
                return;

            case 'initiateExport':
                this._exportManager.initiateExport(message.data);
                return;

            case 'initiateExportWithSelection':
                void this._exportManager.initiateExportWithSelection(
                    message.data,
                    message.format,
                    message.destination
                );
                return;

            case 'queryLocallyDuckDB':
                if (!this._duckDbResultBridge) {
                    vscode.window.showErrorMessage('DuckDB bridge is not available in this view.');
                    return;
                }
                void this._duckDbResultBridge.queryLocally(message.data);
                return;

            case 'exportCsv':
                this._exportManager.exportCsv(message.data);
                return;

            case 'openInExcel':
                this._exportManager.openInExcel(message.data, message.sql);
                return;

            case 'openInFilePreview':
                this._exportManager.openInFilePreview(message.data, message.sql);
                return;

            case 'copyAsExcel':
                this._exportManager.copyAsExcel(message.data, message.sql);
                return;

            case 'openInExcelXlsx':
                this._exportManager.openInExcelXlsx(message.data, message.sql);
                return;

            case 'exportAllResultSetsToExcel':
                this._exportManager.exportAllResultSetsToExcel(message.data);
                return;

            case 'exportJson':
                this._exportManager.exportJson(message.data);
                return;

            case 'exportXml':
                this._exportManager.exportXml(message.data);
                return;

            case 'exportSqlInsert':
                this._exportManager.exportSqlInsert(message.data);
                return;

            case 'exportMarkdown':
                this._exportManager.exportMarkdown(message.data);
                return;

            case 'exportParquet':
                this._exportManager.exportParquet(message.data);
                return;

            case 'exportToMdFile':
                this._handleExportToMdFile(message.data);
                return;

            case 'export':
                this._exportManager.handleExport({
                    format: message.format,
                    sourceUri: message.sourceUri,
                    resultSetIndex: message.resultSetIndex,
                    rowIndices: message.rowIndices,
                    columnIds: message.columnIds
                });
                return;

            case 'switchSource':
                this._handleSwitchSource(message.sourceUri);
                return;

            case 'togglePin':
                this._stateManager.togglePin(message.sourceUri);
                this._callbacks.onUpdateWebview();
                return;

            case 'toggleResultPin':
                try {
                    this._stateManager.toggleResultPin(message.sourceUri, message.resultSetIndex);
                    this._callbacks.onUpdateWebview();
                } catch (error: unknown) {
                    if (error instanceof Error) {
                        vscode.window.showWarningMessage(error.message);
                    }
                }
                return;

            case 'switchToPinnedResult':
                this._handleSwitchToPinnedResult(message.resultId);
                return;

            case 'unpinResult':
                this._stateManager.unpinResult(message.resultId);
                this._callbacks.onUpdateWebview();
                return;

            case 'closeSource':
                this._stateManager.closeSource(message.sourceUri);
                this._callbacks.onForceHydrate();
                return;

            case 'closeResult':
                this._stateManager.closeResult(message.sourceUri, message.resultSetIndex);
                this._callbacks.onForceHydrate();
                return;

            case 'refreshResult':
                void this._handleRefreshResult(message.sourceUri, message.resultSetIndex, message.limitValue);
                return;

            case 'clearRefreshFailure':
                this._callbacks.onClearRefreshFailure?.(message.sourceUri, message.resultSetIndex);
                return;

            case 'requestDatabaseAggregations':
                void this._handleDatabaseAggregations(
                    message.sourceUri,
                    message.resultSetIndex,
                    message.requestId,
                    message.aggregations,
                    message.timeoutSeconds,
                    message.isRetry,
                );
                return;

            case 'requestDatabaseFilterValues':
                void this._handleDatabaseFilterValues(
                    message.sourceUri,
                    message.resultSetIndex,
                    message.columnIndex,
                    message.requestId,
                    message.querySpec,
                    message.timeoutSeconds,
                    message.isRetry,
                );
                return;

            case 'applyDatabaseFilter':
                void this._handleApplyDatabaseFilter(
                    message.sourceUri,
                    message.resultSetIndex,
                    message.requestId,
                    message.querySpec,
                    message.timeoutSeconds,
                    message.isRetry,
                );
                return;

            case 'closeAllResults':
                this._stateManager.closeAllResults(message.sourceUri);
                this._callbacks.onForceHydrate();
                return;

            case 'cancelQuery':
                this._handleCancelQuery(message.sourceUri, message.currentRowCounts);
                return;

            case 'copyToClipboard':
                vscode.env.clipboard.writeText(message.text);
                vscode.window.showInformationMessage('Copied to clipboard');
                return;

            case 'info':
                vscode.window.showInformationMessage(message.text);
                return;

            case 'error':
                console.error('[Webview Error]', message.text);
                vscode.window.showErrorMessage(`Webview Error: ${message.text}`);
                return;

            case 'focusView':
                vscode.commands.executeCommand('netezza.results.focus');
                return;

            case 'setContext':
                vscode.commands.executeCommand('setContext', message.key, message.value);
                return;

            case 'clearLogs':
                this._stateManager.clearLogs(message.sourceUri);
                this._callbacks.onUpdateWebview();
                return;

            case 'switchResultSet':
                this._stateManager.setActiveResultSetIndex(
                    message.sourceUri,
                    message.resultSetIndex
                );
                return;

            case 'selectionStatsChanged':
                if (this._callbacks.onSelectionStatsChanged) {
                    this._callbacks.onSelectionStatsChanged(message.stats);
                }
                return;

            case 'insertCellContent':
                this._handleInsertCellContent(message.text, message.dataType, message.sqlText);
                return;

            case 'updateResultFormatting':
                void this._handleUpdateResultFormatting(message);
                return;

            case 'updateGridFontFamily':
                void this._handleUpdateGridFontFamily(message.fontFamily);
                return;

            case 'updateGridFontSize':
                void this._handleUpdateGridFontSize(message.fontSize);
                return;

            case 'saveEdits':
                void this._handleSaveEdits(message);
                return;

            case 'webviewFocused':
            case 'webviewBlurred':
                return;

            case 'moveToDisk':
                void this._handleMoveToDisk(message);
                return;

            case 'moveAllToDisk':
                void this._handleMoveAllToDisk(message);
                return;

            case 'saveChartImage':
                void this._handleSaveChartImage(message.dataUrl, message.fileName);
                return;

            case 'requestRows':
                this._handleRequestRows(message);
                return;

            case 'diskQuery':
                setImmediate(() => {
                    try {
                        this._executeDiskQuery(message);
                    } catch (error) {
                        getLogger().error(
                            `Disk query failed: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                });
                return;
        }
    }

    private _resolveDiskResultSet(sourceUri: string, resultSetIndex: number) {
        return this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
    }

    private _diskQuerySpecKey(spec: DiskQuerySpec | undefined): string {
        return JSON.stringify(spec ?? {});
    }

    private _resolveDiskFilteredCount(
        resultSet: ResultSet,
        storeId: string,
        spec: DiskQuerySpec | undefined,
        totalRows: number,
        forceRecount: boolean,
    ): number {
        if (!diskQuerySpecIsActive(spec)) {
            return totalRows;
        }
        const specKey = this._diskQuerySpecKey(spec);
        if (
            !forceRecount
            && resultSet.diskQueryCountSpecKey === specKey
            && typeof resultSet.diskFilteredCount === 'number'
        ) {
            return resultSet.diskFilteredCount;
        }
        const filteredCount = this._stateManager.countDiskBackedRows(storeId, spec);
        resultSet.diskFilteredCount = filteredCount;
        resultSet.diskQueryCountSpecKey = specKey;
        return filteredCount;
    }

    private _executeDiskQuery(message: {
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
    }): void {
        const resultSet = this._resolveDiskResultSet(message.sourceUri, message.resultSetIndex);
        if (!resultSet || resultSet.storageMode !== 'sqlite' || !resultSet.diskStoreId) {
            return;
        }

        const storeId = resultSet.diskStoreId;
        const spec = message.querySpec;
        const totalRows = resultSet.totalRowCount ?? 0;

        if (spec !== undefined) {
            resultSet.diskQuerySpec = spec;
        }

        if (message.action === 'window') {
            const offset = message.offset ?? 0;
            const limit = message.limit ?? 0;
            const rows = diskQuerySpecIsActive(spec)
                ? this._stateManager.queryDiskBackedRows(storeId, spec, offset, limit)
                : this._stateManager.getDiskBackedRows(storeId, offset, limit);
            const specKey = this._diskQuerySpecKey(spec);
            const specChanged = resultSet.diskQueryCountSpecKey !== specKey;
            const filteredCount = specChanged
                ? this._resolveDiskFilteredCount(resultSet, storeId, spec, totalRows, true)
                : (typeof resultSet.diskFilteredCount === 'number'
                    ? resultSet.diskFilteredCount
                    : totalRows);

            this._callbacks.onPostMessage({
                command: 'diskQueryResult',
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                requestId: message.requestId,
                action: 'window',
                offset,
                rows: encode(this._encoder.sanitizeForMessagePack(rows)),
                filteredCount,
                totalRows,
            });

            if (offset === 0 && !specChanged && diskQuerySpecIsActive(spec)) {
                setImmediate(() => {
                    try {
                        const resolvedCount = this._resolveDiskFilteredCount(
                            resultSet,
                            storeId,
                            spec,
                            totalRows,
                            true,
                        );
                        if (resolvedCount === filteredCount) {
                            return;
                        }
                        this._callbacks.onPostMessage({
                            command: 'diskQueryResult',
                            sourceUri: message.sourceUri,
                            resultSetIndex: message.resultSetIndex,
                            requestId: message.requestId,
                            action: 'count',
                            filteredCount: resolvedCount,
                            totalRows,
                        });
                    } catch (error) {
                        getLogger().error(
                            `Disk count failed: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                });
            }
            return;
        }

        if (message.action === 'count') {
            const filteredCount = this._resolveDiskFilteredCount(
                resultSet,
                storeId,
                spec,
                totalRows,
                true,
            );
            this._callbacks.onPostMessage({
                command: 'diskQueryResult',
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                requestId: message.requestId,
                action: 'count',
                filteredCount,
                totalRows,
            });
            return;
        }

        if (message.action === 'distinct') {
            const columnIndex = message.columnIndex ?? 0;
            const distinctLimit = message.distinctLimit ?? 10_001;
            const distinct = this._stateManager.distinctDiskBackedValues(
                storeId,
                spec,
                columnIndex,
                distinctLimit,
            );
            this._callbacks.onPostMessage({
                command: 'diskQueryResult',
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                requestId: message.requestId,
                action: 'distinct',
                distinctValues: distinct.values,
                distinctTruncated: distinct.truncated,
                totalRows,
            });
            return;
        }

        if (message.action === 'aggregate') {
            const aggregations = this._stateManager.aggregateDiskBackedRows(
                storeId,
                spec,
                message.aggregations ?? [],
            );
            const filteredCount = this._resolveDiskFilteredCount(
                resultSet,
                storeId,
                spec,
                totalRows,
                false,
            );
            this._callbacks.onPostMessage({
                command: 'diskQueryResult',
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                requestId: message.requestId,
                action: 'aggregate',
                aggregations,
                totalRows,
                filteredCount,
            });
            return;
        }

        if (message.action === 'group') {
            const groupResult = this._stateManager.queryDiskBackedGroups(
                storeId,
                spec,
                message.grouping ?? [],
                message.groupPath ?? [],
                message.offset ?? 0,
                message.limit ?? 0,
                message.aggregations ?? [],
            );
            this._callbacks.onPostMessage({
                command: 'diskQueryResult',
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                requestId: message.requestId,
                action: 'group',
                groupResult,
                totalRows,
            });
        }
    }

    private _handleRequestRows(message: {
        sourceUri: string;
        resultSetIndex: number;
        offset: number;
        limit: number;
        requestId: number;
        querySpec?: DiskQuerySpec;
    }): void {
        this._stateManager.touchResultSetAccess(message.sourceUri, message.resultSetIndex);

        if (message.querySpec && diskQuerySpecIsActive(message.querySpec)) {
            setImmediate(() => {
                try {
                    this._executeDiskQuery({
                        ...message,
                        action: 'window',
                    });
                } catch (error) {
                    getLogger().error(
                        `Disk query failed: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            });
            return;
        }

        const resultSet = this._resolveDiskResultSet(message.sourceUri, message.resultSetIndex);
        if (!resultSet || resultSet.storageMode !== 'sqlite' || !resultSet.diskStoreId) {
            return;
        }

        const rows = this._stateManager.getDiskBackedRows(
            resultSet.diskStoreId,
            message.offset,
            message.limit,
        );

        this._callbacks.onPostMessage({
            command: 'rowWindow',
            sourceUri: message.sourceUri,
            resultSetIndex: message.resultSetIndex,
            offset: message.offset,
            rows: encode(this._encoder.sanitizeForMessagePack(rows)),
            requestId: message.requestId,
            totalRows: resultSet.totalRowCount,
            filteredCount: resultSet.totalRowCount,
        });
    }

    private async _handleSaveEdits(message: { command: 'saveEdits'; sourceUri: string; resultSetIndex: number; editSource: { db?: string; schema?: string; table: string }; edits: EditChange[]; deleteRowIndices?: number[] }): Promise<void> {
        const results = this._stateManager.resultsMap.get(message.sourceUri);
        const resultSet = results?.[message.resultSetIndex];
        if (resultSet?.storageMode === 'sqlite') {
            vscode.window.showWarningMessage('Inline editing is not available for disk-backed results.');
            return;
        }

        if (!this._callbacks.onSaveEdits) {
            vscode.window.showErrorMessage('Edit saving is not available in this context.');
            return;
        }
        try {
            const result = await this._callbacks.onSaveEdits({
                sourceUri: message.sourceUri,
                resultSetIndex: message.resultSetIndex,
                editSource: message.editSource,
                edits: message.edits,
                deleteRowIndices: message.deleteRowIndices
            });
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
                this._callbacks.onUpdateWebview();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to save edits: ${msg}`);
        }
    }

    public setSelectionStatsCallback(callback: (stats: SelectionStats | null) => void) {
        this._callbacks.onSelectionStatsChanged = callback;
    }

    private _handleSwitchSource(sourceUri: string): void {
        this._stateManager.setActiveSource(sourceUri);
        this._callbacks.onUpdateWebview();
    }

    private _handleSwitchToPinnedResult(resultId: string): void {
        const resultSetIndex = this._stateManager.switchToPinnedResult(resultId);
        if (resultSetIndex !== undefined) {
            this._callbacks.onUpdateWebview();
            // Send message to frontend to switch to the correct result set
            this._callbacks.onPostMessage({
                command: 'switchToResultSet',
                resultSetIndex: resultSetIndex
            });
        }
    }

    private _handleCancelQuery(sourceUri: string, currentRowCounts?: number[]): void {
        if (sourceUri) {
            console.log(`[ResultPanelMessageHandler] Received cancelQuery message for: ${sourceUri}`);
            vscode.commands.executeCommand('netezza.cancelQuery', sourceUri, currentRowCounts);
        }
    }

    private async _handleRefreshResult(sourceUri: string, resultSetIndex: number, limitValue?: string): Promise<void> {
        if (!this._callbacks.onRefreshResult) {
            vscode.window.showErrorMessage('Result refresh is not available in this context.');
            return;
        }
        await this._callbacks.onRefreshResult(sourceUri, resultSetIndex, limitValue);
    }

    private async _handleDatabaseAggregations(
        sourceUri: string,
        resultSetIndex: number,
        requestId: number,
        aggregations: DatabaseAggregationRequest[],
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<void> {
        if (!this._callbacks.onRequestDatabaseAggregations) {
            this._callbacks.onPostMessage({
                command: 'databaseAggregationResult',
                sourceUri,
                resultSetIndex,
                requestId,
                error: 'Database aggregations are not available in this context.',
            });
            return;
        }

        try {
            const results = await this._callbacks.onRequestDatabaseAggregations(
                sourceUri,
                resultSetIndex,
                aggregations,
                timeoutSeconds,
                isRetry,
            );
            this._callbacks.onPostMessage({
                command: 'databaseAggregationResult',
                sourceUri,
                resultSetIndex,
                requestId,
                aggregations: this._encoder.sanitizeForMessagePack(results) as DatabaseAggregationResult[],
            });
        } catch (error) {
            this._callbacks.onPostMessage({
                command: 'databaseAggregationResult',
                sourceUri,
                resultSetIndex,
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async _handleDatabaseFilterValues(
        sourceUri: string,
        resultSetIndex: number,
        columnIndex: number,
        requestId: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<void> {
        if (!this._callbacks.onRequestDatabaseFilterValues) {
            this._callbacks.onPostMessage({
                command: 'databaseFilterValuesResult',
                sourceUri,
                resultSetIndex,
                columnIndex,
                requestId,
                error: 'Database filter values are not available in this context.',
            });
            return;
        }
        try {
            const result = await this._callbacks.onRequestDatabaseFilterValues(
                sourceUri,
                resultSetIndex,
                columnIndex,
                querySpec,
                timeoutSeconds,
                isRetry,
            );
            this._callbacks.onPostMessage({
                command: 'databaseFilterValuesResult',
                sourceUri,
                resultSetIndex,
                columnIndex,
                requestId,
                values: this._encoder.sanitizeForMessagePack(result.values) as DiskDistinctValue[],
                truncated: result.truncated,
            });
        } catch (error) {
            this._callbacks.onPostMessage({
                command: 'databaseFilterValuesResult',
                sourceUri,
                resultSetIndex,
                columnIndex,
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async _handleApplyDatabaseFilter(
        sourceUri: string,
        resultSetIndex: number,
        requestId: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<void> {
        if (!this._callbacks.onApplyDatabaseFilter) {
            this._callbacks.onPostMessage({
                command: 'databaseFilterApplyResult',
                sourceUri,
                resultSetIndex,
                requestId,
                error: 'Database filtering is not available in this context.',
            });
            return;
        }
        try {
            await this._callbacks.onApplyDatabaseFilter(sourceUri, resultSetIndex, querySpec, timeoutSeconds, isRetry);
            this._callbacks.onPostMessage({
                command: 'databaseFilterApplyResult',
                sourceUri,
                resultSetIndex,
                requestId,
            });
            this._callbacks.onUpdateWebview();
        } catch (error) {
            this._callbacks.onPostMessage({
                command: 'databaseFilterApplyResult',
                sourceUri,
                resultSetIndex,
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private _formatLegacyInsertCellContent(text: string, dataType?: string): string {
        const normalizedText = text ?? '';
        const lowerDataType = dataType?.toLowerCase() || '';
        const isNumericType = lowerDataType.includes('int')
            || lowerDataType.includes('numeric')
            || lowerDataType.includes('decimal')
            || lowerDataType.includes('float')
            || lowerDataType.includes('double')
            || lowerDataType.includes('real')
            || lowerDataType.includes('number');
        const isBoolean = /^(true|false)$/i.test(normalizedText.trim());
        const normalizedNumericText = normalizedText.replace(/\s+/g, '');
        const isNumericValue = /^[-+]?\d+(?:\.\d+)?$/.test(normalizedNumericText);

        if (isBoolean) {
            return normalizedText.trim().toUpperCase();
        }

        if (isNumericType && isNumericValue) {
            return normalizedNumericText;
        }

        return `'${normalizedText.replace(/'/g, "''")}'`;
    }

    private _handleInsertCellContent(text: string, dataType?: string, sqlText?: string): void {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage('No active text editor found');
            return;
        }

        const formattedValue = sqlText || this._formatLegacyInsertCellContent(text, dataType);

        const position = activeEditor.selection.active;
        activeEditor.edit(editBuilder => {
            editBuilder.insert(position, formattedValue);
        }).then(() => {
            // Move cursor to the end of inserted text
            const newPosition = position.translate(0, formattedValue.length);
            activeEditor.selection = new vscode.Selection(newPosition, newPosition);
            // Focus the editor
            vscode.window.showTextDocument(activeEditor.document);
        });
    }

    private async _handleUpdateResultFormatting(message: ResultFormattingUpdateRequest): Promise<void> {
        if (!this._formattingStore || !message.sourceUri) {
            return;
        }

        const payload = await this._formattingStore.update(message);
        this._callbacks.onPostMessage({
            command: 'resultFormattingState',
            data: payload
        });
    }

    private async _handleUpdateGridFontFamily(fontFamily: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('justybase');
        await config.update('results.gridFontFamily', fontFamily, vscode.ConfigurationTarget.Global);
    }

    private async _handleUpdateGridFontSize(fontSize: number): Promise<void> {
        const config = vscode.workspace.getConfiguration('justybase');
        await config.update('results.gridFontSize', fontSize, vscode.ConfigurationTarget.Global);
    }

    private async _handleSaveChartImage(dataUrl: string, fileName?: string): Promise<void> {
        const base64Marker = 'base64,';
        const base64Index = dataUrl.indexOf(base64Marker);
        const base64Data = base64Index >= 0
            ? dataUrl.slice(base64Index + base64Marker.length)
            : dataUrl;

        if (!base64Data) {
            vscode.window.showErrorMessage('Invalid chart image data.');
            return;
        }

        let imageBuffer: Buffer;
        try {
            imageBuffer = Buffer.from(base64Data, 'base64');
        } catch {
            vscode.window.showErrorMessage('Invalid chart image encoding.');
            return;
        }

        const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        if (imageBuffer.length < pngSignature.length || !imageBuffer.subarray(0, pngSignature.length).equals(pngSignature)) {
            vscode.window.showErrorMessage('Chart image is not a valid PNG file.');
            return;
        }

        const picked = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(fileName || 'range-chart.png'),
            filters: { 'PNG Images': ['png'] },
            saveLabel: 'Save Chart'
        });

        if (!picked) {
            return;
        }

        await vscode.workspace.fs.writeFile(picked, imageBuffer);
        vscode.window.showInformationMessage(`Chart saved to ${picked.fsPath}`);
    }

    private async _handleMoveToDisk(message: { sourceUri: string; resultSetIndex: number }): Promise<void> {
        try {
            const resultSets = this._stateManager.resultsMap.get(message.sourceUri);
            const rs = resultSets?.[message.resultSetIndex];
            if (!rs) {
                vscode.window.showErrorMessage('Result set not found.');
                return;
            }
            if (rs.storageMode === 'sqlite') {
                vscode.window.showInformationMessage('Result is already stored on disk.');
                return;
            }
            if (rs.isLog) {
                vscode.window.showErrorMessage('Cannot move log results to disk.');
                return;
            }

            const props = this._stateManager.spillResultSetToDiskForced(
                message.sourceUri,
                rs,
                message.resultSetIndex,
                rs.limitReached === true,
            );

            if (!props) {
                vscode.window.showErrorMessage('Failed to move result set to disk. Disk-backed results may not be available (node:sqlite required).');
                return;
            }

            this._callbacks.onPostMessage({
                command: 'diskBackedActivate',
                sourceUri: props.sourceUri,
                resultSetIndex: props.resultSetIndex,
                totalRows: props.totalRows,
                columns: props.columns,
                rows: encode(this._encoder.sanitizeForMessagePack(props.firstPageRows)),
                limitReached: props.limitReached,
            });

            vscode.window.showInformationMessage(`Moved ${props.totalRows.toLocaleString()} rows to disk (SQLite).`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to move to disk: ${msg}`);
        }
    }

    private async _handleMoveAllToDisk(message: { sourceUri: string }): Promise<void> {
        try {
            const resultSets = this._stateManager.resultsMap.get(message.sourceUri);
            if (!resultSets || resultSets.length === 0) {
                vscode.window.showInformationMessage('No result sets to move.');
                return;
            }

            const candidates = resultSets.filter((rs) => rs && rs.storageMode !== 'sqlite' && !rs.isLog);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage('All result sets are already stored on disk.');
                return;
            }

            const choice = await vscode.window.showWarningMessage(
                `Move ${candidates.length} in-memory result set(s) to disk (SQLite)? This disables editing for those results.`,
                { modal: true },
                'Move to disk',
            );
            if (choice !== 'Move to disk') {
                return;
            }

            let movedCount = 0;
            let totalRowsMoved = 0;

            for (let i = 0; i < resultSets.length; i++) {
                const rs = resultSets[i];
                if (!rs || rs.storageMode === 'sqlite' || rs.isLog) {
                    continue;
                }

                const props = this._stateManager.spillResultSetToDiskForced(
                    message.sourceUri,
                    rs,
                    i,
                    rs.limitReached === true,
                );

                if (!props) {
                    continue;
                }

                movedCount++;
                totalRowsMoved += props.totalRows;

                this._callbacks.onPostMessage({
                    command: 'diskBackedActivate',
                    sourceUri: props.sourceUri,
                    resultSetIndex: props.resultSetIndex,
                    totalRows: props.totalRows,
                    columns: props.columns,
                    rows: encode(this._encoder.sanitizeForMessagePack(props.firstPageRows)),
                    limitReached: props.limitReached,
                });
            }

            if (movedCount === 0) {
                vscode.window.showInformationMessage('All result sets are already stored on disk.');
            } else {
                vscode.window.showInformationMessage(
                    `Moved ${movedCount} result set(s) (${totalRowsMoved.toLocaleString()} rows total) to disk (SQLite).`
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to move result sets to disk: ${msg}`);
        }
    }

    private async _handleExportToMdFile(data: { sourceUri: string; mdDocument: string }): Promise<void> {
        const choice = await vscode.window.showQuickPick(
            [
                { label: '$(file-symlink-file) Save to temp file', description: 'Auto-save and open immediately', value: 'temp' as const },
                { label: '$(folder) Choose save location...', description: 'Pick a folder and filename', value: 'choose' as const },
            ],
            { placeHolder: 'Where to save the MD export?' }
        );

        if (!choice) return;

        let uri: vscode.Uri;
        if (choice.value === 'temp') {
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const tempPath = path.join(os.tmpdir(), `sql-export-${timestamp}.md`);
            uri = vscode.Uri.file(tempPath);
        } else {
            const picked = await vscode.window.showSaveDialog({
                filters: { 'Markdown Files': ['md'] },
                saveLabel: 'Export as MD'
            });
            if (!picked) return;
            uri = picked;
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString('pl-PL', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const timeStr = now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const header = `**Generated:** ${dateStr} ${timeStr}\n\n---\n\n`;
        const fullDocument = header + data.mdDocument.replace(/^# SQL Export\n\n/, '');

        await vscode.workspace.fs.writeFile(uri, Buffer.from(fullDocument, 'utf8'));
        this._stateManager.addTextContentResult(data.sourceUri, fullDocument, 'MD Export');
        this._callbacks.onUpdateWebview();

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
    }

}
