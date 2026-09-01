import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { encode } from '@msgpack/msgpack';
import type {
    ResultPanelOutboundMessage,
    ResultPanelViewData,
    ResultPanelTraceEventPayload,
    ResultPanelTestBridgeResult,
} from '../contracts/webviews';
import { parseResultPanelWebviewMessage } from '../contracts/webviews/resultPanelRuntime';
import type { ConnectionManager } from '../core/connectionManager';
import { ResultStateManager } from '../state/resultStateManager';
import { ensureResultSetId } from '../state/resultSetIdentity';
import { ExportManager } from '../export/exportManager';
import {
    ResultPanelMessageHandler,
    MessageHandlerCallbacks,
    SelectionStats,
    SaveEditsRequest,
    AllRowsExportRequest,
    TestExportRequest,
} from './resultPanelMessageHandler';
import { ResultsHtmlGenerator, ViewScriptUris } from './resultsHtmlGenerator';
import { DuckDbResultBridge } from '../services/duckdbResultBridge';
import { ResultSet } from '../types';
import { detectEditSource } from '../results/editSourceDetector';
import { MessagePackEncoder } from '../core/streaming';
import { streamingManager } from '../core/queryCancellation';
import { diskBackedStoreRegistry } from '../core/resultDataProvider/diskBackedStoreRegistry';
import { setContextIfChanged } from '../services/contextKeyService';
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
import { getUxPerfSession } from '../services/perf/uxPerfSession';
import { ResultPanelPerformanceStore } from '../services/perf/resultPanelPerformanceStore';
import { affectsExtensionConfiguration } from '../compatibility/configuration';
import { getConnectionForDocument } from '../core/queryRunnerHelpers';
import { ensurePersistentConnectionReadyForQuery } from '../core/connectionReadiness';
import { runQueryRaw } from '../core/queryRunner';
import { MigrationWizardView } from './migrationWizardView';
import {
    ALL_ROWS_AGGREGATIONS_TIMEOUT_SECONDS,
    ALL_ROWS_APPLY_FILTER_TIMEOUT_SECONDS,
    ALL_ROWS_FILTER_VALUES_TIMEOUT_SECONDS,
    resolveAllRowsOperationTimeout,
} from '../results/allRowsOperationTimeouts';
import { findTrailingLimitClause, removeTrailingLimitClause, replaceTrailingLimitValue } from '../results/refreshSqlLimit';
import {
    getResultPanelTraceSnapshot,
    isResultPanelTraceEnabled,
    clearResultPanelTrace,
    traceResultPanelEvent,
    type ResultPanelTraceRecord,
} from './resultPanelTrace';
import { exportQueryToStreamFile, type QueryStreamExportFormat } from '../export/queryStreamExporter';
import { exportResultSetToFile } from '../export/resultExporter';
import {
    buildDatabaseAggregationSql,
    DatabaseAggregationRequest,
    DatabaseAggregationResult,
} from '../results/databaseAggregationSql';
import {
    buildDatabaseGroupingSql,
    type DatabaseGroupingRequest,
} from '../results/databaseGroupingSql';
import {
    buildDatabaseWhereSql,
    buildDatabaseDistinctValuesSql,
    buildDatabaseFilteredSql,
} from '../results/databaseFilterSql';
import {
    buildFullStatisticsSql,
    mapFullStatisticsRow,
    type FullStatisticName,
} from '../results/explore/fullStatisticsSql';
import {
    buildExplorePivotSql,
    buildDistinctValuesSql,
    EXPLORE_PIVOT_MAX_COLUMN_VALUES,
    type ExplorePivotConfig,
} from '../results/explore/pivotSqlBuilder';
import {
    buildComposerSql,
    type ExploreComposerConfig,
} from '../results/explore/composerSql';
import {
    wrapSourceSqlWithFilters,
    type ExploreFilterModel,
} from '../results/explore/exploreFilters';

interface HydratePayloadMetrics {
    activeSource: string | null;
    resultSetCount: number;
    totalRowCount: number;
    payloadBytes: number;
    executingSourceCount: number;
}

export interface ResultPanelRegressionResultSetSnapshot {
    index: number;
    resultSetId?: string;
    name?: string;
    isLog: boolean;
    rowCount: number;
    totalRowCount: number;
    isStreamingComplete: boolean;
}

export interface ResultPanelRegressionSnapshot {
    sourceUri: string;
    resultSets: ResultPanelRegressionResultSetSnapshot[];
    trace: readonly ResultPanelTraceRecord[];
}

interface LogSyncCursor {
    executionTimestamp: number;
    totalRows: number;
}

interface PendingResultPanelTestBridgeRequest {
    action: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RESULTS_GRID_FONT_FAMILY = "Menlo, Monaco, Consolas, 'Courier New', monospace";
const RESULT_PANEL_REGRESSION_TIMEOUT_MS = 15_000;
const RESULT_PANEL_REGRESSION_POLL_MS = 25;

function getTraceSourceUri(
    message: Record<string, unknown>,
    fallback: string | undefined,
): string | undefined {
    if (typeof message.sourceUri === 'string') {
        return message.sourceUri;
    }

    const data = message.data;
    if (typeof data === 'object' && data !== null) {
        const activeSourceJson = (data as Record<string, unknown>).activeSourceJson;
        if (typeof activeSourceJson === 'string') {
            try {
                const activeSource = JSON.parse(activeSourceJson) as unknown;
                return typeof activeSource === 'string' ? activeSource : undefined;
            } catch {
                // Fall back to the current host state for malformed test doubles.
            }
        }
    }

    return fallback;
}

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
    private _resultSyncVersion = 0;
    /** Recovery requests received while another source was active. */
    private _pendingResultSyncSources = new Set<string>();
    private _pendingTestBridgeRequests = new Map<string, PendingResultPanelTestBridgeRequest>();
    private _testBridgeRequestSequence = 0;
    private _encoder = new MessagePackEncoder();
    private _stateChangeDisposable?: vscode.Disposable;
    private _configurationChangeDisposable?: vscode.Disposable;
    private _viewDisposables: vscode.Disposable[] = [];
    private _formattingStore?: ResultFormattingSettingsStore;
    private _performanceStore?: ResultPanelPerformanceStore;
    private _acknowledgedLogRows = new Map<string, LogSyncCursor>();
    private _logSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _logSyncRetryAttempts = new Map<string, number>();
    /** Last row count posted to webview per streaming result set (pre-insert throttling). */
    private _streamingRowCountLastReported = new Map<string, number>();
    /** Result set for the statement currently being streamed per source. */
    private _streamingResultSets = new Map<string, ResultSet | null>();
    /** Sequence number of the next appendRows transport message per source. */
    private _streamingTransportSequence = new Map<string, number>();
    /** Active UX source-switch trace propagated into setActiveSource / hydrate. */
    private _pendingUxTraceId: string | undefined;
    private readonly _context?: vscode.ExtensionContext;
    private readonly _connectionManager?: ConnectionManager;

    private _setResultsFocusContext(focused: boolean): void {
        setContextIfChanged('netezza.resultsFocused', focused);
    }

    private _setResultsInputFocusContext(focused: boolean): void {
        setContextIfChanged('netezza.resultsInputFocused', focused);
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
            onMigrateResult: (sourceUri, resultSetIndex) => {
                void this._openMigrationForResult(sourceUri, resultSetIndex);
            },
            onLogRowsApplied: (sourceUri, executionTimestamp, totalRows) =>
                this._handleLogRowsApplied(sourceUri, executionTimestamp, totalRows),
            onRequestLogSync: (sourceUri, executionTimestamp, currentRows) =>
                this._handleLogSyncRequest(sourceUri, executionTimestamp, currentRows),
            onRequestResultSync: (sourceUri, reason) =>
                this._handleResultSyncRequest(sourceUri, reason),
            onSelectionStatsChanged: undefined,
            onRecordHydrationMetrics: metrics => {
                void this._performanceStore?.recordFirstPaint(metrics);
            },
            onRecordResultPanelTrace: event => {
                this._recordWebviewTrace(event);
            },
            onTestBridgeResult: message => this._handleTestBridgeResult(message),
            onTestExport: request => this._handleTestExport(request),
            onSaveEdits: request => this._handleSaveEdits(request, connectionManager),
            onGetWebviewUri: uri => this._view ? String(this._view.webview.asWebviewUri(uri)) : String(uri),
            onRefreshResult: (sourceUri, resultSetIndex, limitValue, removeLimit) =>
                this._handleRefreshResult(sourceUri, resultSetIndex, limitValue, removeLimit),
            onExportAllRows: request => this._handleAllRowsExport(request),
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
            onRequestDatabaseGrouping: (sourceUri, resultSetIndex, grouping, timeoutSeconds) =>
                this._handleDatabaseGrouping(sourceUri, resultSetIndex, grouping, timeoutSeconds),
            onPreviewDatabaseGrouping: (sourceUri, resultSetIndex, grouping) =>
                this._previewDatabaseGrouping(sourceUri, resultSetIndex, grouping),
            onRequestExploreFullStats: (sourceUri, resultSetIndex, columnIndex, filters, timeoutSeconds) =>
                this._handleExploreFullStats(sourceUri, resultSetIndex, columnIndex, filters, timeoutSeconds),
            onRequestExplorePivot: (sourceUri, resultSetIndex, pivot, timeoutSeconds) =>
                this._handleExplorePivot(sourceUri, resultSetIndex, pivot, timeoutSeconds),
            onPreviewExplorePivot: (sourceUri, resultSetIndex, pivot, pivotValues) =>
                this._previewExplorePivot(sourceUri, resultSetIndex, pivot, pivotValues),
            onRequestExploreComposer: (sourceUri, resultSetIndex, composer, timeoutSeconds) =>
                this._handleExploreComposer(sourceUri, resultSetIndex, composer, timeoutSeconds),
            onPreviewExploreComposer: (sourceUri, resultSetIndex, composer) =>
                this._previewExploreComposer(sourceUri, resultSetIndex, composer),
            onPreviewExploreFilteredSql: (sourceUri, resultSetIndex, filters) =>
                this._previewExploreFilteredSql(sourceUri, resultSetIndex, filters),
            onOpenExploreSqlInEditor: (sql, label) => this._openExploreSqlInEditor(sql, label),
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

    private _recordWebviewTrace(event: ResultPanelTraceEventPayload): void {
        traceResultPanelEvent({
            ...event,
            phase: `webview.${event.phase}`,
            sourceUri: event.sourceUri ?? this._stateManager.activeSourceUri,
        }, 'webview');
    }

    private _handleResultSyncRequest(sourceUri: string, reason: string): void {
        if (this._stateManager.activeSourceUri !== sourceUri) {
            this._pendingResultSyncSources.add(sourceUri);
            traceResultPanelEvent({
                phase: 'result_sync_deferred',
                sourceUri,
                reason: 'inactive-source',
            });
            return;
        }
        this._pendingResultSyncSources.delete(sourceUri);
        this._resultSyncVersion += 1;
        this._stateManager.markStale(sourceUri);
        traceResultPanelEvent({
            phase: 'result_sync_requested',
            sourceUri,
            reason,
        });
        this._updateWebview();
    }

    private async _openMigrationForResult(sourceUri: string, resultSetIndex: number): Promise<void> {
        if (!this._context || !this._connectionManager) {
            vscode.window.showErrorMessage('Migration Studio is not available in this result panel.');
            return;
        }
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const sql = (resultSet?.refreshSql || resultSet?.sql || '').trim();
        const connectionName = this._connectionManager.getConnectionForExecution(sourceUri);
        if (!sql || !connectionName) {
            vscode.window.showErrorMessage('This result does not have a reusable SQL query or active connection.');
            return;
        }
        const targetDetails = await this._connectionManager.getConnection(connectionName);
        await MigrationWizardView.createOrShow(this._context, this._connectionManager, {
            source: { mode: 'sql', connectionName, sql },
            targetConnectionName: connectionName,
            targetDatabase: targetDetails?.database,
            targetSchema: targetDetails?.schema,
        });
    }

    public setSelectionStatsCallback(callback: (stats: SelectionStats | { state: 'calculating' } | null) => void) {
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

    /**
     * Drive the result-panel through its real webview protocol during an
     * Extension Host test. The method is deliberately unavailable outside a
     * test session with trace enabled.
     */
    public runResultPanelTestBridge<T = unknown>(action: string, args?: unknown): Promise<T> {
        if (process.env.NODE_ENV !== 'test' || !isResultPanelTraceEnabled()) {
            return Promise.reject(new Error('Result-panel test bridge is available only in traced test sessions.'));
        }
        if (!this._view || !this._isViewReady || this._view.visible !== true) {
            return Promise.reject(new Error('Result-panel webview is not ready or visible.'));
        }

        const requestId = `eh-${++this._testBridgeRequestSequence}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this._pendingTestBridgeRequests.get(requestId);
                if (!pending) {
                    return;
                }
                this._pendingTestBridgeRequests.delete(requestId);
                pending.reject(new Error(`Result-panel test bridge request ${requestId} timed out during ${action}.`));
            }, RESULT_PANEL_REGRESSION_TIMEOUT_MS);

            this._pendingTestBridgeRequests.set(requestId, {
                action,
                resolve: result => resolve(result as T),
                reject,
                timer,
            });
            try {
                const posted = this._postMessageToWebview({ command: 'testBridge', requestId, action, args });
                if (!posted) {
                    clearTimeout(timer);
                    this._pendingTestBridgeRequests.delete(requestId);
                    reject(new Error(`Result-panel test bridge request ${requestId} was not delivered.`));
                } else {
                    void posted.then(delivered => {
                        if (delivered) {
                            return;
                        }
                        const pending = this._pendingTestBridgeRequests.get(requestId);
                        if (!pending) {
                            return;
                        }
                        clearTimeout(pending.timer);
                        this._pendingTestBridgeRequests.delete(requestId);
                        pending.reject(new Error(`Result-panel test bridge request ${requestId} was not delivered.`));
                    }, error => {
                        const pending = this._pendingTestBridgeRequests.get(requestId);
                        if (!pending) {
                            return;
                        }
                        clearTimeout(pending.timer);
                        this._pendingTestBridgeRequests.delete(requestId);
                        pending.reject(error instanceof Error ? error : new Error(String(error)));
                    });
                }
            } catch (error: unknown) {
                clearTimeout(timer);
                this._pendingTestBridgeRequests.delete(requestId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
            traceResultPanelEvent({
                phase: 'test_bridge_requested',
                command: 'testBridge',
                reason: action,
                sourceUri: this._stateManager.activeSourceUri,
            });
        });
    }

    public getResultPanelTestBridgePendingRequestCount(): number {
        return this._pendingTestBridgeRequests.size;
    }

    /** Bounded counters used by the test-only Extension Host leak gate. */
    public getResultPanelRuntimeDiagnostics(): {
        activeCommandCount: number;
        executingSourceCount: number;
        streamingResultCount: number;
        streamingTransportCount: number;
        pendingResultSyncCount: number;
    } {
        return {
            activeCommandCount: streamingManager.getActiveUris().length,
            executingSourceCount: this._stateManager.executingSources.size,
            streamingResultCount: this._streamingResultSets.size,
            streamingTransportCount: this._streamingTransportSequence.size,
            pendingResultSyncCount: this._pendingResultSyncSources.size,
        };
    }

    /** Prepare the real webview before an Extension Host scenario starts. */
    public async ensureResultPanelTestBridgeReady(): Promise<void> {
        if (process.env.NODE_ENV !== 'test' || !isResultPanelTraceEnabled()) {
            throw new Error('Result-panel test bridge is available only in traced test sessions.');
        }
        await this._ensureResultPanelRegressionWebviewReady();
    }

    private _handleTestBridgeResult(message: ResultPanelTestBridgeResult): void {
        const pending = this._pendingTestBridgeRequests.get(message.requestId);
        if (!pending) {
            traceResultPanelEvent({
                phase: 'test_bridge_response_ignored',
                reason: 'unknown-request',
            });
            return;
        }

        clearTimeout(pending.timer);
        this._pendingTestBridgeRequests.delete(message.requestId);
        traceResultPanelEvent({
            phase: message.ok ? 'test_bridge_completed' : 'test_bridge_failed',
            reason: pending.action,
            error: message.ok ? undefined : message.error,
        });
        if (message.ok) {
            pending.resolve(message.result);
        } else {
            pending.reject(new Error(message.error || `Result-panel test bridge action failed: ${pending.action}`));
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._disposeViewDisposables();
        this._isViewReady = false;
        this._view = webviewView;
        traceResultPanelEvent({
            phase: 'view_resolve',
            visible: webviewView.visible === true,
            ready: false,
        });

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
      traceResultPanelEvent({
        phase: 'visibility_changed',
        visible: webviewView.visible === true,
        ready: this._isViewReady,
        sourceUri: this._stateManager.activeSourceUri,
      });
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
            const inboundMessage = parseResultPanelWebviewMessage(message);
            if (!inboundMessage) {
                traceResultPanelEvent({
                    phase: 'webview_message_rejected',
                    sourceUri: this._stateManager.activeSourceUri,
                    reason: 'invalid_result_panel_message',
                });
                return;
            }
            const messageRecord = message as Record<string, unknown>;
            traceResultPanelEvent({
                phase: 'webview_message',
                command: typeof messageRecord.command === 'string' ? messageRecord.command : undefined,
                sourceUri: typeof messageRecord.sourceUri === 'string'
                    ? messageRecord.sourceUri
                    : this._stateManager.activeSourceUri,
                resultSetIndex: typeof messageRecord.resultSetIndex === 'number'
                    ? messageRecord.resultSetIndex
                    : undefined,
                rowCount: Array.isArray(messageRecord.rows) ? messageRecord.rows.length : undefined,
                totalRows: typeof messageRecord.totalRows === 'number' ? messageRecord.totalRows : undefined,
            });

            if (inboundMessage.command === 'ready') {
                this._isViewReady = true;
                traceResultPanelEvent({
                    phase: 'webview_ready',
                    visible: webviewView.visible === true,
                    ready: true,
                    sourceUri: this._stateManager.activeSourceUri,
                });
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
            traceResultPanelEvent({
                phase: 'view_dispose',
                sourceUri: this._stateManager.activeSourceUri,
                visible: webviewView.visible === true,
                ready: this._isViewReady,
            });
            if (this._view === webviewView) {
                this._clearAllLogSyncRetryTimers();
                this._pendingResultSyncSources.clear();
                this._clearPendingTestBridgeRequests('Result-panel webview disposed.');
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
        this._stateManager.dispose();
        this._clearAllLogSyncRetryTimers();
        this._pendingResultSyncSources.clear();
        this._clearPendingTestBridgeRequests('Result-panel provider disposed.');
        this._view = undefined;
        this._htmlGenerator = undefined;
        this._clearResultsFocusContexts();
    }

    private _clearPendingTestBridgeRequests(reason: string): void {
        for (const pending of this._pendingTestBridgeRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this._pendingTestBridgeRequests.clear();
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

    public setActiveSource(sourceUri: string, uxTraceId?: string) {
        if (uxTraceId) {
            this._pendingUxTraceId = uxTraceId;
        }
        const deferredResultSync = this._pendingResultSyncSources.has(sourceUri);
        const activeSourceChanged = this._stateManager.setActiveSource(sourceUri);
        if (deferredResultSync) {
            this._pendingResultSyncSources.delete(sourceUri);
            this._resultSyncVersion += 1;
            this._stateManager.markStale(sourceUri);
            traceResultPanelEvent({
                phase: 'result_sync_resumed',
                sourceUri,
                reason: 'source-became-active',
            });
        }
        if (!activeSourceChanged) {
            if (deferredResultSync && this._stateManager.activeSourceUri === sourceUri) {
                this._updateWebview();
            }
            if (uxTraceId && getUxPerfSession().isActive()) {
                getUxPerfSession().emit({
                    op: 'result_panel.source_switch',
                    phase: 'noop_same_source',
                    traceId: uxTraceId,
                    durationMs: 0,
                    meta: { sourceUri },
                });
            }
            return;
        }
        {
            const ux = getUxPerfSession();
            if (ux.isActive() && this._pendingUxTraceId) {
                ux.emit({
                    op: 'result_panel.source_switch',
                    phase: 'host_set_active',
                    traceId: this._pendingUxTraceId,
                    meta: { sourceUri },
                });
            }
            // Send lightweight setActiveSource message first for immediate client-side switch,
            // then follow up with a full hydrate containing data.
            this._postMessageToWebview({
                command: 'setActiveSource',
                sourceUri,
                activeResultSetIndex: this._stateManager.getActiveResultSetIndex(sourceUri) ?? 0,
                executingSourcesJson: JSON.stringify(Array.from(this._stateManager.executingSources)),
                sourcesJson: JSON.stringify(Array.from(this._stateManager.resultsMap.keys())),
                pinnedSourcesJson: JSON.stringify(Array.from(this._stateManager.pinnedSources)),
                streamingCompletedSourcesJson: JSON.stringify(Array.from(this._stateManager.streamingCompletedSources)),
                diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
                formatSettings: this._formattingStore?.getPayloadForSource(sourceUri),
                uxTraceId: this._pendingUxTraceId,
            });
            if (ux.isActive() && this._pendingUxTraceId) {
                ux.emit({
                    op: 'result_panel.source_switch',
                    phase: 'lightweight_posted',
                    traceId: this._pendingUxTraceId,
                    meta: { sourceUri },
                });
            }
            this._updateWebview();
        }
    }

    public notifyUxPerfSession(active: boolean): void {
        this._postMessageToWebview({ command: 'uxPerfSession', active });
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
        this._pendingResultSyncSources.delete(sourceUri);
        this._streamingResultSets.delete(sourceUri);
        this._streamingTransportSequence.delete(sourceUri);
        this._stateManager.closeSource(sourceUri);
        this._updateWebview();
    }

    public startExecution(sourceUri: string) {
        const hadResultSets = (this._stateManager.resultsMap.get(sourceUri)?.length ?? 0) > 0;
        traceResultPanelEvent({
            phase: 'start_execution',
            sourceUri,
            resultSetCount: this._stateManager.resultsMap.get(sourceUri)?.length ?? 0,
            reason: hadResultSets ? 'existing-results' : 'new-source',
        });
        const { clearedUnpinnedResults } = this._stateManager.startExecution(sourceUri);
        this._streamingResultSets.delete(sourceUri);
        this._streamingTransportSequence.delete(sourceUri);
        // Full hydrate only when unpinned tabs (e.g. Error) were removed — avoids wiping
        // live/pinned state on every re-run.
        // A newly-created source has no Logs shell in the webview yet. Force one
        // authoritative hydrate in that case; otherwise a lightweight streaming
        // update can arrive with resultSetIndex 1 while the client still has an
        // empty result-set array, dropping the Logs tab permanently for this run.
        if (clearedUnpinnedResults || !hadResultSets) {
            this._stateManager.markStale(sourceUri);
        }
        traceResultPanelEvent({
            phase: 'start_execution_applied',
            sourceUri,
            resultSetCount: this._stateManager.resultsMap.get(sourceUri)?.length ?? 0,
            reason: clearedUnpinnedResults ? 'cleared-unpinned' : hadResultSets ? 'retained-results' : 'created-logs-shell',
        });
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
            this._postLogUpdate(update);
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
        const hadCompletedStreaming = this._stateManager.isStreamingCompleted(sourceUri);
        this._stateManager.clearStreamingCompleted(sourceUri);
        this._streamingResultSets.delete(sourceUri);
        this._streamingTransportSequence.delete(sourceUri);
        // The next statement may be DML/DDL and therefore produce no new tabular
        // shell. Keep the webview's marker scoped to the previous statement.
        if (hadCompletedStreaming && this._stateManager.activeSourceUri === sourceUri) {
            this._postLightweightActiveSourceUpdate(sourceUri);
        }
        const { id, incrementalUpdate } = this._stateManager.logExecutionStart(sourceUri, sql, connectionName);
        if (incrementalUpdate && this._stateManager.activeSourceUri === sourceUri) {
            this._postLogUpdate(incrementalUpdate);
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
            this._postLogUpdate(update);
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

    /** Return the bounded diagnostic trace collected for a controlled regression run. */
    public getResultPanelTraceSnapshot(): readonly ResultPanelTraceRecord[] {
        return getResultPanelTraceSnapshot();
    }

    private async _waitForResultPanelRegressionCondition(
        description: string,
        predicate: () => boolean,
    ): Promise<void> {
        const startedAt = Date.now();
        while (!predicate()) {
            if (Date.now() - startedAt >= RESULT_PANEL_REGRESSION_TIMEOUT_MS) {
                throw new Error(`Result-panel regression timed out waiting for ${description}.`);
            }
            await new Promise<void>(resolve => setTimeout(resolve, RESULT_PANEL_REGRESSION_POLL_MS));
        }
    }

    private async _ensureResultPanelRegressionWebviewReady(): Promise<void> {
        await vscode.commands.executeCommand(`${ResultPanelView.viewType}.focus`);
        await this._waitForResultPanelRegressionCondition(
            'a visible, ready webview',
            () => Boolean(this._view && this._isViewReady && this._view.visible),
        );

        // Force one round trip before the scenario. A `ready` flag alone proves only
        // that the host received a message; the webview trace proves it also consumed
        // a host hydrate and can report back over the same protocol.
        this._forceHydrate();
        await this._waitForResultPanelRegressionCondition(
            'the webview hydration handshake',
            () => getResultPanelTraceSnapshot().some(event =>
                event.origin === 'webview'
                && event.phase === 'webview.hydrate_rendered',
            ),
        );
    }

    private _hasResultPanelRegressionWebviewDelivery(sourceUri: string): boolean {
        const trace = getResultPanelTraceSnapshot();
        const hydrateIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.hydrate_applied'
            && event.sourceUri === sourceUri,
        );
        const appendIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.append_applied'
            && event.sourceUri === sourceUri
            && event.resultSetIndex === 1
            && event.totalRows === 2,
        );
        const completionIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.streaming_complete_applied'
            && event.sourceUri === sourceUri
            && event.resultSetIndex === 1
            && event.totalRows === 2,
        );
        return hydrateIndex >= 0
            && appendIndex > hydrateIndex
            && completionIndex > appendIndex;
    }

    private _createResultPanelRegressionSnapshot(sourceUri: string): ResultPanelRegressionSnapshot {
        const resultSets = this._stateManager.resultsMap.get(sourceUri) ?? [];
        const streamingComplete = this._stateManager.isStreamingCompleted(sourceUri);
        return {
            sourceUri,
            resultSets: resultSets.map((resultSet, index) => ({
                index,
                resultSetId: resultSet.resultSetId,
                name: resultSet.name,
                isLog: resultSet.isLog === true,
                rowCount: resultSet.storageMode === 'sqlite'
                    ? resultSet.totalRowCount ?? 0
                    : resultSet.data.length,
                totalRowCount: resultSet.totalRowCount ?? resultSet.data.length,
                isStreamingComplete: !resultSet.isLog && streamingComplete,
            })),
            trace: getResultPanelTraceSnapshot(),
        };
    }

    private _hasResultPanelRegressionFinalWebviewState(
        sourceUri: string,
        expectedResultSetCount: number,
        expectedDataRows: number,
    ): boolean {
        const trace = getResultPanelTraceSnapshot();
        const hydrateIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.hydrate_applied'
            && event.sourceUri === sourceUri
            && (event.resultSetCount ?? 0) >= expectedResultSetCount,
        );
        const hydrateRenderedIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.hydrate_rendered'
            && event.sourceUri === sourceUri
            && (event.resultSetCount ?? 0) >= expectedResultSetCount,
        );
        const hydratedDataIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.hydrate_result_set_applied'
            && event.sourceUri === sourceUri
            && event.resultSetIndex === 1
            && event.isLog !== true
            && (event.totalRows ?? event.rowCount ?? 0) >= expectedDataRows,
        );
        const appendIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.append_applied'
            && event.sourceUri === sourceUri
            && event.resultSetIndex === 1
            && (event.totalRows ?? 0) >= expectedDataRows,
        );
        const completionIndex = trace.findIndex(event =>
            event.origin === 'webview'
            && event.phase === 'webview.streaming_complete_applied'
            && event.sourceUri === sourceUri
            && event.resultSetIndex === 1
            && (event.totalRows ?? 0) >= expectedDataRows,
        );

        // A host snapshot alone is insufficient here: export can work while the
        // grid is empty. For a tabular execution require the webview to apply the
        // data append and its completion marker. Error-only scenarios have no
        // streamed rows, so their authoritative hydrate remains the terminal
        // assertion.
        if (expectedDataRows > 0) {
            const streamedRowsApplied = appendIndex >= 0 && completionIndex > appendIndex;
            const hydratedRowsApplied = hydratedDataIndex >= 0
                && hydrateRenderedIndex > hydratedDataIndex;
            return streamedRowsApplied || hydratedRowsApplied;
        }
        return hydrateIndex >= 0 && hydrateRenderedIndex > hydrateIndex;
    }

    /** Start tracing without resolving the view, preserving the cold-view execution race. */
    public beginColdResultPanelRegressionScenario(): void {
        if (!isResultPanelTraceEnabled()) {
            throw new Error('Result-panel regression requires JUSTYBASE_RESULT_PANEL_TRACE=1.');
        }
        clearResultPanelTrace();
    }

    /** Wait until a real editor-command execution has reached the webview. */
    public async captureColdResultPanelRegressionScenario(
        sourceUri: string,
        expectedDataRows: number,
        allowErrorResult = false,
    ): Promise<ResultPanelRegressionSnapshot> {
        await this._waitForResultPanelRegressionCondition(
            'the editor-command result in the host state',
            () => {
                const resultSets = this._stateManager.resultsMap.get(sourceUri) ?? [];
                const dataResult = resultSets.find(resultSet =>
                    !resultSet.isLog && (allowErrorResult || !resultSet.isError),
                );
                return resultSets.some(resultSet => resultSet.isLog)
                    && Boolean(dataResult)
                    && (allowErrorResult
                        || (dataResult?.totalRowCount ?? dataResult?.data.length ?? 0) >= expectedDataRows);
            },
        );

        const expectedResultSetCount = this._stateManager.resultsMap.get(sourceUri)?.length ?? 0;
        await this._waitForResultPanelRegressionCondition(
            'the cold editor-command result in the webview',
            () => this._hasResultPanelRegressionFinalWebviewState(
                sourceUri,
                expectedResultSetCount,
                expectedDataRows,
            ),
        );
        return this._createResultPanelRegressionSnapshot(sourceUri);
    }

    /**
     * Execute a deterministic, database-free result-panel scenario. It follows the same
     * host transitions as a real untitled query: Logs shell, streamed rows, completion,
     * and finalization. The command is registered only in test Extension Hosts.
     */
    public async runResultPanelRegressionScenario(
        sourceUri = 'untitled:Untitled-1',
    ): Promise<ResultPanelRegressionSnapshot> {
        if (!sourceUri.startsWith('file:') && !sourceUri.startsWith('untitled:')) {
            throw new Error('Result-panel regression source must use file: or untitled: URI.');
        }
        if (!isResultPanelTraceEnabled()) {
            throw new Error('Result-panel regression requires JUSTYBASE_RESULT_PANEL_TRACE=1.');
        }

        clearResultPanelTrace();
        await this._ensureResultPanelRegressionWebviewReady();
        clearResultPanelTrace();
        traceResultPanelEvent({
            phase: 'regression_start',
            sourceUri,
            reason: 'deterministic-host-scenario',
        });

        this.setActiveSource(sourceUri);
        this.startExecution(sourceUri);
        const executionId = this.logExecutionStart(sourceUri, 'SELECT 1', 'regression');
        this.appendStreamingChunk(
            sourceUri,
            0,
            {
                columns: [{ name: 'id', type: 'integer' }],
                rows: [[1]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 1,
                limitReached: false,
            },
            'SELECT 1',
        );
        this.appendStreamingChunk(
            sourceUri,
            0,
            {
                columns: [{ name: 'id', type: 'integer' }],
                rows: [[2]],
                isFirstChunk: false,
                isLastChunk: true,
                totalRowsSoFar: 2,
                limitReached: false,
            },
            'SELECT 1',
        );
        this.logExecutionEnd(executionId, 2, 'success');
        this.finalizeExecution(sourceUri);

        await this._waitForResultPanelRegressionCondition(
            'source-specific hydrate and streamed rows in the webview',
            () => this._hasResultPanelRegressionWebviewDelivery(sourceUri),
        );

        const snapshot = this._createResultPanelRegressionSnapshot(sourceUri);
        traceResultPanelEvent({
            phase: 'regression_complete',
            sourceUri,
            resultSetCount: snapshot.resultSets.length,
            rowCount: snapshot.resultSets.reduce((sum, resultSet) => sum + resultSet.rowCount, 0),
        });
        return {
            ...snapshot,
            trace: getResultPanelTraceSnapshot(),
        };
    }

    public isCancelled(sourceUri: string): boolean {
        return this._stateManager.isCancelled(sourceUri);
    }

    public cancelExecution(sourceUri: string, currentRowCounts?: number[]) {
        this._stateManager.cancelExecution(sourceUri, currentRowCounts);
        this._streamingTransportSequence.delete(sourceUri);
        this._updateWebview();

        // Notify webview to discard pending messages
        this._postMessageToWebview({
            command: 'cancelExecution',
            sourceUri: sourceUri
        });
    }

    public finalizeExecution(sourceUri: string) {
        this._streamingResultSets.delete(sourceUri);
        this._streamingTransportSequence.delete(sourceUri);
        this._stateManager.finalizeExecution(sourceUri);
        traceResultPanelEvent({
            phase: 'finalize_execution',
            sourceUri,
            resultSetCount: this._stateManager.resultsMap.get(sourceUri)?.length ?? 0,
            totalRows: this._stateManager.resultsMap.get(sourceUri)?.reduce(
                (sum, resultSet) => sum + this._getWebviewRowCount(resultSet),
                0,
            ),
        });
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

    private async _handleAllRowsExport(request: AllRowsExportRequest): Promise<void> {
        if (!this._context || !this._connectionManager) {
            vscode.window.showErrorMessage('ALL rows export is not available in this view.');
            return;
        }

        const resultSet = this._stateManager.resultsMap.get(request.sourceUri)?.[request.resultSetIndex];
        const refreshSql = resultSet?.refreshSql?.trim();
        if (!resultSet || !refreshSql || !findTrailingLimitClause(refreshSql)) {
            vscode.window.showErrorMessage('This result set does not have SQL with a trailing LIMIT to export.');
            return;
        }

        const formatMap: Record<string, { format: QueryStreamExportFormat; extension: string; label: string }> = {
            csv: { format: 'csv', extension: 'csv', label: 'CSV' },
            'csv.gz': { format: 'csv.gz', extension: 'csv.gz', label: 'CSV.GZ' },
            'csv.zst': { format: 'csv.zst', extension: 'csv.zst', label: 'CSV.ZST' },
            json: { format: 'json', extension: 'json', label: 'JSON' },
            xml: { format: 'xml', extension: 'xml', label: 'XML' },
            sql: { format: 'sql', extension: 'sql', label: 'SQL' },
            markdown: { format: 'markdown', extension: 'md', label: 'Markdown' },
            excel: { format: 'xlsb', extension: 'xlsb', label: 'Excel (XLSB)' },
            xlsx: { format: 'xlsx', extension: 'xlsx', label: 'Excel (XLSX)' },
        };
        const exportFormat = formatMap[request.format];
        if (!exportFormat) {
            vscode.window.showWarningMessage(`Streaming ALL rows export is not yet available for ${request.format}.`);
            return;
        }

        let destination = request.destination;
        if (destination === 'clipboard') {
            vscode.window.showWarningMessage('ALL rows cannot be copied to the clipboard safely. The export will be saved as a temporary file instead.');
            destination = 'temp';
        }

        let outputPath: string;
        if (destination === 'file') {
            const uri = await vscode.window.showSaveDialog({
                filters: { [`${exportFormat.label} Files`]: [exportFormat.extension] },
                saveLabel: 'Export ALL rows',
            });
            if (!uri) return;
            outputPath = uri.fsPath;
        } else {
            outputPath = path.join(os.tmpdir(), `netezza_all_rows_${Date.now()}.${exportFormat.extension}`);
        }

        const baseSql = removeTrailingLimitClause(refreshSql).trim().replace(/;\s*$/, '');
        const filterSql = buildDatabaseWhereSql(resultSet.databaseFilterSpec, resultSet.columns);
        const query = filterSql
            ? `SELECT *\nFROM (\n${baseSql}\n) t\nWHERE ${filterSql}`
            : baseSql;
        const columnIndices = request.columnIds
            ?.map(columnId => Number.parseInt(columnId, 10))
            .filter(columnIndex => Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < resultSet.columns.length);
        const connectionName = this._resolveConnectionForSource(request.sourceUri);

        try {
            await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Exporting ALL rows to ${exportFormat.label}...`,
                cancellable: true,
            },
            async (progress, cancellationToken) => {
                await ensurePersistentConnectionReadyForQuery(
                    this._connectionManager!,
                    request.sourceUri,
                    connectionName,
                );
                const { connection } = await getConnectionForDocument(
                    this._connectionManager!,
                    connectionName,
                    true,
                    request.sourceUri,
                );
                await exportQueryToStreamFile({
                    connection,
                    query,
                    filePath: outputPath,
                    format: exportFormat.format,
                    columnIndices,
                    sql: query,
                    timeoutSeconds: vscode.workspace.getConfiguration('justybase.query').get<number>('executionTimeout', 1800),
                    cancellationToken,
                    progress: message => progress.report({ message }),
                });
            },
            );

            if (destination === 'open') {
                await vscode.env.openExternal(vscode.Uri.file(outputPath));
            } else if (destination === 'temp') {
                await vscode.env.clipboard.writeText(outputPath);
            }
            vscode.window.showInformationMessage(`ALL rows exported to ${outputPath}`);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`ALL rows export failed: ${message}`);
        }
    }

    /** Write a result-panel export directly to a runner-owned path. */
    private async _handleTestExport(request: TestExportRequest): Promise<void> {
        if (process.env.NODE_ENV !== 'test' || !isResultPanelTraceEnabled()) {
            throw new Error('Direct result-panel exports are available only in traced test sessions.');
        }
        const workDir = process.env.JUSTYBASE_EXTENSION_HOST_WORK_DIR;
        if (!workDir || !path.isAbsolute(request.destination)) {
            throw new Error('The test export destination must be an absolute path in the test work directory.');
        }
        const root = path.resolve(workDir);
        const destination = path.resolve(request.destination);
        const relative = path.relative(root, destination);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('The test export destination is outside the test work directory.');
        }

        const resultSet = this._stateManager.resultsMap.get(request.sourceUri)?.[request.resultSetIndex];
        if (!resultSet) {
            throw new Error('The requested result set is not available for export.');
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        traceResultPanelEvent({
            phase: 'test_export_start',
            sourceUri: request.sourceUri,
            resultSetIndex: request.resultSetIndex,
            reason: request.format,
        });
        await exportResultSetToFile(resultSet, destination, {
            format: request.format,
            rowIndices: request.rowIndices,
            columnIds: request.columnIds,
        });
        traceResultPanelEvent({
            phase: 'test_export_complete',
            sourceUri: request.sourceUri,
            resultSetIndex: request.resultSetIndex,
            reason: request.format,
        });
    }

    private async _handleRefreshResult(
        sourceUri: string,
        resultSetIndex: number,
        limitValue?: string,
        removeLimit: boolean = false,
    ): Promise<boolean> {
        if (!this._context || !this._connectionManager) {
            vscode.window.showErrorMessage('Result refresh is not available in this view.');
            return false;
        }

        if (this._stateManager.executingSources.has(sourceUri)) {
            vscode.window.showWarningMessage('A query is already running for this SQL Results source.');
            return false;
        }

        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const refreshSql = resultSet?.refreshSql?.trim();
        if (!resultSet || !refreshSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            vscode.window.showWarningMessage('This result set does not have refresh SQL.');
            return false;
        }

        const preservedFilterSpec = resultSet.databaseFilterSpec;
        const baseRefreshSql = this._resolveRefreshSqlLimit(refreshSql, limitValue, removeLimit);
        if (!baseRefreshSql) {
            return false;
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
            return false;
        }

        if (!this._stateManager.startResultRefresh(sourceUri, resultSetIndex)) {
            vscode.window.showWarningMessage('This result set cannot be refreshed.');
            return false;
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
                // An explicit ALL-rows export bypasses the normal preview row cap;
                // the SQL LIMIT has already been removed above.
                ...(removeLimit ? { maxRows: Number.MAX_SAFE_INTEGER } : {}),
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
            return true;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this._stateManager.setResultSetRefreshFailure(sourceUri, resultSetIndex, {
                message,
                sql: sqlToExecute,
            });
            this.logExecutionEnd(executionId, 0, 'error', message);
            vscode.window.showErrorMessage(`Refresh failed: ${message}`);
            return false;
        } finally {
            this._streamingResultSets.delete(sourceUri);
            this._streamingTransportSequence.delete(sourceUri);
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

    private _resolveRefreshSqlLimit(
        refreshSql: string,
        limitValue?: string,
        removeLimit: boolean = false,
    ): string | undefined {
        if (removeLimit) {
            return removeTrailingLimitClause(refreshSql);
        }

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

    private async _previewDatabaseGrouping(
        sourceUri: string,
        resultSetIndex: number,
        grouping: DatabaseGroupingRequest,
    ): Promise<string> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Database grouping is not available in this view.');
        }

        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSet || !resultSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            throw new Error('This result set does not have refresh SQL for grouping.');
        }

        const connectionName = this._resolveConnectionForSource(sourceUri);

        const built = buildDatabaseGroupingSql(
            resultSql,
            resultSet.columns,
            grouping,
            { databaseKind: this._connectionManager.getConnectionDatabaseKind(connectionName) },
        );

        return built.sql;
    }

    private async _handleDatabaseGrouping(
        sourceUri: string,
        resultSetIndex: number,
        grouping: DatabaseGroupingRequest,
        timeoutSeconds?: number,
    ): Promise<{
        columns: Array<{ name: string; type?: string; kind?: 'group' | 'count' | 'percentage' | 'aggregate'; sourceColumnIndex?: number; fn?: string }>;
        rows: unknown[][];
        totalRows: number;
        truncated?: boolean;
        sql: string;
    }> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Database grouping is not available in this view.');
        }

        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSet || !resultSql || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            throw new Error('This result set does not have refresh SQL for grouping.');
        }

        const connectionName = this._resolveConnectionForSource(sourceUri);

        const built = buildDatabaseGroupingSql(
            resultSql,
            resultSet.columns,
            grouping,
            { databaseKind: this._connectionManager.getConnectionDatabaseKind(connectionName) },
        );

        const queryResult = await runQueryRaw({
            context: this._context,
            query: built.sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName,
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 10001,
            isUserQuery: false,
            timeoutSeconds: resolveAllRowsOperationTimeout(
                300, // grouping queries may scan and aggregate large result sets
                timeoutSeconds,
                false, // isRetry
            ),
        });

        const MAX_GROUPING_ROWS = 10000;
        const truncated = queryResult.data.length > MAX_GROUPING_ROWS;
        const safeRows = truncated ? queryResult.data.slice(0, MAX_GROUPING_ROWS) : queryResult.data;

        // Build columns with metadata so webview can distinguish group/count/percentage columns
        const resultColumns = built.columnMetadata.map((meta, idx) => {
            const col = queryResult.columns[idx];
            return {
                name: col?.name ?? `Col${idx}`,
                type: col?.type ?? 'string',
                kind: meta.kind,
                sourceColumnIndex: meta.sourceColumnIndex,
                fn: meta.fn,
            };
        });

        return {
            columns: resultColumns,
            rows: safeRows,
            totalRows: safeRows.length,
            truncated,
            sql: built.sql,
        };
    }

    /**
     * Group the SQL that produced the currently displayed result. This keeps a
     * server-side filter wrapper intact instead of re-applying its filter spec.
     */
    private _resolveGroupingResultSql(resultSet: ResultSet | undefined): string {
        return (resultSet?.sql || resultSet?.refreshSql || '').trim();
    }

    private _resolveExploreResultSet(sourceUri: string, resultSetIndex: number): ResultSet {
        const resultSet = this._stateManager.resultsMap.get(sourceUri)?.[resultSetIndex];
        if (!resultSet || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            throw new Error('This result set does not have SQL that can be analyzed.');
        }
        return resultSet;
    }

    private _resolveExploreConnectionKind(sourceUri: string): string | undefined {
        if (!this._connectionManager) {
            return undefined;
        }
        const connectionName = this._resolveConnectionForSource(sourceUri);
        return this._connectionManager.getConnectionDatabaseKind(connectionName);
    }

    private _exploreTimeoutSeconds(timeoutSeconds: number | undefined, fallback: number): number {
        return resolveAllRowsOperationTimeout(
            fallback,
            timeoutSeconds,
            false,
        );
    }

    private async _handleExploreFullStats(
        sourceUri: string,
        resultSetIndex: number,
        columnIndex: number,
        filters?: import('../results/explore/exploreFilters').ExploreFilterModel,
        timeoutSeconds?: number,
    ): Promise<{
        values: Partial<Record<FullStatisticName, number | null>>;
        percentilesUnavailable: boolean;
        stddevUnavailable: boolean;
        sql: string;
    }> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Full statistics are not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL for full statistics.');
        }

        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const built = buildFullStatisticsSql(
            resultSql,
            resultSet.columns,
            { columnIndex },
            filters,
            databaseKind,
        );

        const queryResult = await runQueryRaw({
            context: this._context,
            query: built.sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName: this._resolveConnectionForSource(sourceUri),
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 10,
            isUserQuery: false,
            timeoutSeconds: this._exploreTimeoutSeconds(timeoutSeconds, 120),
        });

        return {
            values: mapFullStatisticsRow(queryResult.data[0], built.aliases),
            percentilesUnavailable: built.percentilesUnavailable,
            stddevUnavailable: built.stddevUnavailable,
            sql: built.sql,
        };
    }

    private async _handleExplorePivot(
        sourceUri: string,
        resultSetIndex: number,
        pivot: ExplorePivotConfig,
        timeoutSeconds?: number,
    ): Promise<{
        columns: Array<{ name: string; type?: string; kind: 'row' | 'value' }>;
        rows: unknown[][];
        totalRows: number;
        pivotValues: string[];
        truncated?: boolean;
        sql: string;
    }> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Pivot is not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL for pivoting.');
        }

        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const resolvedPivotValues = await this._resolveExplorePivotValues(
            sourceUri,
            resultSql,
            resultSet.columns,
            pivot,
            databaseKind,
            timeoutSeconds,
        );
        const built = buildExplorePivotSql(resultSql, resultSet.columns, pivot, resolvedPivotValues, databaseKind);

        const queryResult = await runQueryRaw({
            context: this._context,
            query: built.sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName: this._resolveConnectionForSource(sourceUri),
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 5001,
            isUserQuery: false,
            timeoutSeconds: this._exploreTimeoutSeconds(timeoutSeconds, 300),
        });

        const MAX_PIVOT_ROWS = 5000;
        const truncated = queryResult.data.length > MAX_PIVOT_ROWS;
        const safeRows = truncated ? queryResult.data.slice(0, MAX_PIVOT_ROWS) : queryResult.data;

        const columns = [
            ...pivot.rowColumnIndexes.map((_, index) => ({
                name: queryResult.columns[index]?.name ?? `Row${index + 1}`,
                type: queryResult.columns[index]?.type ?? 'string',
                kind: 'row' as const,
            })),
            ...built.pivotColumnNames.map(value => ({
                name: value.length > 80 ? `${value.slice(0, 77)}…` : value,
                type: 'string' as const,
                kind: 'value' as const,
            })),
        ];

        return {
            columns,
            rows: safeRows,
            totalRows: safeRows.length,
            pivotValues: built.pivotColumnNames,
            truncated,
            sql: built.sql,
        };
    }

    private async _resolveExplorePivotValues(
        sourceUri: string,
        resultSql: string,
        columns: ResultSet['columns'],
        pivot: ExplorePivotConfig,
        databaseKind: string | undefined,
        timeoutSeconds?: number,
    ): Promise<string[]> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Pivot is not available in this view.');
        }
        const distinctSql = buildDistinctValuesSql(
            resultSql,
            columns,
            { columnIndex: pivot.columnColumnIndex },
            pivot.filters,
            databaseKind,
        );
        const queryResult = await runQueryRaw({
            context: this._context,
            query: distinctSql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName: this._resolveConnectionForSource(sourceUri),
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: EXPLORE_PIVOT_MAX_COLUMN_VALUES,
            isUserQuery: false,
            timeoutSeconds: this._exploreTimeoutSeconds(timeoutSeconds, 300),
        });
        return Array.from(new Set(
            queryResult.data
                .map(row => row[0])
                .filter(value => value !== null && value !== undefined)
                .map(value => String(value)),
        )).slice(0, EXPLORE_PIVOT_MAX_COLUMN_VALUES);
    }

    private async _previewExplorePivot(
        sourceUri: string,
        resultSetIndex: number,
        pivot: ExplorePivotConfig,
        pivotValues: string[],
    ): Promise<string> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Pivot preview is not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL for pivoting.');
        }
        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const built = buildExplorePivotSql(resultSql, resultSet.columns, pivot, pivotValues, databaseKind);
        return built.sql;
    }

    private async _handleExploreComposer(
        sourceUri: string,
        resultSetIndex: number,
        composer: ExploreComposerConfig,
        timeoutSeconds?: number,
    ): Promise<{
        columnIndexes: {
            bucket: number;
            dimension: number | undefined;
            split: number | undefined;
            measure: number;
            previous: number | undefined;
        };
        rows: unknown[][];
        sql: string;
    }> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Composer is not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL for composing.');
        }

        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const built = buildComposerSql(resultSql, resultSet.columns, composer, databaseKind);

        const queryResult = await runQueryRaw({
            context: this._context,
            query: built.sql,
            silent: true,
            connectionManager: this._connectionManager,
            connectionName: this._resolveConnectionForSource(sourceUri),
            documentUri: sourceUri,
            logCallback: message => this.log(sourceUri, message),
            maxRows: 5001,
            isUserQuery: false,
            timeoutSeconds: this._exploreTimeoutSeconds(timeoutSeconds, 300),
        });

        return {
            columnIndexes: built.columnIndexes,
            rows: queryResult.data,
            sql: built.sql,
        };
    }

    private async _previewExploreComposer(
        sourceUri: string,
        resultSetIndex: number,
        composer: ExploreComposerConfig,
    ): Promise<string> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Composer preview is not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL for composing.');
        }
        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const built = buildComposerSql(resultSql, resultSet.columns, composer, databaseKind);
        return built.sql;
    }

    private async _previewExploreFilteredSql(
        sourceUri: string,
        resultSetIndex: number,
        filters: ExploreFilterModel,
    ): Promise<string> {
        if (!this._context || !this._connectionManager) {
            throw new Error('Filtered SQL preview is not available in this view.');
        }
        const resultSet = this._resolveExploreResultSet(sourceUri, resultSetIndex);
        const resultSql = this._resolveGroupingResultSql(resultSet);
        if (!resultSql) {
            throw new Error('This result set does not have refresh SQL.');
        }
        const databaseKind = this._resolveExploreConnectionKind(sourceUri);
        const wrapped = wrapSourceSqlWithFilters(resultSql, filters, resultSet.columns, databaseKind);
        return `SELECT *\n${wrapped.sql}`;
    }

    private async _openExploreSqlInEditor(sql: string, label?: string): Promise<void> {
        if (!this._context) {
            throw new Error('Opening an editor is not available in this view.');
        }
        const document = await vscode.workspace.openTextDocument({
            content: `${label ? `-- ${label}\n` : ''}${sql}`,
            language: 'sql',
        });
        await vscode.window.showTextDocument(document, { preview: false });
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
            isCancelled?: boolean;
        },
        sql: string,
        refreshSql?: string,
    ) {
        this._syncActiveSourceWithFocusedEditor();
        const isActiveSource = this._stateManager.activeSourceUri === sourceUri;
        const resultSetIndex = this._resolveStreamingResultSetIndex(sourceUri, chunk);

        if (chunk.isFirstChunk) {
            // Completion is per statement. A statement without columns (DML/DDL)
            // intentionally has no tabular shell, so remember that it must not
            // inherit or re-mark the previous result's completion state.
            const hadCompletedStreaming = this._stateManager.isStreamingCompleted(sourceUri);
            this._stateManager.clearStreamingCompleted(sourceUri);
            this._streamingResultSets.set(sourceUri, null);
            this._streamingTransportSequence.set(sourceUri, 0);
            if (hadCompletedStreaming && isActiveSource) {
                this._postLightweightActiveSourceUpdate(sourceUri);
            }
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
        traceResultPanelEvent({
            phase: 'append_streaming_chunk',
            sourceUri,
            resultSetIndex,
            rowCount: chunk.rows.length,
            totalRows: chunk.totalRowsSoFar,
            isFirstChunk: chunk.isFirstChunk,
            isLastChunk: chunk.isLastChunk,
            reason: result.type,
        });

        if (chunk.isFirstChunk && chunk.columns.length > 0) {
            // Keep the result object rather than its index: closing an earlier
            // tab while streaming shifts the live result's index.
            // A cancelled/ignored first chunk must never mark a previous result
            // as complete.
            const streamedResultSet = result.type === 'ignore'
                ? undefined
                : this._stateManager.resultsMap.get(sourceUri)?.[result.props.resultSetIndex];
            this._streamingResultSets.set(
                sourceUri,
                streamedResultSet ?? null,
            );
        }

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
                    const chunkSequence = this._streamingTransportSequence.get(sourceUri) ?? 0;
                    const resultSetId = resultSet?.resultSetId ?? result.props.resultSetId;
                    const encodedMessage: ResultPanelOutboundMessage = {
                        ...result.props,
                        rows: encode(this._encoder.sanitizeForMessagePack(rowsToSend)),
                        sourceUri,
                        resultSetId,
                        chunkSequence,
                        fromRow: Math.max(0, chunk.totalRowsSoFar - chunk.rows.length),
                        diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
                    };
                    this._postMessageToWebview(encodedMessage);
                    this._streamingTransportSequence.set(sourceUri, chunkSequence + 1);
                }
            }
        }

        if (chunk.isLastChunk) {
            const trackedResultSet = this._streamingResultSets.get(sourceUri);
            this._streamingResultSets.delete(sourceUri);
            const resultSets = this._stateManager.resultsMap.get(sourceUri);
            const completedResultSetIndex = trackedResultSet
                ? resultSets?.indexOf(trackedResultSet)
                : trackedResultSet === null ? null : undefined;
            if (completedResultSetIndex !== undefined && completedResultSetIndex !== null && completedResultSetIndex >= 0) {
                this._stateManager.markStreamingCompleted(sourceUri);
            }
            if (isActiveSource && completedResultSetIndex !== undefined && completedResultSetIndex !== null && completedResultSetIndex >= 0) {
                const activeResultSet = resultSets?.[completedResultSetIndex];
                this._postStreamingRowCountUpdate(
                    sourceUri,
                    completedResultSetIndex,
                    chunk.totalRowsSoFar,
                    activeResultSet?.limitReached === true || chunk.limitReached,
                    true,
                );
                this._postMessageToWebview({
                    command: 'streamingComplete',
                    sourceUri,
                    resultSetIndex: completedResultSetIndex,
                    totalRows: chunk.totalRowsSoFar,
                    limitReached: activeResultSet?.limitReached === true,
                    resultSetId: activeResultSet?.resultSetId,
                    lastChunkSequence: Math.max(
                        0,
                        (this._streamingTransportSequence.get(sourceUri) ?? 1) - 1,
                    ),
                });
            }
            this._streamingTransportSequence.delete(sourceUri);
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
        const trackedResultSet = this._streamingResultSets.get(sourceUri);
        if (trackedResultSet) {
            const trackedIndex = existing.indexOf(trackedResultSet);
            if (trackedIndex >= 0) {
                return trackedIndex;
            }
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

    private _postMessageToWebview(message: ResultPanelOutboundMessage): Thenable<boolean> | undefined {
        const messageRecord = message as unknown as Record<string, unknown>;
        const sourceUri = getTraceSourceUri(messageRecord, this._stateManager.activeSourceUri);
        const resultSetIndex = typeof messageRecord.resultSetIndex === 'number'
            ? messageRecord.resultSetIndex
            : undefined;
        const totalRows = typeof messageRecord.totalRows === 'number'
            ? messageRecord.totalRows
            : undefined;
        const rowCount = Array.isArray(messageRecord.rows)
            ? messageRecord.rows.length
            : undefined;
        const command = typeof messageRecord.command === 'string'
            ? messageRecord.command
            : undefined;
        traceResultPanelEvent({
            phase: 'host_post',
            command,
            sourceUri,
            resultSetIndex,
            rowCount,
            totalRows,
            isLog: messageRecord.isLog === true,
            isFirstChunk: messageRecord.isFirstChunk === true,
            isLastChunk: messageRecord.isLastChunk === true,
            ready: this._isViewReady,
            visible: this._view?.visible === true,
            delivered: Boolean(this._view),
        });

        if (!this._view) {
            return undefined;
        }

        let posted: Thenable<boolean>;
        try {
            posted = this._view.webview.postMessage(message);
        } catch (error: unknown) {
            traceResultPanelEvent({
                phase: 'host_post_error',
                command,
                sourceUri,
                resultSetIndex,
                error: error instanceof Error ? error.message : String(error),
                delivered: false,
            });
            return undefined;
        }
        // VS Code always returns a Thenable, but keeping this guard preserves
        // the old no-op behavior for lightweight test doubles.
        if (!posted || typeof posted.then !== 'function' || !isResultPanelTraceEnabled()) {
            return posted;
        }
        posted.then(
            delivered => {
                traceResultPanelEvent({
                    phase: 'host_post_result',
                    command,
                    sourceUri,
                    resultSetIndex,
                    delivered,
                });
            },
            error => {
                traceResultPanelEvent({
                    phase: 'host_post_result',
                    command,
                    sourceUri,
                    resultSetIndex,
                    delivered: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        );
        return posted;
    }

    private _postLogUpdate(message: Extract<ResultPanelOutboundMessage, { command: 'appendRows' }>): void {
        const sourceUri = message.sourceUri;
        if (!sourceUri || message.isLog !== true) {
            return;
        }

        this._logSyncRetryAttempts.set(sourceUri, 0);
        const posted = this._postMessageToWebview(message);
        if (posted) {
            posted.then(delivered => {
                if (!delivered) {
                    this._stateManager.markStale(sourceUri);
                }
            }, () => {
                this._stateManager.markStale(sourceUri);
            });
        } else {
            this._stateManager.markStale(sourceUri);
        }
        this._scheduleLogSyncRetry(sourceUri);
    }

    private _handleLogRowsApplied(
        sourceUri: string,
        executionTimestamp: number,
        totalRows: number,
    ): void {
        const current = this._acknowledgedLogRows.get(sourceUri);
        if (
            !current
            || current.executionTimestamp !== executionTimestamp
            || totalRows > current.totalRows
        ) {
            this._acknowledgedLogRows.set(sourceUri, { executionTimestamp, totalRows });
        }

        const expected = this._stateManager.getLogSyncUpdate(sourceUri, 0);
        if (
            expected
            && expected.logExecutionTimestamp === executionTimestamp
            && totalRows >= expected.totalRows
        ) {
            this._clearLogSyncRetryTimer(sourceUri);
            this._logSyncRetryAttempts.delete(sourceUri);
        } else {
            this._scheduleLogSyncRetry(sourceUri);
        }
    }

    private _handleLogSyncRequest(
        sourceUri: string,
        executionTimestamp: number | undefined,
        currentRows: number,
    ): void {
        const latest = this._stateManager.getLogSyncUpdate(sourceUri, 0);
        if (!latest || this._stateManager.activeSourceUri !== sourceUri) {
            return;
        }
        const fromRow = executionTimestamp === latest.logExecutionTimestamp ? currentRows : 0;
        const update = this._stateManager.getLogSyncUpdate(sourceUri, fromRow);
        if (update) {
            this._postMessageToWebview(update);
            this._scheduleLogSyncRetry(sourceUri);
        }
    }

    private _scheduleLogSyncRetry(sourceUri: string): void {
        this._clearLogSyncRetryTimer(sourceUri);
        if (!this._view || !this._isViewReady || this._view.visible !== true) {
            return;
        }

        const timer = setTimeout(() => {
            this._logSyncRetryTimers.delete(sourceUri);
            const latest = this._stateManager.getLogSyncUpdate(sourceUri, 0);
            if (!latest || this._stateManager.activeSourceUri !== sourceUri) {
                return;
            }

            const acknowledged = this._acknowledgedLogRows.get(sourceUri);
            if (
                acknowledged
                && acknowledged.executionTimestamp === latest.logExecutionTimestamp
                && acknowledged.totalRows >= latest.totalRows
            ) {
                this._logSyncRetryAttempts.delete(sourceUri);
                return;
            }

            const attempts = (this._logSyncRetryAttempts.get(sourceUri) ?? 0) + 1;
            this._logSyncRetryAttempts.set(sourceUri, attempts);
            if (attempts > 3) {
                this._stateManager.markStale(sourceUri);
                this._forceHydrate();
                return;
            }

            const fromRow = acknowledged?.executionTimestamp === latest.logExecutionTimestamp
                ? acknowledged.totalRows
                : 0;
            const update = this._stateManager.getLogSyncUpdate(sourceUri, fromRow);
            if (update) {
                this._postMessageToWebview(update);
                this._scheduleLogSyncRetry(sourceUri);
            }
        }, 250);
        this._logSyncRetryTimers.set(sourceUri, timer);
    }

    private _clearLogSyncRetryTimer(sourceUri: string): void {
        const timer = this._logSyncRetryTimers.get(sourceUri);
        if (timer) {
            clearTimeout(timer);
            this._logSyncRetryTimers.delete(sourceUri);
        }
    }

    private _clearAllLogSyncRetryTimers(): void {
        for (const timer of this._logSyncRetryTimers.values()) {
            clearTimeout(timer);
        }
        this._logSyncRetryTimers.clear();
    }

    private _revealViewForExecution() {
        if (this._view?.visible) {
            return;
        }

        // WebviewView does not expose WebviewPanel.show()/reveal(). Once the
        // results view has been resolved but its panel is hidden, the only
        // supported way to reveal it again is the contributed focus command.
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
        traceResultPanelEvent({
            phase: 'update_webview',
            sourceUri: activeSource,
            resultSetCount: activeSource ? this._stateManager.resultsMap.get(activeSource)?.length ?? 0 : 0,
            ready: this._isViewReady,
            visible: this._view.visible === true,
            reason: isStale
                ? 'stale'
                : globalChanged
                    ? 'global-change'
                    : sourceChanged
                        ? 'source-changed'
                        : activeSource && currentVersion !== lastSentVersion
                            ? 'data-version'
                            : 'no-op',
        });

        // After streaming, webview already has rows via appendRows.
        // Skip full hydrate when only the data version bumped (finalizeExecution).
        const streamingCompleted = activeSource ? this._stateManager.isStreamingCompleted(activeSource) : false;
        if (streamingCompleted && !isStale && !sourceChanged && activeSource && currentVersion !== lastSentVersion) {
            const lastStreamingVersion = this._lastStreamingFinalizeVersion.get(activeSource) ?? -1;
            if (currentVersion === lastStreamingVersion) {
                traceResultPanelEvent({
                    phase: 'update_skipped',
                    sourceUri: activeSource,
                    reason: 'streaming-finalize-version-already-sent',
                });
                return;
            }

            if (!this._memoryResultNeedsFullHydrateAfterStreaming(activeSource)) {
                this._lastStreamingFinalizeVersion.set(activeSource, currentVersion);
                this._stateManager.setSentDataVersion(activeSource, currentVersion);
                this._stateManager.lastSentGlobalStateVersion = this._stateManager.globalStateVersion;

                if (this._isViewReady) {
                    this._postLightweightActiveSourceUpdate(activeSource);
                }
                traceResultPanelEvent({
                    phase: 'update_skipped',
                    sourceUri: activeSource,
                    reason: 'streaming-complete-lightweight',
                });
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
            traceResultPanelEvent({
                phase: 'update_skipped',
                sourceUri: activeSource,
                reason: 'actively-streaming-lightweight',
            });
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
                    data: viewData,
                    uxTraceId: this._pendingUxTraceId,
                });
                traceResultPanelEvent({
                    phase: 'hydrate_posted',
                    sourceUri: metrics.activeSource ?? activeSource,
                    resultSetCount: metrics.resultSetCount,
                    totalRows: metrics.totalRowCount,
                    reason,
                });
                if (getUxPerfSession().isActive() && this._pendingUxTraceId) {
                    getUxPerfSession().emit({
                        op: 'result_panel.source_switch',
                        phase: 'hydrate_posted',
                        traceId: this._pendingUxTraceId,
                        meta: {
                            reason,
                            payloadBytes: metrics.payloadBytes,
                            resultSetCount: metrics.resultSetCount,
                        },
                    });
                }
            } else {
                this._view.webview.html = this._getHtmlForWebview();
            }
            return;
        }

        console.log(
            `[ResultPanelView] Data for ${activeSource} is current (v${currentVersion}), skipping no-op update`
        );
        traceResultPanelEvent({
            phase: 'update_skipped',
            sourceUri: activeSource,
            reason: 'no-op-current-data',
        });
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
            streamingCompletedSourcesJson: JSON.stringify(Array.from(this._stateManager.streamingCompletedSources)),
            diskBackedStreamCapEnabled: this._isDiskBackedStreamCapEnabled(),
            formatSettings: this._formattingStore
                ? this._formattingStore.getPayloadForSource(sourceUri)
                : undefined,
            uxTraceId: this._pendingUxTraceId,
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
            ensureResultSetId(emptyLog);
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
                streamingCompletedSourcesJson: JSON.stringify(Array.from(this._stateManager.streamingCompletedSources)),
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
                // The webview bridge is test-only as well as trace-gated. Do
                // not enable it merely because a production process inherited
                // the diagnostic environment variable.
                resultPanelTraceEnabled: process.env.NODE_ENV === 'test'
                    && isResultPanelTraceEnabled(),
                resultSyncVersion: this._resultSyncVersion,
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
            ensureResultSetId(resultSet);
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
