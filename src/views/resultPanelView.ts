import * as vscode from 'vscode';
import { encode } from '@msgpack/msgpack';
import type {
    ResultPanelInboundMessage,
    ResultPanelOutboundMessage,
    ResultPanelViewData
} from '../contracts/webviews';
import type { ConnectionManager } from '../core/connectionManager';
import { ResultStateManager } from '../state/resultStateManager';
import { ExportManager } from '../export/exportManager';
import { ResultPanelMessageHandler, MessageHandlerCallbacks, SelectionStats, SaveEditsRequest } from './resultPanelMessageHandler';
import { ResultsHtmlGenerator, ViewScriptUris } from './resultsHtmlGenerator';
import { DuckDbResultBridge } from '../services/duckdbResultBridge';
import { ResultSet } from '../types';
import { detectEditSource } from '../results/editSourceDetector';
import { MessagePackEncoder } from '../core/streaming';
import { diskBackedStoreRegistry } from '../core/resultDataProvider/diskBackedStoreRegistry';
import {
    DISK_BACKED_FIRST_PAGE_SIZE,
    DISK_BACKED_STREAMING_PREVIEW_ROWS,
    DISK_BACKED_WEBVIEW_STREAM_CAP,
    STREAMING_ROW_COUNT_REPORT_INTERVAL,
    STREAMING_ROW_COUNT_REPORT_INTERVAL_NEAR_THRESHOLD,
    type DiskDistinctValue,
    type DiskQuerySpec,
} from '../core/resultDataProvider/types';
import {
    getDiskBackedResultsSettings,
    getEffectiveSpillThreshold,
    isDiskBackedResultsAvailable,
} from '../core/resultDataProvider/diskBackedSettings';
import { ResultFormattingSettingsStore } from '../results/resultFormattingSettingsStore';
import { createPerformanceTimer, formatPerformanceEvent } from '../services/perf/performanceEvents';
import { ResultPanelPerformanceStore } from '../services/perf/resultPanelPerformanceStore';
import { affectsExtensionConfiguration } from '../compatibility/configuration';
import { getConnectionForDocument } from '../core/queryRunnerHelpers';
import { ensurePersistentConnectionReadyForQuery } from '../core/connectionReadiness';
import { runQueryRaw } from '../core/queryRunner';
import {
    ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
    ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
    resolveAllRowsOperationTimeout,
} from '../results/allRowsOperationTimeouts';
import { findTrailingLimitClause, replaceTrailingLimitValue } from '../results/refreshSqlLimit';
import {
    buildDatabaseAggregationSql,
    DatabaseAggregationRequest,
    DatabaseAggregationResult,
} from '../results/databaseAggregationSql';
import {
    buildDatabaseDistinctValuesSql,
    buildDatabaseFilteredSql,
} from '../results/databaseFilterSql';

interface HydratePayloadMetrics {
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
    payloadBytes: number;
    executingSourceCount: number;
}

const DEFAULT_RESULTS_GRID_FONT_FAMILY = "Menlo, Monaco, Consolas, 'Courier New', monospace";

export class ResultPanelView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'netezza.results';

    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _stateManager: ResultStateManager;
    private _exportManager: ExportManager;
    private _duckDbResultBridge?: DuckDbResultBridge;
    private _messageHandler: ResultPanelMessageHandler;
    private _htmlGenerator?: ResultsHtmlGenerator;
    private _isViewReady: boolean = false;
    private _encoder = new MessagePackEncoder();
    private _stateChangeDisposable?: vscode.Disposable;
    private _configurationChangeDisposable?: vscode.Disposable;
    private _viewDisposables: vscode.Disposable[] = [];
    private _formattingStore?: ResultFormattingSettingsStore;
    private _performanceStore?: ResultPanelPerformanceStore;
    /** Last row count posted to webview per streaming result set (pre-insert throttling). */
    private _streamingRowCountLastReported = new Map<string, number>();
    private readonly _context?: vscode.ExtensionContext;
    private readonly _connectionManager?: ConnectionManager;

    private _setResultsFocusContext(focused: boolean): void {
        void vscode.commands.executeCommand('setContext', 'netezza.resultsFocused', focused);
    }

    private _setResultsInputFocusContext(focused: boolean): void {
        void vscode.commands.executeCommand('setContext', 'netezza.resultsInputFocused', focused);
    }

    private _clearResultsFocusContexts(): void {
        this._setResultsFocusContext(false);
        this._setResultsInputFocusContext(false);
    }

    constructor(contextOrExtensionUri: vscode.ExtensionContext | vscode.Uri, connectionManager?: ConnectionManager) {
        const context = 'extensionUri' in contextOrExtensionUri ? contextOrExtensionUri : undefined;
        this._context = context;
        this._connectionManager = connectionManager;
        this._extensionUri = context ? context.extensionUri : contextOrExtensionUri as vscode.Uri;
        this._stateManager = new ResultStateManager();
        this._exportManager = new ExportManager(this._stateManager.resultsMap);
        this._duckDbResultBridge = connectionManager
            ? new DuckDbResultBridge(this._stateManager.resultsMap, connectionManager)
            : undefined;
        this._formattingStore = context && connectionManager
            ? new ResultFormattingSettingsStore(context, connectionManager)
            : undefined;
        this._performanceStore = context
            ? new ResultPanelPerformanceStore(context)
            : undefined;

        const callbacks: MessageHandlerCallbacks = {
            onUpdateWebview: () => this._updateWebview(),
            onPostMessage: msg => this._postMessageToWebview(msg),
            onForceHydrate: () => this._forceHydrate(),
            onSelectionStatsChanged: undefined,
            onRecordHydrationMetrics: metrics => {
                void this._performanceStore?.recordFirstPaint(metrics);
            },
            onSaveEdits: request => this._handleSaveEdits(request, connectionManager),
            onGetWebviewUri: uri => this._view ? String(this._view.webview.asWebviewUri(uri)) : String(uri),
            onRefreshResult: (sourceUri, resultSetIndex, limitValue) => this._handleRefreshResult(sourceUri, resultSetIndex, limitValue),
            onRequestDatabaseAggregations: (sourceUri, resultSetIndex, aggregations, timeoutSeconds, isRetry) =>
                this._handleDatabaseAggregations(sourceUri, resultSetIndex, aggregations, timeoutSeconds, isRetry),
            onRequestDatabaseFilterValues: (sourceUri, resultSetIndex, columnIndex, querySpec, timeoutSeconds, isRetry) =>
                this._handleDatabaseFilterValues(sourceUri, resultSetIndex, columnIndex, querySpec, timeoutSeconds, isRetry),
            onApplyDatabaseFilter: (sourceUri, resultSetIndex, querySpec, timeoutSeconds, isRetry) =>
                this._handleApplyDatabaseFilter(sourceUri, resultSetIndex, querySpec, timeoutSeconds, isRetry),
            onClearRefreshFailure: (sourceUri, resultSetIndex) => {
                this._stateManager.clearResultSetRefreshFailure(sourceUri, resultSetIndex);
                this._updateWebview();
            },
        };

        this._messageHandler = new ResultPanelMessageHandler(
            this._stateManager,
            this._exportManager,
            callbacks,
            this._duckDbResultBridge,
            this._formattingStore
        );

        this._stateChangeDisposable = this._stateManager.onDidChangeState(() => {
            this._updateWebview();
        });

        void this._stateManager.onDidSpillToDisk((props) => {
            this._postDiskBackedActivateFromProps(props);
        });

        this._configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration?.(event => {
            if (
                affectsExtensionConfiguration(event, 'results.gridFontFamily')
                || event.affectsConfiguration('editor.fontFamily')
            ) {
                this._reloadWebviewHtml();
            }
            if (affectsExtensionConfiguration(event, 'results.copyFormat')) {
                const copyFormat = vscode.workspace.getConfiguration('justybase.results').get<string>('copyFormat', 'markdown') as 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon';
                this._postMessageToWebview({ command: 'updateCopyFormat', copyFormat });
            }
        });
    }

    public setSelectionStatsCallback(callback: (stats: SelectionStats | null) => void) {
        this._messageHandler.setSelectionStatsCallback(callback);
    }

    public getActiveSource(): string | undefined {
        return this._stateManager.activeSourceUri;
    }

    public getExecutingSources(): string[] {
        return Array.from(this._stateManager.executingSources);
    }

    public get onDidCancel() {
        return this._stateManager.onDidCancel;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._disposeViewDisposables();
        this._isViewReady = false;
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'media')
            ]
        };

        this._htmlGenerator = new ResultsHtmlGenerator(webviewView.webview.cspSource);
        webviewView.webview.html = this._getHtmlForWebview();

// Force re-render when view becomes visible after being hidden
    const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._isViewReady) {
        this._stateManager.setPanelVisible(true);
        this._forceHydrate({ fromVisibility: true });
      } else if (!webviewView.visible && this._isViewReady) {
        this._stateManager.setPanelVisible(false);
        // View is being hidden - save scroll positions before losing state
        this._postMessageToWebview({ command: 'saveScrollState' });
        // Clear focus context when view is hidden
        this._clearResultsFocusContexts();
      }
    });
    this._trackViewDisposable(visibilityDisposable);
    // Visibility is not the same as keyboard focus.
    this._clearResultsFocusContexts();

        // Handle messages from webview
        const receiveMessageDisposable = webviewView.webview.onDidReceiveMessage(message => {
            const inboundMessage: ResultPanelInboundMessage = message;

            if (inboundMessage.command === 'ready') {
                this._isViewReady = true;
                this._forceHydrate();
            } else if (inboundMessage.command === 'webviewFocused') {
                this._setResultsFocusContext(true);
            } else if (inboundMessage.command === 'webviewBlurred') {
                this._clearResultsFocusContexts();
            }
            this._messageHandler.handleMessage(inboundMessage);
        });
        this._trackViewDisposable(receiveMessageDisposable);

        const viewDisposeDisposable = webviewView.onDidDispose(() => {
            if (this._view === webviewView) {
                this._isViewReady = false;
                this._view = undefined;
                this._htmlGenerator = undefined;
                this._lastSentActiveSource = undefined;
            }
            this._clearResultsFocusContexts();
            this._disposeViewDisposables();
        });
        this._trackViewDisposable(viewDisposeDisposable);
    }

    public dispose(): void {
        this._disposeViewDisposables();
        this._stateChangeDisposable?.dispose();
        this._stateChangeDisposable = undefined;
        this._configurationChangeDisposable?.dispose();
        this._configurationChangeDisposable = undefined;
        this._view = undefined;
        this._htmlGenerator = undefined;
        this._clearResultsFocusContexts();
    }

  public triggerCopySelection() {
    const copyFormat = vscode.workspace.getConfiguration('justybase.results').get<string>('copyFormat', 'markdown') as 'tabbed' | 'markdown' | 'csv' | 'csv-semicolon';
    this._postMessageToWebview({ command: 'copySelection', copyFormat });
  }

  public triggerSelectAll() {
    this._postMessageToWebview({ command: 'selectAll' });
  }

  public addMdExportResult(sourceUri: string, content: string) {
    this._stateManager.addTextContentResult(sourceUri, content, 'MD Export');
    this._forceHydrate();
  }

    public getPerformanceStatsReport(): string | undefined {
        return this._performanceStore?.renderReport();
    }

    public async clearPerformanceStats(): Promise<void> {
        await this._performanceStore?.clear();
    }

    public setActiveSource(sourceUri: string) {
        if (this._stateManager.setActiveSource(sourceUri)) {
            // Send lightweight setActiveSource message first for immediate client-side switch,
            // then follow up with a full hydrate containing data.
            this._postMessageToWebview({
                command: 'setActiveSource',
                sourceUri,
                activeResultSetIndex: this._stateManager.getActiveResultSetIndex(sourceUri) ?? 0,
                executingSourcesJson: JSON.stringify(Array.from(this._stateManager.executingSources)),
                sourcesJson: JSON.stringify(Array.from(this._stateManager.resultsMap.keys())),
                pinnedSourcesJson: JSON.stringify(Array.from(this._stateManager.pinnedSources)),
                diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
                formatSettings: this._formattingStore?.getPayloadForSource(sourceUri)
            });
            this._updateWebview();
        }
    }

    private _isResultSyncSqlDocument(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
        if (!doc || !doc.uri || typeof doc.languageId !== 'string') {
            return false;
        }

        const scheme = doc.uri.scheme;
        if (!scheme) {
            return false;
        }
        if (scheme === 'untitled') {
            return true;
        }
        if (scheme !== 'file') {
            return false;
        }

        const languageId = doc.languageId.toLowerCase();
        return languageId === 'sql' || languageId === 'netezza-sql' || languageId.includes('sql');
    }

    private _syncActiveSourceWithFocusedEditor() {
        const activeEditor = vscode.window.activeTextEditor;
        if (!this._isResultSyncSqlDocument(activeEditor?.document)) {
            return;
        }

        const focusedSourceUri = activeEditor.document.uri.toString();
        if (focusedSourceUri !== this._stateManager.activeSourceUri) {
            this.setActiveSource(focusedSourceUri);
        }
    }

    public closeSource(sourceUri: string) {
        this._stateManager.closeSource(sourceUri);
        this._updateWebview();
    }

    public startExecution(sourceUri: string) {
        const { clearedUnpinnedResults } = this._stateManager.startExecution(sourceUri);
        // Full hydrate only when unpinned tabs (e.g. Error) were removed — avoids wiping
        // live/pinned state on every re-run.
        if (clearedUnpinnedResults) {
            this._stateManager.markStale(sourceUri);
        }
        this._updateWebview();
        this._revealViewForExecution();
    }

    private _isDiskBackedStreamCapEnabled(): boolean {
        return isDiskBackedResultsAvailable(getDiskBackedResultsSettings());
    }

    public log(sourceUri: string, message: string) {
        this._syncActiveSourceWithFocusedEditor();
        const update = this._stateManager.log(sourceUri, message);
        if (update && this._stateManager.activeSourceUri === sourceUri) {
            const outboundMessage: ResultPanelOutboundMessage = { ...update, sourceUri };
            this._postMessageToWebview(outboundMessage);
        } else if (!update && this._stateManager.activeSourceUri === sourceUri) {
            this._updateWebview();
        }
    }

    /**
     * Log the start of SQL execution
     * @param sourceUri The source URI
     * @param sql The SQL query being executed
     * @param connectionName The connection name
     * @returns The execution log entry ID
     */
    public logExecutionStart(sourceUri: string, sql: string, connectionName: string): string {
        this._syncActiveSourceWithFocusedEditor();
        const { id, incrementalUpdate } = this._stateManager.logExecutionStart(sourceUri, sql, connectionName);
        if (incrementalUpdate && this._stateManager.activeSourceUri === sourceUri) {
            const outboundMessage: ResultPanelOutboundMessage = { ...incrementalUpdate, sourceUri };
            this._postMessageToWebview(outboundMessage);
        }
        return id;
    }

    /**
     * Log the end of SQL execution
     * @param executionId The execution ID returned from logExecutionStart
     * @param rowCount Number of rows returned
     * @param status Status: 'success', 'error', 'cancelled', or 'retrying'
     * @param errorMessage Optional error message if status is 'error'
     */
    public logExecutionEnd(
        executionId: string,
        rowCount: number,
        status: 'success' | 'error' | 'cancelled' | 'retrying',
        errorMessage?: string
    ): void {
        this._syncActiveSourceWithFocusedEditor();
        const update = this._stateManager.logExecutionEnd(executionId, rowCount, status, errorMessage);
        if (update && update.sourceUri && update.sourceUri === this._stateManager.activeSourceUri) {
            this._postMessageToWebview(update);
        } else if (!update && this._stateManager.activeSourceUri) {
            this._updateWebview();
        }
    }

    /**
     * Get results for a source URI
     */
    public getResultsForSource(sourceUri: string) {
        return this._stateManager.resultsMap.get(sourceUri);
    }

    public isCancelled(sourceUri: string): boolean {
        return this._stateManager.isCancelled(sourceUri);
    }

    public cancelExecution(sourceUri: string, currentRowCounts?: number[]) {
        this._stateManager.cancelExecution(sourceUri, currentRowCounts);
        this._updateWebview();

        // Notify webview to discard pending messages
        this._postMessageToWebview({
            command: 'cancelExecution',
            sourceUri: sourceUri
        });
    }

    public finalizeExecution(sourceUri: string) {
        this._stateManager.finalizeExecution(sourceUri);
        this._updateWebview();
    }

    public updateResults(results: ResultSet[], sourceUri: string, append: boolean = false) {
        this._syncActiveSourceWithFocusedEditor();
        this._stateManager.updateResults(results, sourceUri, append);

        if (this._stateManager.activeSourceUri === sourceUri) {
            this._revealViewForExecution();
        }

        if (this._view) {
            this._updateWebview();
            if (this._stateManager.activeSourceUri === sourceUri) {
                this._view.show?.(true);
            }
        } else if (this._stateManager.activeSourceUri === sourceUri) {
            vscode.window.showInformationMessage(
                'Query completed. Open the "Query Results" panel from the bottom activity bar to view data.'
            );
        }
    }

    private async _handleRefreshResult(sourceUri: string, resultSetIndex: number, limitValue?: string): Promise<void> {
        if (!this._context || !this._connectionManager) {
            vscode.window.showErrorMessage('Result refresh is not available in this view.');
            return;
        }

        if (this._stateManager.executingSources.has(sourceUri)) {
            vscode.window.showWarningMessage('A query is already running for this SQL Results source.');
            return;
        }

        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const refreshSql = resultSet?.refreshSql?.trim();
        if (!resultSet || !refreshSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            vscode.window.showWarningMessage('This result set does not have refresh SQL.');
            return;
        }

        const preservedFilterSpec = resultSet.databaseFilterSpec;
        const baseRefreshSql = this._resolveRefreshSqlLimit(refreshSql, limitValue);
        if (!baseRefreshSql) {
            return;
        }
        const sqlToExecute = preservedFilterSpec
            && ((preservedFilterSpec.columnFilters?.length ?? 0) > 0 || preservedFilterSpec.globalSearch?.trim())
            ? buildDatabaseFilteredSql(baseRefreshSql, resultSet.columns, preservedFilterSpec)
            : baseRefreshSql;

        const connectionName =
            this._connectionManager.getConnectionForExecution(sourceUri)
            || this._connectionManager.getActiveConnectionName()
            || undefined;
        if (!connectionName) {
            vscode.window.showErrorMessage('No database connection. Please connect first.');
            return;
        }

        if (!this._stateManager.startResultRefresh(sourceUri, resultSetIndex)) {
            vscode.window.showWarningMessage('This result set cannot be refreshed.');
            return;
        }

        this.setActiveSource(sourceUri);
        this._revealViewForExecution();
        this.log(sourceUri, `Refreshing result ${resultSetIndex}...`);
        const executionId = this.logExecutionStart(sourceUri, sqlToExecute, connectionName);
        const startTime = Date.now();
        this._stateManager.clearResultSetRefreshFailure(sourceUri, resultSetIndex);

        try {
            await ensurePersistentConnectionReadyForQuery(
                this._connectionManager,
                sourceUri,
                connectionName,
            );

            const refreshed = await runQueryRaw({
                context: this._context,
                query: sqlToExecute,
                silent: true,
                connectionManager: this._connectionManager,
                connectionName,
                documentUri: sourceUri,
                logCallback: message => this.log(sourceUri, message),
            });

            const nextResultSet: ResultSet = {
                ...refreshed,
                sql: sqlToExecute,
                refreshSql: baseRefreshSql,
                databaseFilterSpec: preservedFilterSpec,
                name: resultSet.name,
                executionTimestamp: Date.now(),
            };
            this._stateManager.replaceResultSet(sourceUri, resultSetIndex, nextResultSet);
            this.logExecutionEnd(
                executionId,
                nextResultSet.totalRowCount ?? nextResultSet.data.length,
                'success',
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this._stateManager.setResultSetRefreshFailure(sourceUri, resultSetIndex, {
                message,
                sql: sqlToExecute,
            });
            this.logExecutionEnd(executionId, 0, 'error', message);
            vscode.window.showErrorMessage(`Refresh failed: ${message}`);
        } finally {
            this._stateManager.finalizeResultRefresh(sourceUri, resultSetIndex);
            this._updateWebview();
            const durationMs = Date.now() - startTime;
            console.log(formatPerformanceEvent({
                operation: 'result_panel.refresh_result',
                duration_ms: durationMs,
                result: 'ok',
                payload_size_bucket: 'none',
                timestamp: new Date().toISOString(),
                metadata: {
                    source_uri: sourceUri,
                    result_set_index: resultSetIndex,
                },
            }));
        }
    }

    private _resolveRefreshSqlLimit(refreshSql: string, limitValue?: string): string | undefined {
        if (limitValue === undefined) {
            return refreshSql;
        }

        const normalizedLimit = limitValue.trim();
        if (!/^\d+$/.test(normalizedLimit)) {
            vscode.window.showErrorMessage('Invalid LIMIT value for refresh.');
            return undefined;
        }

        if (!findTrailingLimitClause(refreshSql)) {
            return refreshSql;
        }

        return replaceTrailingLimitValue(refreshSql, normalizedLimit);
    }

    private _resolveConnectionForSource(sourceUri: string): string {
        const connectionName =
            this._connectionManager?.getConnectionForExecution(sourceUri)
            || this._connectionManager?.getActiveConnectionName()
            || undefined;
        if (!connectionName) {
            throw new Error('No database connection. Please connect first.');
        }
        return connectionName;
    }

    private _resolveFilterableResultSet(sourceUri: string, resultSetIndex: number): ResultSet {
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const directSql = this._resolveResultSetDirectSql(resultSet);
        if (!resultSet || !directSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            throw new Error('This result set does not have refresh SQL.');
        }
        return resultSet;
    }

    private _resolveResultSetDirectSql(resultSet: ResultSet | undefined): string {
        return (resultSet?.refreshSql || resultSet?.sql || '').trim();
    }

    private async _handleDatabaseFilterValues(
        sourceUri: string,
        resultSetIndex: number,
        columnIndex: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<{ values: DiskDistinctValue[]; truncated: boolean }> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Database filtering is not available in this view.');
        }
        const resultSet = this._resolveFilterableResultSet(sourceUri, resultSetIndex);
        const directSql = this._resolveResultSetDirectSql(resultSet);
        const sql = buildDatabaseDistinctValuesSql(
            directSql,
            resultSet.columns,
            columnIndex,
            querySpec ?? resultSet.databaseFilterSpec,
        );
        const queryResult = await runQueryRaw({
            context: this._context,
            query: sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName: this._resolveConnectionForSource(sourceUri),
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 10_002,
            isUserQuery: false,
            timeoutSeconds: resolveAllRowsOperationTimeout(
                ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
                timeoutSeconds,
                isRetry,
            ),
        });
        const values = queryResult.data.slice(0, 10_001).map((row) => ({
            raw: row[0] ?? null,
            count: typeof row[1] === 'number' ? row[1] : Number(row[1] ?? 0),
        }));
        return {
            values,
            truncated: queryResult.data.length > 10_001,
        };
    }

    private async _handleApplyDatabaseFilter(
        sourceUri: string,
        resultSetIndex: number,
        querySpec?: DiskQuerySpec,
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<void> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Database filtering is not available in this view.');
        }
        const resultSet = this._resolveFilterableResultSet(sourceUri, resultSetIndex);
        const baseRefreshSql = this._resolveResultSetDirectSql(resultSet);
        const nextFilterSpec = querySpec && ((querySpec.columnFilters?.length ?? 0) > 0 || querySpec.globalSearch?.trim())
            ? querySpec
            : undefined;
        const sqlToExecute = buildDatabaseFilteredSql(baseRefreshSql, resultSet.columns, nextFilterSpec);
        const connectionName = this._resolveConnectionForSource(sourceUri);
        const refreshed = await runQueryRaw({
            context: this._context,
            query: sqlToExecute,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName,
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            isUserQuery: false,
            timeoutSeconds: resolveAllRowsOperationTimeout(
                ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
                timeoutSeconds,
                isRetry,
            ),
        });
        const nextResultSet: ResultSet = {
            ...refreshed,
            sql: sqlToExecute,
            refreshSql: baseRefreshSql,
            databaseFilterSpec: nextFilterSpec,
            name: resultSet.name,
            executionTimestamp: Date.now(),
        };
        this._stateManager.replaceResultSet(sourceUri, resultSetIndex, nextResultSet);
    }

    private async _handleDatabaseAggregations(
        sourceUri: string,
        resultSetIndex: number,
        aggregations: DatabaseAggregationRequest[],
        timeoutSeconds?: number,
        isRetry?: boolean,
    ): Promise<DatabaseAggregationResult[]> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Database aggregations are not available in this view.');
        }

        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const refreshSql = this._resolveResultSetDirectSql(resultSet);
        if (!resultSet || !refreshSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            throw new Error('This result set does not have refresh SQL.');
        }

        const built = buildDatabaseAggregationSql(refreshSql, resultSet.columns, aggregations, resultSet.databaseFilterSpec);
        const connectionName =
            this._connectionManager.getConnectionForExecution(sourceUri)
            || this._connectionManager.getActiveConnectionName()
            || undefined;
        if (!connectionName) {
            throw new Error('No database connection. Please connect first.');
        }

        const queryResult = await runQueryRaw({
            context: this._context,
            query: built.sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName,
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 1,
            isUserQuery: false,
            timeoutSeconds: resolveAllRowsOperationTimeout(
                ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
                timeoutSeconds,
                isRetry,
            ),
        });

        const firstRow = queryResult.data[0] ?? [];
        const valueByColumnName = new Map<string, unknown>();
        queryResult.columns.forEach((column, index) => {
            valueByColumnName.set(column.name, firstRow[index]);
            valueByColumnName.set(column.name.toLowerCase(), firstRow[index]);
        });

        return built.aliases.map(alias => ({
            columnIndex: alias.columnIndex,
            fn: alias.fn,
            value: valueByColumnName.get(alias.alias) ?? valueByColumnName.get(alias.alias.toLowerCase()) ?? null,
        }));
    }

    public appendStreamingChunk(
        sourceUri: string,
        _queryIndex: number,
        chunk: {
            columns: { name: string; type?: string; scale?: number }[];
            rows: unknown[][];
            isFirstChunk: boolean;
            isLastChunk: boolean;
            totalRowsSoFar: number;
            limitReached: boolean;
        },
        sql: string,
        refreshSql?: string,
    ) {
        this._syncActiveSourceWithFocusedEditor();
        const isActiveSource = this._stateManager.activeSourceUri === sourceUri;
        const resultSetIndex = this._resolveStreamingResultSetIndex(sourceUri, chunk);

        if (chunk.isFirstChunk) {
            this._streamingRowCountLastReported.delete(
                this._streamingRowCountKey(sourceUri, resultSetIndex),
            );
        }

        if (
            isActiveSource
            && this._shouldPreReportStreamingRowCount(sourceUri, resultSetIndex, chunk.totalRowsSoFar)
            && this._shouldEmitStreamingRowCountReport(sourceUri, resultSetIndex, chunk.totalRowsSoFar, chunk.isLastChunk)
        ) {
            this._postStreamingRowCountUpdate(
                sourceUri,
                resultSetIndex,
                chunk.totalRowsSoFar,
                chunk.limitReached,
            );
        }

        const result = this._stateManager.appendStreamingChunk(sourceUri, chunk, sql, refreshSql);

        if (result.type === 'diskBackedActivate' && isActiveSource) {
            this._revealViewForExecution();
            this._postLightweightActiveSourceUpdate(sourceUri);
            this._view?.show?.(true);
            this._postMessageToWebview({
                command: 'diskBackedActivate',
                sourceUri: result.props.sourceUri,
                resultSetIndex: result.props.resultSetIndex,
                totalRows: result.props.totalRows,
                columns: result.props.columns,
                rows: encode(this._encoder.sanitizeForMessagePack(result.props.firstPageRows)),
                limitReached: result.props.limitReached,
            });
            this._streamingRowCountLastReported.set(
                this._streamingRowCountKey(sourceUri, result.props.resultSetIndex),
                result.props.totalRows,
            );
            void vscode.window.showInformationMessage(
                `Disk-backed results activated (${result.props.totalRows.toLocaleString()} rows) to reduce memory usage.`
            );
        } else if (result.type === 'rowCountUpdate' && isActiveSource) {
            if (
                this._shouldEmitStreamingRowCountReport(
                    sourceUri,
                    result.props.resultSetIndex,
                    result.props.totalRows,
                    chunk.isLastChunk,
                )
            ) {
                this._postStreamingRowCountUpdate(
                    sourceUri,
                    result.props.resultSetIndex,
                    result.props.totalRows,
                    result.props.limitReached,
                );
            }
        } else if (result.type === 'incremental' && isActiveSource) {
            if (result.props.isFirstChunk) {
                this._revealViewForExecution();
                this._postLightweightActiveSourceUpdate(sourceUri);
                this._view?.show?.(true);
            }

            const skipWebviewRows = this._shouldCapWebviewRowStream(
                sourceUri,
                result.props.resultSetIndex,
                chunk.totalRowsSoFar,
            );

            if (skipWebviewRows) {
                this._postStreamingRowCountUpdate(
                    sourceUri,
                    result.props.resultSetIndex,
                    chunk.totalRowsSoFar,
                    result.props.limitReached,
                );
            } else {
                const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[result.props.resultSetIndex];
                let rowsToSend = chunk.rows;
                if (
                    resultSet
                    && chunk.totalRowsSoFar > DISK_BACKED_WEBVIEW_STREAM_CAP
                    && isDiskBackedResultsAvailable(getDiskBackedResultsSettings())
                ) {
                    const streamed = resultSet.webviewStreamedRows ?? 0;
                    const remaining = Math.max(0, DISK_BACKED_STREAMING_PREVIEW_ROWS - streamed);
                    rowsToSend = remaining > 0 ? chunk.rows.slice(0, remaining) : [];
                    resultSet.webviewStreamedRows = streamed + rowsToSend.length;
                }

                if (rowsToSend.length === 0 && result.props.isFirstChunk !== true) {
                    this._postStreamingRowCountUpdate(
                        sourceUri,
                        result.props.resultSetIndex,
                        chunk.totalRowsSoFar,
                        result.props.limitReached,
                    );
                } else {
                    const encodedMessage: ResultPanelOutboundMessage = {
                        ...result.props,
                        rows: encode(this._encoder.sanitizeForMessagePack(rowsToSend)),
                        sourceUri,
                        diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
                    };
                    this._postMessageToWebview(encodedMessage);
                }
            }
        }

        if (chunk.isLastChunk) {
            this._stateManager.markStreamingCompleted(sourceUri);
            if (isActiveSource) {
                const resultSets = this._stateManager.resultsMap.get(sourceUri);
                const finalResultSetIndex = (resultSets?.length || 0) - 1;
                const activeResultSet = resultSets?.[finalResultSetIndex];
                this._postStreamingRowCountUpdate(
                    sourceUri,
                    finalResultSetIndex,
                    chunk.totalRowsSoFar,
                    activeResultSet?.limitReached === true || chunk.limitReached,
                    true,
                );
                this._postMessageToWebview({
                    command: 'streamingComplete',
                    sourceUri,
                    resultSetIndex: finalResultSetIndex,
                    totalRows: chunk.totalRowsSoFar,
                    limitReached: activeResultSet?.limitReached === true
                });
            }
        }
    }

    private _streamingRowCountKey(sourceUri: string, resultSetIndex: number): string {
        return `${sourceUri}::${resultSetIndex}`;
    }

    private _resolveStreamingResultSetIndex(
        sourceUri: string,
        chunk: { isFirstChunk: boolean; columns: { name: string }[] },
    ): number {
        const existing = this._stateManager.resultsMap.get(sourceUri) ?? [];
        if (chunk.isFirstChunk && chunk.columns.length > 0) {
            return existing.length;
        }
        return Math.max(0, existing.length - 1);
    }

    private _shouldPreReportStreamingRowCount(
        sourceUri: string,
        resultSetIndex: number,
        totalRowsSoFar: number,
    ): boolean {
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        if (resultSet?.storageMode === 'sqlite') {
            return true;
        }
        const settings = getDiskBackedResultsSettings();
        if (!isDiskBackedResultsAvailable(settings)) {
            return false;
        }
        return totalRowsSoFar >= getEffectiveSpillThreshold(settings) - STREAMING_ROW_COUNT_REPORT_INTERVAL_NEAR_THRESHOLD;
    }

    private _shouldEmitStreamingRowCountReport(
        sourceUri: string,
        resultSetIndex: number,
        totalRowsSoFar: number,
        isLastChunk: boolean,
    ): boolean {
        if (totalRowsSoFar <= 0) {
            return false;
        }
        if (isLastChunk) {
            return true;
        }
        const interval = this._streamingRowCountReportInterval(sourceUri, resultSetIndex, totalRowsSoFar);
        const key = this._streamingRowCountKey(sourceUri, resultSetIndex);
        const lastReported = this._streamingRowCountLastReported.get(key);
        if (lastReported === undefined) {
            return totalRowsSoFar >= interval;
        }
        return totalRowsSoFar - lastReported >= interval;
    }

    private _streamingRowCountReportInterval(
        sourceUri: string,
        resultSetIndex: number,
        totalRowsSoFar: number,
    ): number {
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        if (resultSet?.storageMode === 'sqlite') {
            return STREAMING_ROW_COUNT_REPORT_INTERVAL;
        }
        if (this._shouldPreReportStreamingRowCount(sourceUri, resultSetIndex, totalRowsSoFar)) {
            return STREAMING_ROW_COUNT_REPORT_INTERVAL_NEAR_THRESHOLD;
        }
        return STREAMING_ROW_COUNT_REPORT_INTERVAL;
    }

    private _postStreamingRowCountUpdate(
        sourceUri: string,
        resultSetIndex: number,
        totalRows: number,
        limitReached: boolean,
        force = false,
    ): void {
        const key = this._streamingRowCountKey(sourceUri, resultSetIndex);
        const lastReported = this._streamingRowCountLastReported.get(key);
        if (!force && lastReported === totalRows) {
            return;
        }
        this._streamingRowCountLastReported.set(key, totalRows);
        this._postMessageToWebview({
            command: 'rowCountUpdate',
            sourceUri,
            resultSetIndex,
            totalRows,
            limitReached,
        });
    }

    private _isDisposable(value: unknown): value is vscode.Disposable {
        return (
            typeof value === 'object' &&
            value !== null &&
            'dispose' in value &&
            typeof (value as { dispose: unknown }).dispose === 'function'
        );
    }

    private _trackViewDisposable(disposable: unknown): void {
        if (this._isDisposable(disposable)) {
            this._viewDisposables.push(disposable);
        }
    }

    private _disposeViewDisposables(): void {
        const disposables = this._viewDisposables;
        this._viewDisposables = [];
        disposables.forEach(disposable => disposable.dispose());
    }

    private _postMessageToWebview(message: ResultPanelOutboundMessage) {
        if (this._view) {
            void this._view.webview.postMessage(message);
        }
    }

    private _revealViewForExecution() {
        if (this._view) {
            this._view.show?.(true);
            return;
        }

        void Promise.resolve(vscode.commands.executeCommand(`${ResultPanelView.viewType}.focus`)).catch(() => undefined);
    }

    private _lastSentActiveSource: string | undefined;

    /** Track last version sent to webview for streaming-completed sources. */
    private _lastStreamingFinalizeVersion: Map<string, number> = new Map();

    private _updateWebview() {
        if (!this._view) {
            return;
        }

        this._syncActiveSourceWithFocusedEditor();

        const activeSource = this._stateManager.activeSourceUri;
        const currentVersion = activeSource ? this._stateManager.getDataVersion(activeSource) : 0;
        const lastSentVersion = activeSource ? this._stateManager.getSentDataVersion(activeSource) : -1;
        const globalChanged = this._stateManager.globalStateVersion !== this._stateManager.lastSentGlobalStateVersion;
        const isStale = activeSource ? this._stateManager.isStale(activeSource) : false;
        const sourceChanged = activeSource !== this._lastSentActiveSource;

        // After streaming, webview already has rows via appendRows.
        // Skip full hydrate when only the data version bumped (finalizeExecution).
        const streamingCompleted = activeSource ? this._stateManager.isStreamingCompleted(activeSource) : false;
        if (streamingCompleted && !isStale && !sourceChanged && activeSource && currentVersion !== lastSentVersion) {
            const lastStreamingVersion = this._lastStreamingFinalizeVersion.get(activeSource) ?? -1;
            if (currentVersion === lastStreamingVersion) {
                return;
            }

            if (!this._memoryResultNeedsFullHydrateAfterStreaming(activeSource)) {
                this._lastStreamingFinalizeVersion.set(activeSource, currentVersion);
                this._stateManager.setSentDataVersion(activeSource, currentVersion);
                this._stateManager.lastSentGlobalStateVersion = this._stateManager.globalStateVersion;

                if (this._isViewReady) {
                    this._postLightweightActiveSourceUpdate(activeSource);
                }
                return;
            }
            // Without SQLite, in-memory results above the stream cap need a full hydrate for scrolling.
        }

        // While a query is streaming, the webview receives rows via appendRows.
        // Skip full hydrate on data-version bumps — it replaces live grid state and can crash hydration.
        const isActivelyStreaming = Boolean(
            activeSource && this._stateManager.executingSources.has(activeSource),
        );
        if (
            isActivelyStreaming
            && this._isViewReady
            && !isStale
            && !sourceChanged
            && lastSentVersion >= 0
        ) {
            if (globalChanged || currentVersion !== lastSentVersion) {
                this._postLightweightActiveSourceUpdate(activeSource!);
                this._stateManager.setSentDataVersion(activeSource!, currentVersion);
                this._stateManager.lastSentGlobalStateVersion = this._stateManager.globalStateVersion;
                this._lastSentActiveSource = activeSource;
            }
            return;
        }

        if (isStale || globalChanged || !activeSource || currentVersion !== lastSentVersion || sourceChanged) {
            const reason =
                isStale ? 'stale' :
                    globalChanged ? 'global-change' :
                        !activeSource ? 'no-active-source' :
                            currentVersion !== lastSentVersion ? 'data-version' :
                                'source-changed';
            const timer = createPerformanceTimer('result_panel.hydrate', {});
            const { viewData, metrics } = this._prepareViewData();

            if (this._isViewReady) {
                if (activeSource) {
                    this._stateManager.setSentDataVersion(activeSource, currentVersion);
                    this._stateManager.clearStale(activeSource);
                    if (this._stateManager.isStreamingCompleted(activeSource)) {
                        this._lastStreamingFinalizeVersion.set(activeSource, currentVersion);
                    }
                }
                this._stateManager.lastSentGlobalStateVersion = this._stateManager.globalStateVersion;
                this._lastSentActiveSource = activeSource;

                console.log(formatPerformanceEvent(timer.finish({
                    payloadSizeOverride: metrics.payloadBytes,
                    metadata: {
                        reason,
                        active_source: metrics.activeSource ?? null,
                        result_set_count: metrics.resultSetCount,
                        total_row_count: metrics.totalRowCount,
                        executing_source_count: metrics.executingSourceCount
                    }
                })));
                this._postMessageToWebview({
                    command: 'hydrate',
                    data: viewData
                });
            } else {
                this._view.webview.html = this._getHtmlForWebview();
            }
            return;
        }

        console.log(
            `[ResultPanelView] Data for ${activeSource} is current (v${currentVersion}), skipping no-op update`
        );
    }

    private _forceHydrate(options?: { fromVisibility?: boolean }) {
        if (!this._view || !this._isViewReady) {
            return;
        }

        if (options?.fromVisibility) {
            const activeSource = this._stateManager.activeSourceUri;
            if (activeSource && this._stateManager.isStreamingCompleted(activeSource)) {
                const currentVersion = this._stateManager.getDataVersion(activeSource);
                const lastSentVersion = this._stateManager.getSentDataVersion(activeSource);
                if (currentVersion === lastSentVersion && !this._stateManager.isStale(activeSource)) {
                    this._postMessageToWebview({ command: 'refreshView' });
                    return;
                }
            }
        }

        this._stateManager.markAllStale();
        this._updateWebview();
    }

    private _postLightweightActiveSourceUpdate(sourceUri: string): void {
        this._postMessageToWebview({
            command: 'setActiveSource',
            sourceUri,
            activeResultSetIndex: this._stateManager.getActiveResultSetIndex(sourceUri) ?? 0,
            executingSourcesJson: JSON.stringify(Array.from(this._stateManager.executingSources)),
            sourcesJson: JSON.stringify(Array.from(this._stateManager.resultsMap.keys())),
            pinnedSourcesJson: JSON.stringify(Array.from(this._stateManager.pinnedSources)),
            diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
            formatSettings: this._formattingStore
                ? this._formattingStore.getPayloadForSource(sourceUri)
                : undefined,
        });
    }

    private _reloadWebviewHtml(): void {
        if (!this._view) {
            return;
        }

        this._isViewReady = false;
        this._view.webview.html = this._getHtmlForWebview();
    }

    private _getResultGridFontFamily(): string {
        const workspaceGetConfiguration = typeof vscode.workspace.getConfiguration === 'function'
            ? vscode.workspace.getConfiguration.bind(vscode.workspace)
            : undefined;
        const resultsConfiguration = workspaceGetConfiguration?.('justybase.results');
        const configuredFontFamily = String(
            resultsConfiguration?.get<string>('gridFontFamily', DEFAULT_RESULTS_GRID_FONT_FAMILY)
                || DEFAULT_RESULTS_GRID_FONT_FAMILY
        ).trim();

        if (!configuredFontFamily) {
            return DEFAULT_RESULTS_GRID_FONT_FAMILY;
        }

        if (configuredFontFamily.toLowerCase() === 'editor') {
            const editorConfiguration = workspaceGetConfiguration?.('editor');
            return editorConfiguration?.get<string>(
                'fontFamily',
                DEFAULT_RESULTS_GRID_FONT_FAMILY
            ) || DEFAULT_RESULTS_GRID_FONT_FAMILY;
        }

        return configuredFontFamily;
    }

    private _getResultGridFontSize(): number {
        const workspaceGetConfiguration = typeof vscode.workspace.getConfiguration === 'function'
            ? vscode.workspace.getConfiguration.bind(vscode.workspace)
            : undefined;
        const resultsConfiguration = workspaceGetConfiguration?.('justybase.results');
        return resultsConfiguration?.get<number>('gridFontSize', 12) || 12;
    }

    private _getHtmlForWebview() {
        if (!this._htmlGenerator) return '';
        const uris = this._getScriptUris();
        return this._htmlGenerator.generateHtml(uris, {
            resultGridFontFamily: this._getResultGridFontFamily(),
            resultGridFontSize: this._getResultGridFontSize(),
            defaultCopyFormat: vscode.workspace.getConfiguration('justybase.results').get<string>('copyFormat', 'markdown')
        });
    }

    private _getScriptUris(): ViewScriptUris {
        return {
            scriptUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-table-core.js')
            ),
            virtualUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-virtual-core.js')
            ),
            mainScriptUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'resultPanel.js')
            ),
            workerUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'searchWorker.js')
            ),
            styleUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'resultPanel.css')
            ),
            fontRegularUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'fonts', 'JetBrainsMono-Regular.woff2')
            ),
            fontBoldUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'fonts', 'JetBrainsMono-Bold.woff2')
            ),
            fontMediumUri: this._view!.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'fonts', 'JetBrainsMono-Medium.woff2')
            ),

        };
    }

    private _prepareViewData(): { viewData: ResultPanelViewData; metrics: HydratePayloadMetrics } {
        const sources = Array.from(this._stateManager.resultsMap.keys());
        const pinnedSources = Array.from(this._stateManager.pinnedSources);
        const pinnedResults = Array.from(this._stateManager.pinnedResults.entries()).map(([id, info]) => ({
            id,
            ...info
        }));
        const activeSource =
            this._stateManager.activeSourceUri && this._stateManager.resultsMap.has(this._stateManager.activeSourceUri)
                ? this._stateManager.activeSourceUri
                : sources.length > 0
                    ? sources[0]
                    : null;
        const activeResultSets = activeSource
            ? this._prepareResultSetsForWebview(this._stateManager.resultsMap.get(activeSource) || [])
            : [];

        if (activeSource && activeResultSets.length === 0) {
            const timestamp = new Date().toLocaleTimeString();
            const emptyLog: ResultSet = {
                columns: [
                    { name: 'Time', type: 'string' },
                    { name: 'Message', type: 'string' }
                ],
                data: [[timestamp, 'No results yet']],
                message: 'No results yet',
                executionTimestamp: 0,
                isLog: true,
                name: 'Logs'
            } as ResultSet;
            this._stateManager.resultsMap.set(activeSource, [emptyLog]);
            activeResultSets.push(emptyLog);
        }

        const activeResultSetIndex =
            activeSource && this._stateManager.getActiveResultSetIndex(activeSource) !== undefined
                ? this._stateManager.getActiveResultSetIndex(activeSource)!
                : 0;

        // Annotate each result set with editability info (inline editing)
        for (const rs of activeResultSets) {
            if (!rs) {
                continue;
            }
            if (rs.storageMode === 'sqlite') {
                rs.isEditable = false;
                continue;
            }
            if (rs.sql && !rs.isLog && !rs.isError) {
                const editSource = detectEditSource(rs.sql);
                if (editSource) {
                    rs.isEditable = true;
                    rs.editSource = editSource;
                }
            }
        }

        const resultSetsMsgPack = encode(this._encoder.sanitizeForMessagePack(activeResultSets));
        const totalRowCount = activeResultSets.reduce(
            (sum, resultSet) => sum + this._getWebviewRowCount(resultSet),
            0
        );

        return {
            viewData: {
                sourcesJson: JSON.stringify(sources),
                pinnedSourcesJson: JSON.stringify(pinnedSources),
                pinnedResultsJson: JSON.stringify(pinnedResults),
                activeSourceJson: JSON.stringify(activeSource),
                resultSetsMsgPack,
                activeResultSetIndex: activeResultSetIndex,
                executingSourcesJson: JSON.stringify(Array.from(this._stateManager.executingSources)),
                formatSettings: activeSource && this._formattingStore
                    ? this._formattingStore.getPayloadForSource(activeSource)
                    : {
                        global: {
                            integer: { useGrouping: true, groupSeparator: ' ' },
                            decimal: {
                                useGrouping: true,
                                groupSeparator: ' ',
                                decimalSeparator: '.',
                                scale: 4,
                                preserveTrailingZeros: true,
                                roundingMode: 'half-up'
                            },
                            useFormattedValuesForExport: false
                        },
                        columnOverrides: {}
                    },
                queryRowLimit: vscode.workspace.getConfiguration('justybase.query').get<number>('rowLimit', 200_000),
                maxDataResults: vscode.workspace.getConfiguration('justybase.results').get<number>('maxDataResults', 50),
                diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
                dataVersion: activeSource ? this._stateManager.getDataVersion(activeSource) : 0,
            },
            metrics: {
                activeSource,
                resultSetCount: activeResultSets.length,
                totalRowCount,
                payloadBytes: resultSetsMsgPack.byteLength,
                executingSourceCount: this._stateManager.executingSources.size
            }
        };
    }

    /**
     * True when a completed in-memory result stayed above the webview stream cap and SQLite
     * spill is unavailable — only then do we need a full hydrate after streaming.
     */
    private _memoryResultNeedsFullHydrateAfterStreaming(sourceUri: string): boolean {
        if (isDiskBackedResultsAvailable(getDiskBackedResultsSettings())) {
            return false;
        }

        const resultSets = this._stateManager.resultsMap.get(sourceUri) ?? [];
        return resultSets.some(rs => {
            if (!rs || rs.isLog || rs.isError || rs.storageMode === 'sqlite') {
                return false;
            }
            const total = rs.totalRowCount ?? rs.data.length;
            return total > DISK_BACKED_WEBVIEW_STREAM_CAP;
        });
    }

    private _postDiskBackedActivateFromProps(props: {
        sourceUri: string;
        resultSetIndex: number;
        totalRows: number;
        columns: ResultSet['columns'];
        firstPageRows: unknown[][];
        limitReached: boolean;
    }): void {
        const isActiveSource = this._stateManager.activeSourceUri === props.sourceUri;
        if (!isActiveSource || !this._isViewReady) {
            return;
        }

        this._postMessageToWebview({
            command: 'diskBackedActivate',
            sourceUri: props.sourceUri,
            resultSetIndex: props.resultSetIndex,
            totalRows: props.totalRows,
            columns: props.columns,
            rows: encode(this._encoder.sanitizeForMessagePack(props.firstPageRows)),
            limitReached: props.limitReached,
        });
    }

    private _shouldCapWebviewRowStream(
        sourceUri: string,
        resultSetIndex: number,
        totalRowsSoFar: number,
    ): boolean {
        const settings = getDiskBackedResultsSettings();
        if (!isDiskBackedResultsAvailable(settings)) {
            return false;
        }
        if (totalRowsSoFar <= DISK_BACKED_WEBVIEW_STREAM_CAP) {
            return false;
        }
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const streamed = resultSet?.webviewStreamedRows ?? 0;
        return streamed >= DISK_BACKED_STREAMING_PREVIEW_ROWS;
    }

    private _getWebviewRowCount(resultSet: ResultSet): number {
        if (resultSet.storageMode === 'sqlite') {
            return resultSet.totalRowCount
                ?? diskBackedStoreRegistry.get(resultSet.diskStoreId ?? '')?.getTotalRows()
                ?? 0;
        }
        return resultSet.data.length;
    }

    private _prepareResultSetsForWebview(resultSets: ResultSet[]): ResultSet[] {
        return resultSets.map((resultSet) => {
            if (!resultSet) {
                return resultSet;
            }
            if (resultSet.storageMode !== 'sqlite' || !resultSet.diskStoreId || resultSet.isLog) {
                return resultSet;
            }

            const store = diskBackedStoreRegistry.get(resultSet.diskStoreId);
            const totalRowCount = resultSet.totalRowCount ?? store?.getTotalRows() ?? 0;
            const firstPage = store?.getRows({ offset: 0, limit: DISK_BACKED_FIRST_PAGE_SIZE }) ?? [];

            return {
                ...resultSet,
                data: firstPage,
                totalRowCount,
                diskWindowStart: 0,
                storageMode: 'sqlite' as const,
                isEditable: false,
            };
        });
    }

    private async _handleSaveEdits(request: SaveEditsRequest, connectionManager?: ConnectionManager): Promise<{ success: boolean; message: string }> {
        if (!connectionManager) {
            return { success: false, message: 'No connection manager available.' };
        }

        const { sourceUri, resultSetIndex, editSource, edits, deleteRowIndices } = request;
        if (!edits || edits.length === 0) {
            return { success: false, message: 'No edits to save.' };
        }

        // Build the full table name
        const tableParts: string[] = [];
        if (editSource.db) tableParts.push(editSource.db);
        if (editSource.schema) tableParts.push(editSource.schema);
        tableParts.push(editSource.table);
        const fullTableName = tableParts.map(p => `"${p.replace(/"/g, '""')}"`).join('.');

        // Get the result set data to look up original values
        const resultSets = this._stateManager.resultsMap.get(sourceUri);
        if (!resultSets || !resultSets[resultSetIndex]) {
            return { success: false, message: 'Result set not found.' };
        }
        const rs = resultSets[resultSetIndex];

        try {
            const connectionName = connectionManager.getConnectionForExecution(sourceUri);
            if (!connectionName) {
                return { success: false, message: 'No connection found for this source.' };
            }

            const { connection, shouldCloseConnection } = await getConnectionForDocument(
                connectionManager, connectionName, true, undefined
            );

            try {
                // Handle deletes first
                let deletedCount = 0;
                if (deleteRowIndices && deleteRowIndices.length > 0) {
                    for (const delRowIdx of deleteRowIndices) {
                        const origRow = rs.data[delRowIdx];
                        if (!origRow) continue;
                        const whereClausesDel: string[] = [];
                        for (let ci = 0; ci < rs.columns.length; ci++) {
                            const colDef = rs.columns[ci];
                            const origVal = origRow[ci];
                            if (origVal === null || origVal === undefined) continue;
                            const colName = `"${colDef.name.replace(/"/g, '""')}"`;
                            whereClausesDel.push(`${colName} = ${this._formatEditValue(origVal, colDef.type)}`);
                        }
                        if (whereClausesDel.length === 0) continue;
                        const delSql = `DELETE FROM ${fullTableName} WHERE ${whereClausesDel.join(' AND ')}`;
                        const delCmd = connection.createCommand(delSql);
                        const delReader = await delCmd.executeReader();
                        while (await delReader.read()) { /* consume */ }
                        await delReader.close();
                        if (delCmd._recordsAffected > 0) {
                            deletedCount++;
                        }
                    }
                }

                // Group edits by rowIndex
                let updatedRowCount = 0;
                const editsByRow = new Map<number, { columnIndex: number; newValue: unknown }[]>();
                for (const edit of edits) {
                    const existing = editsByRow.get(edit.rowIndex) || [];
                    existing.push({ columnIndex: edit.columnIndex, newValue: edit.newValue });
                    editsByRow.set(edit.rowIndex, existing);
                }

                for (const [rowIndex, rowEdits] of editsByRow) {
                    const originalRow = rs.data[rowIndex];
                    if (!originalRow) continue;

                    // Build SET clause for each edited column
                    const setClauses: string[] = [];
                    for (const edit of rowEdits) {
                        const colDef = rs.columns[edit.columnIndex];
                        if (!colDef) continue;
                        const colName = `"${colDef.name.replace(/"/g, '""')}"`;
                        const formattedVal = this._formatEditValue(edit.newValue, colDef.type);
                        setClauses.push(`${colName} = ${formattedVal}`);
                    }

                    if (setClauses.length === 0) continue;

                    // Build WHERE clause using original non-null column values.
                    // NULL values are skipped (col IS NULL is too broad and risky).
                    // Row identification relies on non-null columns only.
                    const whereClauses: string[] = [];
                    for (let ci = 0; ci < rs.columns.length; ci++) {
                        const colDef = rs.columns[ci];
                        const origVal = originalRow[ci];
                        if (origVal === null || origVal === undefined) continue;
                        const colName = `"${colDef.name.replace(/"/g, '""')}"`;
                        const formattedVal = this._formatEditValue(origVal, colDef.type);
                        whereClauses.push(`${colName} = ${formattedVal}`);
                    }

                    // Safety check: if no WHERE clause could be built, skip this row
                    if (whereClauses.length === 0) continue;

                    const sql = `UPDATE ${fullTableName} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
                    const cmd = connection.createCommand(sql);
                    const reader = await cmd.executeReader();
                    while (await reader.read()) { /* consume */ }
                    await reader.close();
                    if (cmd._recordsAffected > 0) {
                        updatedRowCount++;
                    }
                }

                const parts: string[] = [];
                if (updatedRowCount > 0) parts.push(`${updatedRowCount} row(s) updated`);
                if (deletedCount > 0) parts.push(`${deletedCount} row(s) deleted`);
                if (parts.length === 0) {
                    return { success: false, message: 'No rows were updated or deleted. The original row data may no longer match the database values.' };
                }
                return { success: true, message: parts.join(', ') + '.' };
            } finally {
                if (shouldCloseConnection) {
                    await connection.close();
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, message: `Failed to save edits: ${msg}` };
        }
    }

    private _formatEditValue(value: unknown, dataType?: string): string {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';

        // Handle Date objects for timestamp/date columns.
        // Netezza driver returns Date objects in UTC; use UTC methods so the
        // formatted literal matches the database's stored value exactly.
        if (value instanceof Date) {
            const y = value.getUTCFullYear();
            const m = String(value.getUTCMonth() + 1).padStart(2, '0');
            const d = String(value.getUTCDate()).padStart(2, '0');
            const hh = String(value.getUTCHours()).padStart(2, '0');
            const mm = String(value.getUTCMinutes()).padStart(2, '0');
            const ss = String(value.getUTCSeconds()).padStart(2, '0');
            const dt = dataType?.toLowerCase() ?? '';
            if (dt.includes('date') && !dt.includes('timestamp') && !dt.includes('time')) {
                return `'${y}-${m}-${d}'`;
            }
            return `'${y}-${m}-${d} ${hh}:${mm}:${ss}'`;
        }

        const str = String(value);
        // Check if it's a numeric string
        if (dataType && (dataType.toLowerCase().includes('int') || dataType.toLowerCase().includes('numeric')
            || dataType.toLowerCase().includes('decimal') || dataType.toLowerCase().includes('float')
            || dataType.toLowerCase().includes('double') || dataType.toLowerCase().includes('real'))) {
            const cleanNum = str.replace(/[\s\u00A0,]/g, '');
            if (/^[-+]?\d+(?:\.\d+)?$/.test(cleanNum)) return cleanNum;
        }
        // Escape single quotes for string values
        return `'${str.replace(/'/g, "''")}'`;
    }
}
