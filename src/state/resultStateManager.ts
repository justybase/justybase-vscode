import * as vscode from 'vscode';
import { ResultSet } from '../types';
import { getLogger } from '../utils/logger';
import { getExtensionConfiguration } from '../compatibility/configuration';
import {
    getDiskBackedResultsSettings,
    getEffectiveSpillThreshold,
    isDiskBackedResultsAvailable,
} from '../core/resultDataProvider/diskBackedSettings';
import { diskBackedStoreRegistry, aggregateDiskBackedRows, countDiskBackedRows, distinctDiskBackedValues, queryDiskBackedGroups, queryDiskBackedRows } from '../core/resultDataProvider/diskBackedStoreRegistry';
import type { DiskAggregationRequest, DiskAggregationResult, DiskGroupLevel, DiskGroupPathItem, DiskGroupQueryResult, DiskQuerySpec } from '../core/resultDataProvider/types';
import { detectEditSource } from '../results/editSourceDetector';
import { SqliteResultStore } from '../core/resultDataProvider/sqliteResultStore';
import { tempFileRegistry } from '../core/tempFileRegistry';
import {
    DISK_BACKED_FIRST_PAGE_SIZE,
    type DiskBackedActivateProps,
    type RowCountUpdateProps,
} from '../core/resultDataProvider/types';

/** SQL truncation length for log entries */
const SQL_TRUNCATION_LENGTH = 200;

function estimateValueBytes(value: unknown, depth = 0): number {
    if (value === null || value === undefined) return 1;
    if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 16;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return 16;
    if (value instanceof Date) return 16;
    if (Buffer.isBuffer(value)) return value.byteLength + 16;
    if (depth > 2) return 64;
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') + 32;
    } catch {
        return 64;
    }
}

function estimateRowsBytes(rows: unknown[][]): number {
    let bytes = 0;
    for (const row of rows) {
        bytes += 24;
        for (const value of row) bytes += estimateValueBytes(value);
    }
    return bytes;
}

interface ExecutionLogEntry {
    id: string;
    sql: string;
    truncatedSql: string;
    connectionName: string;
    startTime: number;
    endTime?: number;
    rowCount?: number;
    status: 'running' | 'success' | 'error' | 'cancelled' | 'retrying';
    errorMessage?: string;
}

type AppendStreamingResult =
    | { type: 'incremental'; props: AppendRowsMessage }
    | { type: 'diskBackedActivate'; props: DiskBackedActivateProps }
    | { type: 'rowCountUpdate'; props: RowCountUpdateProps }
    | { type: 'ignore' };

interface AppendRowsMessage {
    command: 'appendRows';
    resultSetIndex: number;
    rows: unknown[][];
    totalRows: number;
    isLastChunk: boolean;
    limitReached: boolean;
    isFirstChunk?: boolean;
    isEditable?: boolean;
    editSource?: { db?: string; schema?: string; table: string } | null;
    columns?: { name: string; type?: string; scale?: number }[];
    sql?: string;
    refreshSql?: string;
    executionTimestamp?: number;
}

interface LogAppendMessage {
    command: 'appendRows';
    sourceUri: string;
    resultSetIndex: number;
    rows: [string, string][];
    totalRows: number;
    fromRow: number;
    logExecutionTimestamp: number;
    isLastChunk: boolean;
    limitReached: boolean;
    isLog: true;
}

type OneChunk = {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    isFirstChunk: boolean;
    isLastChunk: boolean;
    totalRowsSoFar: number;
    limitReached: boolean;
    isCancelled?: boolean;
};

export interface PinnedResultInfo {
    sourceUri: string;
    resultSetIndex: number;
    timestamp: number;
    label: string;
}

export interface StreamingChunk {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    isFirstChunk: boolean;
    isLastChunk: boolean;
    totalRowsSoFar: number;
    limitReached: boolean;
}

export class ResultStateManager {
    // Map<sourceUri, resultSets[]>
    private _resultsMap: Map<string, ResultSet[]> = new Map();
    private _pinnedSources: Set<string> = new Set();
    // Map<resultId, {sourceUri, resultSetIndex, timestamp, label}>
    private _pinnedResults: Map<string, PinnedResultInfo> = new Map();
    private _autoPinnedResults: Set<string> = new Set(); // Track auto-pinned results for current execution
    private _activeSourceUri: string | undefined;
    private _activeResultSetIndexMap: Map<string, number> = new Map();
    private _resultIdCounter: number = 0;
    private _executingSources: Set<string> = new Set();
    private _cancelledSources: Set<string> = new Set();
    private _currentExecutionId: Map<string, number> = new Map(); // Track current execution per source
    private _limitWarningShown: Set<string> = new Set(); // Track if limit warning was shown for current execution

    // Execution logs tracking
    private _executionLogs: Map<string, ExecutionLogEntry[]> = new Map(); // sourceUri -> logs

    // Versioning for efficient updates
    private _dataVersions: Map<string, number> = new Map(); // Increment on metadata/data changes
    private _sentDataVersions: Map<string, number> = new Map(); // Last version sent to webview
    private _staleDataVersions: Set<string> = new Set(); // Track which sources need to be re-sent
    private _lastSentGlobalStateVersion: number = 0; // Tracks if global list of sources changed
    private _globalStateVersion: number = 0;

    // Phase 1: Track which sources completed streaming.
    // When all rows were sent incrementally to webview, skip full re-encode on finalize.
    private _streamingCompletedSources: Set<string> = new Set();

    // Event emitter for cancel notifications
    private _onDidCancel = new vscode.EventEmitter<string>();
    public readonly onDidCancel = this._onDidCancel.event;

    private _onDidSpillToDisk = new vscode.EventEmitter<DiskBackedActivateProps>();
    public readonly onDidSpillToDisk = this._onDidSpillToDisk.event;

    // Event emitter for state changes that might require view updates
    private _onDidChangeState = new vscode.EventEmitter<void>();
    public readonly onDidChangeState = this._onDidChangeState.event;

    private _panelVisible = true;
    private _lastAccessedAt = new Map<string, number>();
    private _idleSpillTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this._idleSpillTimer = setInterval(() => {
            this._runIdleSpillCheck();
        }, 60_000);
    }

    public dispose(): void {
        if (this._idleSpillTimer) {
            clearInterval(this._idleSpillTimer);
            this._idleSpillTimer = null;
        }
    }

    private _resultAccessKey(sourceUri: string, resultSetIndex: number): string {
        return `${sourceUri}::${resultSetIndex}`;
    }

    public setPanelVisible(visible: boolean): void {
        const wasVisible = this._panelVisible;
        this._panelVisible = visible;
        if (wasVisible && !visible) {
            this._runIdleSpillCheck({ panelHidden: true });
        }
    }

    public touchResultSetAccess(sourceUri: string, resultSetIndex: number): void {
        this._lastAccessedAt.set(this._resultAccessKey(sourceUri, resultSetIndex), Date.now());
    }

    private _runIdleSpillCheck(options: { panelHidden?: boolean } = {}): void {
        const settings = getDiskBackedResultsSettings();
        if (!isDiskBackedResultsAvailable(settings) || settings.idleSpillMinutes <= 0) {
            return;
        }

        const idleMs = settings.idleSpillMinutes * 60_000;
        const now = Date.now();
        const activeSource = this._activeSourceUri;

        for (const [sourceUri, resultSets] of this._resultsMap.entries()) {
            const isActiveSource = sourceUri === activeSource;
            for (let resultSetIndex = 0; resultSetIndex < resultSets.length; resultSetIndex++) {
                const rs = resultSets[resultSetIndex];
                if (!rs || rs.isLog || rs.isError || rs.storageMode === 'sqlite') {
                    continue;
                }
                const rowCount = rs.totalRowCount ?? rs.data.length;
                if (rowCount < settings.idleSpillRowThreshold) {
                    continue;
                }

                const accessKey = this._resultAccessKey(sourceUri, resultSetIndex);
                const lastAccess = this._lastAccessedAt.get(accessKey) ?? rs.executionTimestamp ?? now;
                const idleFor = now - lastAccess;
                const spillImmediately = options.panelHidden === true && !this._panelVisible && !isActiveSource;
                if (!spillImmediately && idleFor < idleMs) {
                    continue;
                }

                const props = this.spillResultSetToDisk(
                    sourceUri,
                    rs,
                    resultSetIndex,
                    rowCount,
                    rs.limitReached === true,
                    true,
                );
                if (props) {
                    this._onDidSpillToDisk.fire(props);
                    getLogger().info(
                        `Idle spill for ${sourceUri} result ${resultSetIndex}: ${rowCount} rows`
                    );
                }
            }
        }
    }

    /**
     * Get the maximum number of data results from configuration
     */
    private getMaxDataResults(): number {
        const config = getExtensionConfiguration('results');
        return config.get<number>('maxDataResults', 50) ?? 50;
    }

    /**
     * Get the maximum number of pinned data results from configuration
     */
    private getMaxPinnedDataResults(): number {
        const config = getExtensionConfiguration('results');
        return config.get<number>('maxPinnedDataResults', 10) ?? 10;
    }

    public get resultsMap() {
        return this._resultsMap;
    }
    public get pinnedSources() {
        return this._pinnedSources;
    }
    public get pinnedResults() {
        return this._pinnedResults;
    }
    public get activeSourceUri() {
        return this._activeSourceUri;
    }
    public get executingSources() {
        return this._executingSources;
    }

    /** Mark a source as having completed streaming (all rows sent incrementally to webview). */
    public markStreamingCompleted(sourceUri: string): void {
        this._streamingCompletedSources.add(sourceUri);
    }

    /** Check if a source completed streaming (incremental delivery). */
    public isStreamingCompleted(sourceUri: string): boolean {
        return this._streamingCompletedSources.has(sourceUri);
    }

    /** Clear streaming completed flag (e.g., on new execution). */
    public clearStreamingCompleted(sourceUri: string): void {
        this._streamingCompletedSources.delete(sourceUri);
    }

    public get globalStateVersion() {
        return this._globalStateVersion;
    }
    public get lastSentGlobalStateVersion() {
        return this._lastSentGlobalStateVersion;
    }
    public set lastSentGlobalStateVersion(v: number) {
        this._lastSentGlobalStateVersion = v;
    }

    public getDataVersion(sourceUri: string) {
        return this._dataVersions.get(sourceUri) || 0;
    }
    public getSentDataVersion(sourceUri: string) {
        return this._sentDataVersions.get(sourceUri) || -1;
    }
    public setSentDataVersion(sourceUri: string, version: number) {
        this._sentDataVersions.set(sourceUri, version);
    }
    public isStale(sourceUri: string) {
        return this._staleDataVersions.has(sourceUri);
    }
    public clearStale(sourceUri: string) {
        this._staleDataVersions.delete(sourceUri);
    }
    public markStale(sourceUri: string) {
        this._staleDataVersions.add(sourceUri);
    }
    public markAllStale() {
        for (const sourceUri of this._resultsMap.keys()) {
            this._staleDataVersions.add(sourceUri);
        }
    }
    public getActiveResultSetIndex(sourceUri: string) {
        return this._activeResultSetIndexMap.get(sourceUri);
    }

    public setActiveSource(sourceUri: string): boolean {
        if (!this._isValidSourceUri(sourceUri)) {
            return false;
        }
        if (this._activeSourceUri === sourceUri) return false;

        this._activeSourceUri = sourceUri;

        if (!this._resultsMap.has(sourceUri)) {
            this._resultsMap.set(sourceUri, []);
        }
        const activeIndex = this._activeResultSetIndexMap.get(sourceUri) ?? 0;
        this.touchResultSetAccess(sourceUri, activeIndex);
        this._onDidChangeState.fire();
        return true;
    }

    private _isValidSourceUri(sourceUri: string): boolean {
        return sourceUri.startsWith('file:') || sourceUri.startsWith('untitled:');
    }

    public startExecution(sourceUri: string): { clearedUnpinnedResults: boolean } {
        if (!this._isValidSourceUri(sourceUri)) {
            return { clearedUnpinnedResults: false };
        }
        this._executingSources.add(sourceUri);
        this._cancelledSources.delete(sourceUri);
        this._streamingCompletedSources.delete(sourceUri); // Fresh execution, no streaming yet

        // Generate new execution ID
        const newExecutionId = Date.now();
        this._currentExecutionId.set(sourceUri, newExecutionId);
        this._limitWarningShown.delete(sourceUri); // Reset warning flag for new execution

        const existingResults = this._resultsMap.get(sourceUri) || [];

        // Remove all unpinned data results from previous executions
        // Keep only: logs and manually pinned results
        const pinnedIndices = new Set<number>();
        for (const [id, info] of this._pinnedResults.entries()) {
            if (info.sourceUri === sourceUri && !this._autoPinnedResults.has(id)) {
                pinnedIndices.add(info.resultSetIndex);
            }
        }

        const resultsToRemove: number[] = [];
        existingResults.forEach((rs, index) => {
            // Keep logs and manually pinned results
            if (!rs.isLog && !pinnedIndices.has(index)) {
                resultsToRemove.push(index);
            }
        });

        // Remove unpinned results (in reverse order to preserve indices)
        if (resultsToRemove.length > 0) {
            resultsToRemove.sort((a, b) => b - a);
            for (const index of resultsToRemove) {
                const rs = existingResults[index];
                if (rs) {
                    this._releaseResultSetResources(rs);
                }
                existingResults.splice(index, 1);

                // Update pins - remove auto-pins and adjust indices
                const pins = Array.from(this._pinnedResults.entries()).filter(([_, info]) => info.sourceUri === sourceUri);
                for (const [id, info] of pins) {
                    if (info.resultSetIndex === index) {
                        this._pinnedResults.delete(id);
                        this._autoPinnedResults.delete(id);
                    } else if (info.resultSetIndex > index) {
                        info.resultSetIndex--;
                    }
                }
            }
        }

        let logResultSet: ResultSet;

        const existingLogIndex = existingResults.findIndex(r => r.isLog);
        if (existingLogIndex !== -1) {
            logResultSet = existingResults[existingLogIndex];
            const timestamp = new Date().toLocaleTimeString();
            logResultSet.data.push(['', '']);
            logResultSet.data.push([timestamp, '--- New Execution Started ---']);
            logResultSet.message = 'Execution started...';
            logResultSet.executionTimestamp = Date.now();

            // Move log to front if it's not already
            if (existingLogIndex !== 0) {
                existingResults.splice(existingLogIndex, 1);
                existingResults.unshift(logResultSet);
                // Update pins accordingly
                this._updatePinsOnReorder(sourceUri);
            }
        } else {
            const timestamp = new Date().toLocaleTimeString();
            logResultSet = {
                columns: [
                    { name: 'Time', type: 'string' },
                    { name: 'Message', type: 'string' }
                ],
                data: [[timestamp, '--- New Execution Started ---']],
                message: 'Execution started...',
                executionTimestamp: Date.now(),
                isLog: true,
                name: 'Logs'
            } as ResultSet;
            existingResults.unshift(logResultSet);
            this._updatePinsOnReorder(sourceUri);
        }

        this._resultsMap.set(sourceUri, existingResults);
        this._pinnedSources.add(sourceUri);
        this._activeSourceUri = sourceUri;
        this._activeResultSetIndexMap.set(sourceUri, 0);

        // Bump the version so the webview receives executingSources and loading state.
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
        return { clearedUnpinnedResults: resultsToRemove.length > 0 };
    }

    private _updatePinsOnReorder(_sourceUri: string) {
        // This is a naive way to fix pins when we don't know the exact shift.
        // But since we only move Log to 0, or prune, we can handle it better.
        // For now, we'll rely on the logic in closeResult/pruneResults.
    }

    public log(sourceUri: string, message: string): LogAppendMessage | undefined {
        const results = this._resultsMap.get(sourceUri);
        if (!results || results.length === 0) return undefined;

        const logResultSetIndex = results.findIndex(r => r.isLog);

        if (logResultSetIndex !== -1) {
            const logResultSet = results[logResultSetIndex];
            const timestamp = new Date().toLocaleTimeString();
            const row: [string, string] = [timestamp, message];
            const fromRow = logResultSet.data.length;

            logResultSet.data.push(row);
            this._incrementDataVersion(sourceUri);

            return {
                command: 'appendRows',
                sourceUri,
                resultSetIndex: logResultSetIndex,
                rows: [row],
                totalRows: logResultSet.data.length,
                fromRow,
                logExecutionTimestamp: logResultSet.executionTimestamp ?? 0,
                isLastChunk: false,
                limitReached: false,
                isLog: true
            };
        }
        return undefined;
    }

    /**
     * Truncate SQL to specified length
     */
    private truncateSql(sql: string, maxLength: number = SQL_TRUNCATION_LENGTH): string {
        if (sql.length <= maxLength) {
            return sql;
        }
        return sql.substring(0, maxLength) + '...';
    }

    /**
     * Log the start of SQL execution
     * @param sourceUri The source URI
     * @param sql The SQL query being executed
     * @param connectionName The connection name
     * @returns The execution log entry ID
     */
    public logExecutionStart(sourceUri: string, sql: string, connectionName: string): { id: string; incrementalUpdate?: LogAppendMessage } {
        const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const truncatedSql = this.truncateSql(sql);

        const entry: ExecutionLogEntry = {
            id: executionId,
            sql,
            truncatedSql,
            connectionName,
            startTime: Date.now(),
            status: 'running'
        };

        // Store in execution logs
        if (!this._executionLogs.has(sourceUri)) {
            this._executionLogs.set(sourceUri, []);
        }
        this._executionLogs.get(sourceUri)!.push(entry);

        // Also add to the visual log for display
        const results = this._resultsMap.get(sourceUri);
        let incrementalUpdate: LogAppendMessage | undefined;

        if (results && results.length > 0) {
            const logResultSetIndex = results.findIndex(r => r.isLog);
            if (logResultSetIndex !== -1) {
                const logResultSet = results[logResultSetIndex];
                const timestamp = new Date().toLocaleTimeString();
                // Format: [time] ▶ RUNNING: [sql truncated] | [connection]
                const logMessage = `▶ RUNNING: ${truncatedSql} | ${connectionName}`;
                const row: [string, string] = [timestamp, logMessage];
                const fromRow = logResultSet.data.length;

                logResultSet.data.push(row);
                this._incrementDataVersion(sourceUri);

                incrementalUpdate = {
                    command: 'appendRows',
                    sourceUri,
                    resultSetIndex: logResultSetIndex,
                    rows: [row],
                    totalRows: logResultSet.data.length,
                    fromRow,
                    logExecutionTimestamp: logResultSet.executionTimestamp ?? 0,
                    isLastChunk: false,
                    limitReached: false,
                    isLog: true
                };
            }
        }

        return { id: executionId, incrementalUpdate };
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
    ): LogAppendMessage | undefined {
        // Find and update the execution log entry
        for (const [sourceUri, logs] of this._executionLogs.entries()) {
            const entry = logs.find(e => e.id === executionId);
            if (entry) {
                entry.endTime = Date.now();
                entry.rowCount = rowCount;
                entry.status = status;
                entry.errorMessage = errorMessage;

                // Calculate execution time
                const executionTime = entry.endTime - entry.startTime;
                const timeStr = this.formatExecutionTime(executionTime);

                // Format status indicator
                let statusIcon: string;
                let statusText: string;
                switch (status) {
                    case 'success':
                        statusIcon = '✓';
                        statusText = 'SUCCESS';
                        break;
                    case 'error':
                        statusIcon = '✗';
                        statusText = 'ERROR';
                        break;
                    case 'cancelled':
                        statusIcon = '⊘';
                        statusText = 'CANCELLED';
                        break;
                    case 'retrying':
                        statusIcon = '↻';
                        statusText = 'RETRYING';
                        break;
                }

                // Add to visual log
                const results = this._resultsMap.get(sourceUri);
                if (results && results.length > 0) {
                    const logResultSetIndex = results.findIndex(r => r.isLog);
                    if (logResultSetIndex !== -1) {
                        const logResultSet = results[logResultSetIndex];
                        const timestamp = new Date().toLocaleTimeString();
                        let logMessage: string;

                        if (status === 'retrying') {
                            logMessage = `${statusIcon} ${statusText}: ${entry.truncatedSql} | ${entry.connectionName}${errorMessage ? ` | ${errorMessage}` : ''}`;
                        } else if (status === 'error' && errorMessage) {
                            // For errors, show the error message
                            logMessage = `${statusIcon} ${statusText}: ${entry.truncatedSql} | ${entry.connectionName} | ${timeStr} | ${rowCount} rows | ${errorMessage}`;
                        } else {
                            logMessage = `${statusIcon} ${statusText}: ${entry.truncatedSql} | ${entry.connectionName} | ${timeStr} | ${rowCount} rows`;
                        }

                        const row: [string, string] = [timestamp, logMessage];
                        const fromRow = logResultSet.data.length;
                        logResultSet.data.push(row);
                        this._incrementDataVersion(sourceUri);

                        if (status === 'retrying') {
                            entry.startTime = Date.now();
                            entry.endTime = undefined;
                            entry.rowCount = undefined;
                            entry.errorMessage = undefined;
                        }

                        return {
                            command: 'appendRows',
                            sourceUri,
                            resultSetIndex: logResultSetIndex,
                            rows: [row],
                            totalRows: logResultSet.data.length,
                            fromRow,
                            logExecutionTimestamp: logResultSet.executionTimestamp ?? 0,
                            isLastChunk: false,
                            limitReached: false,
                            isLog: true
                        };
                    }
                }

                break;
            }
        }
        return undefined;
    }

    /** Build an authoritative log delta for webview gap recovery. */
    public getLogSyncUpdate(sourceUri: string, fromRow: number): LogAppendMessage | undefined {
        const results = this._resultsMap.get(sourceUri);
        const resultSetIndex = results?.findIndex(result => result.isLog) ?? -1;
        if (!results || resultSetIndex < 0) {
            return undefined;
        }

        const logResultSet = results[resultSetIndex];
        const safeFromRow = Math.max(0, Math.min(fromRow, logResultSet.data.length));
        return {
            command: 'appendRows',
            sourceUri,
            resultSetIndex,
            rows: logResultSet.data.slice(safeFromRow) as [string, string][],
            totalRows: logResultSet.data.length,
            fromRow: safeFromRow,
            logExecutionTimestamp: logResultSet.executionTimestamp ?? 0,
            isLastChunk: false,
            limitReached: false,
            isLog: true,
        };
    }

    /**
     * Format execution time in human-readable format
     */
    private formatExecutionTime(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        } else if (ms < 60000) {
            const seconds = (ms / 1000).toFixed(2);
            return `${seconds}s`;
        } else {
            const minutes = Math.floor(ms / 60000);
            const seconds = ((ms % 60000) / 1000).toFixed(0);
            return `${minutes}m ${seconds}s`;
        }
    }

    /**
     * Get execution logs for a source URI
     */
    public getExecutionLogs(sourceUri: string): ExecutionLogEntry[] {
        return this._executionLogs.get(sourceUri) || [];
    }

    /**
     * Clear execution logs for a source URI
     */
    public clearExecutionLogs(sourceUri: string): void {
        this._executionLogs.delete(sourceUri);
    }

    public isCancelled(sourceUri: string): boolean {
        return this._cancelledSources.has(sourceUri);
    }

    public cancelExecution(sourceUri: string, currentRowCounts?: number[]) {
        if (this._executingSources.has(sourceUri)) {
            this._executingSources.delete(sourceUri);
        }
        this._cancelledSources.add(sourceUri);
        this._onDidCancel.fire(sourceUri);

        const results = this._resultsMap.get(sourceUri) || [];
        results.forEach((rs, index) => {
            rs.isCancelled = true;
            if (currentRowCounts && currentRowCounts[index] !== undefined) {
                const rowCount = currentRowCounts[index]!;
                if (rs.storageMode === 'sqlite' && rs.diskStoreId) {
                    const store = diskBackedStoreRegistry.get(rs.diskStoreId);
                    store?.truncateToRowCount(rowCount);
                    rs.totalRowCount = rowCount;
                } else {
                    rs.data = rs.data.slice(0, rowCount);
                    rs.totalRowCount = rowCount;
                }
            }
        });

        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public finalizeExecution(sourceUri: string) {
        this._executingSources.delete(sourceUri);

        const results = this._resultsMap.get(sourceUri);
        if (results) {
            for (const rs of results) {
                if (rs.storageMode === 'sqlite' && rs.diskStoreId) {
                    diskBackedStoreRegistry.get(rs.diskStoreId)?.finalizeBulkInsert();
                }
            }
        }

        // Switch active tab to the last (most recent) result
        if (results && results.length > 1) {
            this._activeResultSetIndexMap.set(sourceUri, results.length - 1);
        }

        // Remove auto-pinned results for this source
        const autoPinsToDelete = Array.from(this._autoPinnedResults).filter(id => {
            const pin = this._pinnedResults.get(id);
            return pin && pin.sourceUri === sourceUri;
        });

        for (const id of autoPinsToDelete) {
            this._pinnedResults.delete(id);
            this._autoPinnedResults.delete(id);
        }

        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public startResultRefresh(sourceUri: string, resultSetIndex: number): boolean {
        const results = this._resultsMap.get(sourceUri);
        const resultSet = results?.[resultSetIndex];
        if (!resultSet || resultSet.isLog || resultSet.isTextContent || resultSet.isError) {
            return false;
        }

        this._executingSources.add(sourceUri);
        this._cancelledSources.delete(sourceUri);
        this._streamingCompletedSources.delete(sourceUri);
        this._activeSourceUri = sourceUri;
        this._activeResultSetIndexMap.set(sourceUri, resultSetIndex);
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
        return true;
    }

    public finalizeResultRefresh(sourceUri: string, resultSetIndex: number): void {
        this._executingSources.delete(sourceUri);
        this._activeResultSetIndexMap.set(sourceUri, resultSetIndex);
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public setResultSetRefreshFailure(
        sourceUri: string,
        resultSetIndex: number,
        failure: { message: string; sql?: string },
    ): void {
        const results = this._resultsMap.get(sourceUri);
        const resultSet = results?.[resultSetIndex];
        if (!resultSet || resultSet.isLog) {
            return;
        }

        resultSet.refreshFailure = {
            message: failure.message,
            sql: failure.sql,
            failedAt: Date.now(),
        };
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public clearResultSetRefreshFailure(sourceUri: string, resultSetIndex: number): void {
        const results = this._resultsMap.get(sourceUri);
        const resultSet = results?.[resultSetIndex];
        if (!resultSet?.refreshFailure) {
            return;
        }

        delete resultSet.refreshFailure;
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public replaceResultSet(sourceUri: string, resultSetIndex: number, resultSet: ResultSet): void {
        const results = this._resultsMap.get(sourceUri);
        if (!results || resultSetIndex < 0 || resultSetIndex >= results.length) {
            throw new Error('Result set not found');
        }

        const existing = results[resultSetIndex];
        if (!existing || existing.isLog) {
            throw new Error('Result set cannot be refreshed');
        }

        this._releaseResultSetResources(existing);

        if (!resultSet.executionTimestamp) {
            resultSet.executionTimestamp = Date.now();
        }

        if (!resultSet.refreshSql && existing.refreshSql) {
            resultSet.refreshSql = existing.refreshSql;
        }

        if (resultSet.refreshSql) {
            const editSource = detectEditSource(resultSet.refreshSql);
            resultSet.isEditable = editSource !== null;
            resultSet.editSource = editSource ?? undefined;
        }

        results[resultSetIndex] = resultSet;
        this._activeSourceUri = sourceUri;
        this._activeResultSetIndexMap.set(sourceUri, resultSetIndex);
        this.touchResultSetAccess(sourceUri, resultSetIndex);

        // Replaced result sets must be delivered via full hydrate, not streaming lightweight updates.
        this.clearStreamingCompleted(sourceUri);
        this.markStale(sourceUri);

        if (!resultSet.isLog && !resultSet.isError) {
            const rowCount = resultSet.totalRowCount ?? resultSet.data.length;
            if (this._shouldUseDiskBacking(rowCount, resultSet.data.length, resultSet.bufferedBytes ?? estimateRowsBytes(resultSet.data))) {
                const props = this.spillResultSetToDisk(
                    sourceUri,
                    resultSet,
                    resultSetIndex,
                    rowCount,
                    resultSet.limitReached === true,
                );
                if (props) {
                    this._onDidSpillToDisk.fire(props);
                }
            }
        }

        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    public updateResults(results: ResultSet[], sourceUri: string, _append: boolean = false) {
        if (!this._resultsMap.has(sourceUri)) {
            this._pinnedSources.add(sourceUri);
        }

        const newResultSets = Array.isArray(results) ? results : [results];
        newResultSets.forEach(rs => {
            if (!rs.executionTimestamp) rs.executionTimestamp = Date.now();
        });

        const currentResults = this._resultsMap.get(sourceUri) || [];

        // Remove all unpinned (non-auto-pinned) data results before adding new ones
        // Keep only: logs and manually pinned results
        const pinnedIndices = new Set<number>();
        for (const [id, info] of this._pinnedResults.entries()) {
            if (info.sourceUri === sourceUri && !this._autoPinnedResults.has(id)) {
                pinnedIndices.add(info.resultSetIndex);
            }
        }

        const resultsToRemove: number[] = [];
        currentResults.forEach((rs, index) => {
            // Keep logs and manually pinned results
            if (!rs.isLog && !pinnedIndices.has(index)) {
                resultsToRemove.push(index);
            }
        });

        // Remove unpinned results (in reverse order to preserve indices)
        if (resultsToRemove.length > 0) {
            // Show info to user about removed results
            const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
            vscode.window.showInformationMessage(
                `Removed ${resultsToRemove.length} ${resultsToRemove.length === 1 ? 'unpinned result' : 'unpinned results'} from "${filename}". ` +
                `Unpinned results are automatically cleared when running new SQL. ` +
                `Pin important results to keep them across executions.`
            );

            resultsToRemove.sort((a, b) => b - a);
            for (const index of resultsToRemove) {
                const rs = currentResults[index];
                if (rs) {
                    this._releaseResultSetResources(rs);
                }
                currentResults.splice(index, 1);

                // Update pins - remove auto-pins and adjust indices
                const pins = Array.from(this._pinnedResults.entries()).filter(([_, info]) => info.sourceUri === sourceUri);
                for (const [id, info] of pins) {
                    if (info.resultSetIndex === index) {
                        this._pinnedResults.delete(id);
                        this._autoPinnedResults.delete(id);
                    } else if (info.resultSetIndex > index) {
                        info.resultSetIndex--;
                    }
                }
            }

            // Update pinnedIndices after removal
            pinnedIndices.clear();
            for (const [id, info] of this._pinnedResults.entries()) {
                if (info.sourceUri === sourceUri && !this._autoPinnedResults.has(id)) {
                    pinnedIndices.add(info.resultSetIndex);
                }
            }
        }

        // Add new results
        currentResults.push(...newResultSets);
        this._resultsMap.set(sourceUri, currentResults);

        // Auto-pin new results
        const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
        newResultSets.forEach(rs => {
            const resultId = `result_${++this._resultIdCounter}`;
            const resultIndex = currentResults.indexOf(rs);
            if (resultIndex === -1) return;

            this._pinnedResults.set(resultId, {
                sourceUri,
                resultSetIndex: resultIndex,
                timestamp: Date.now(),
                label: rs.isLog ? `${filename} - Logs` : `${filename} - Result ${resultIndex}`
            });
            this._autoPinnedResults.add(resultId);
        });

        if (!this._activeSourceUri || this._activeSourceUri === sourceUri) {
            this._activeSourceUri = sourceUri;
        }
        const lastNewResultIndex = newResultSets.length > 0
            ? currentResults.indexOf(newResultSets[newResultSets.length - 1])
            : currentResults.length - 1;
        if (lastNewResultIndex >= 0) {
            this._activeResultSetIndexMap.set(sourceUri, lastNewResultIndex);
        }

        for (const rs of newResultSets) {
            if (rs.isLog || rs.isError) {
                continue;
            }
            const resultIndex = currentResults.indexOf(rs);
            if (resultIndex < 0) {
                continue;
            }
            const rowCount = rs.totalRowCount ?? rs.data.length;
            if (this._shouldUseDiskBacking(rowCount, rs.data.length, rs.bufferedBytes ?? estimateRowsBytes(rs.data))) {
                const props = this.spillResultSetToDisk(
                    sourceUri,
                    rs,
                    resultIndex,
                    rowCount,
                    rs.limitReached === true,
                );
                if (props) {
                    this._onDidSpillToDisk.fire(props);
                }
            }
            this.touchResultSetAccess(sourceUri, resultIndex);
        }

        this._pruneResults(sourceUri);
        this._incrementDataVersion(sourceUri);
        this._onDidChangeState.fire();
    }

    private _pruneResults(sourceUri: string) {
        const results = this._resultsMap.get(sourceUri);
        if (!results) return;

        const maxDataResults = this.getMaxDataResults();

        // Extract data results with their original indices
        const dataResults = results
            .map((rs, index) => ({ rs, index }))
            .filter(item => !item.rs.isLog);

        const warningThreshold = Math.floor(maxDataResults * 0.8);
        if (dataResults.length >= warningThreshold && dataResults.length <= maxDataResults) {
            getLogger().warn(
                `Approaching result limit: ${dataResults.length}/${maxDataResults} results for ${sourceUri}. ` +
                `Older unpinned results will be pruned when limit is exceeded.`
            );
        }

        if (dataResults.length <= maxDataResults) {
            return;
        }

        // Determine which ones are pinned (manually or auto)
        // Auto-pinned results are treated as unpinned for pruning purposes
        const unpinnedDataResults = dataResults
            .filter(item => {
                const pinEntry = Array.from(this._pinnedResults.entries()).find(
                    ([_, info]) => info.sourceUri === sourceUri && info.resultSetIndex === item.index
                );
                // Consider as unpinned if not pinned OR if auto-pinned
                const isPinned = pinEntry && !this._autoPinnedResults.has(pinEntry[0]);
                return !isPinned;
            })
            // Sort by execution timestamp (oldest first)
            .sort((a, b) => (a.rs.executionTimestamp || 0) - (b.rs.executionTimestamp || 0));

        const toRemoveCount = dataResults.length - maxDataResults;
        const toRemoveIndices = unpinnedDataResults.slice(0, toRemoveCount).map(item => item.index);

        if (toRemoveIndices.length === 0) return;

        // Log when results are being pruned
        getLogger().info(
            `Pruning ${toRemoveIndices.length} result(s) for ${sourceUri} ` +
            `(limit: ${maxDataResults}, current: ${dataResults.length})`
        );

        // Show warning to user about pruned results (only once per execution)
        if (!this._limitWarningShown.has(sourceUri)) {
            this._limitWarningShown.add(sourceUri);
            const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
            vscode.window.showWarningMessage(
                `Result limit (${maxDataResults}) reached for "${filename}". ` +
                `${toRemoveIndices.length} ${toRemoveIndices.length === 1 ? 'unpinned result was' : 'unpinned results were'} removed. ` +
                `Pin important results or increase the limit in settings.`,
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'netezza.results.maxDataResults');
                }
            });
        }

        // Sort indices descending to splice without affecting subsequent indices in the same loop
        toRemoveIndices.sort((a, b) => b - a);

        for (const index of toRemoveIndices) {
            const rs = results[index];
            if (rs) {
                this._releaseResultSetResources(rs);
            }
            results.splice(index, 1);

            // Update pins for this source
            const pins = Array.from(this._pinnedResults.entries()).filter(([_, info]) => info.sourceUri === sourceUri);
            for (const [id, info] of pins) {
                if (info.resultSetIndex === index) {
                    this._pinnedResults.delete(id);
                    this._autoPinnedResults.delete(id);
                } else if (info.resultSetIndex > index) {
                    info.resultSetIndex--;
                }
            }

            // Update active index if it was affected
            const activeIndex = this._activeResultSetIndexMap.get(sourceUri);
            if (activeIndex !== undefined) {
                if (activeIndex === index) {
                    this._activeResultSetIndexMap.set(sourceUri, Math.max(0, index - 1));
                } else if (activeIndex > index) {
                    this._activeResultSetIndexMap.set(sourceUri, activeIndex - 1);
                }
            }
        }
    }

    private _incrementDataVersion(sourceUri: string) {
        const current = this._dataVersions.get(sourceUri) || 0;
        this._dataVersions.set(sourceUri, current + 1);
        if (!this._activeSourceUri || this._activeSourceUri === sourceUri) {
            this._globalStateVersion++;
        }
    }

    private _shouldUseDiskBacking(
        totalRowsSoFar: number,
        bufferedRowCount?: number,
        bufferedBytes?: number,
    ): boolean {
        const settings = getDiskBackedResultsSettings();
        if (!isDiskBackedResultsAvailable(settings)) {
            return false;
        }
        const threshold = getEffectiveSpillThreshold(settings);
        const effectiveCount = bufferedRowCount !== undefined
            ? Math.max(totalRowsSoFar, bufferedRowCount)
            : totalRowsSoFar;
        return effectiveCount >= threshold
            || (bufferedBytes ?? 0) >= (settings.memoryByteThreshold ?? Number.POSITIVE_INFINITY);
    }

    /**
     * Force-spill a result set to SQLite regardless of the spill threshold.
     * Delegates to spillResultSetToDisk with force=true.
     */
    public spillResultSetToDiskForced(
        sourceUri: string,
        targetResultSet: ResultSet,
        resultSetIndex: number,
        limitReached: boolean,
    ): DiskBackedActivateProps | null {
        const totalRows = targetResultSet.data.length;
        return this.spillResultSetToDisk(
            sourceUri,
            targetResultSet,
            resultSetIndex,
            totalRows,
            limitReached,
            true,
        );
    }

    public spillResultSetToDisk(
        sourceUri: string,
        targetResultSet: ResultSet,
        resultSetIndex: number,
        totalRowsSoFar: number,
        limitReached: boolean,
        force = false,
    ): DiskBackedActivateProps | null {
        if (targetResultSet.storageMode === 'sqlite' || targetResultSet.isLog) {
            return null;
        }
        if (!force && !this._shouldUseDiskBacking(
            totalRowsSoFar,
            targetResultSet.data.length,
            targetResultSet.bufferedBytes,
        )) {
            return null;
        }

        const settings = getDiskBackedResultsSettings();
        const rowsToSpill = targetResultSet.data;
        let store: SqliteResultStore | null = null;

        try {
            store = SqliteResultStore.create(targetResultSet.columns, settings.insertBatchSize);
            const batchSize = settings.insertBatchSize;
            for (let offset = 0; offset < rowsToSpill.length; offset += batchSize) {
                const batch = rowsToSpill.slice(offset, offset + batchSize);
                store.insertRows(batch);
            }

            diskBackedStoreRegistry.register(store);
            tempFileRegistry.register(store.id, store.dbPath);
            if (force) {
                store.finalizeBulkInsert();
            }

            targetResultSet.storageMode = 'sqlite';
            targetResultSet.diskStoreId = store.id;
            targetResultSet.totalRowCount = totalRowsSoFar;
            targetResultSet.data = [];
            targetResultSet.bufferedBytes = 0;
            targetResultSet.isEditable = false;

            this._incrementDataVersion(sourceUri);

            const firstPage = store.getRows({ offset: 0, limit: DISK_BACKED_FIRST_PAGE_SIZE });
            getLogger().info(
                `Disk-backed results activated${force ? ' (forced)' : ''} for ${sourceUri} result ${resultSetIndex}: ${totalRowsSoFar} rows`
            );

            return {
                command: 'diskBackedActivate',
                sourceUri,
                resultSetIndex,
                totalRows: totalRowsSoFar,
                columns: targetResultSet.columns,
                firstPageRows: firstPage,
                limitReached,
            };
        } catch (error) {
            store?.dispose();
            getLogger().error(
                `Failed to migrate result set to SQLite; continuing in memory: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            return null;
        }
    }

    private _tryMigrateResultSetToDisk(
        sourceUri: string,
        targetResultSet: ResultSet,
        resultSetIndex: number,
        totalRowsSoFar: number,
        limitReached: boolean,
    ): AppendStreamingResult | null {
        const props = this.spillResultSetToDisk(
            sourceUri,
            targetResultSet,
            resultSetIndex,
            totalRowsSoFar,
            limitReached,
        );
        if (!props) {
            return null;
        }

        return {
            type: 'diskBackedActivate',
            props,
        };
    }

    private _disposeDiskStoreForResultSet(rs: ResultSet): void {
        if (!rs.diskStoreId) {
            return;
        }
        diskBackedStoreRegistry.dispose(rs.diskStoreId);
        tempFileRegistry.unregister(rs.diskStoreId);
        rs.diskStoreId = undefined;
        rs.storageMode = 'memory';
        rs.totalRowCount = undefined;
    }

    private _releaseResultSetResources(rs: ResultSet): void {
        this._disposeDiskStoreForResultSet(rs);
        rs.data = [];
    }

    public getDiskBackedRows(storeId: string, offset: number, limit: number): unknown[][] {
        return diskBackedStoreRegistry.get(storeId)?.getRows({ offset, limit }) ?? [];
    }

    public queryDiskBackedRows(
        storeId: string,
        spec: DiskQuerySpec | undefined,
        offset: number,
        limit: number,
    ): unknown[][] {
        return queryDiskBackedRows(storeId, spec, { offset, limit }) ?? [];
    }

    public countDiskBackedRows(storeId: string, spec: DiskQuerySpec | undefined): number {
        return countDiskBackedRows(storeId, spec) ?? 0;
    }

    public distinctDiskBackedValues(
        storeId: string,
        spec: DiskQuerySpec | undefined,
        columnIndex: number,
        limit: number,
    ): { values: Array<{ raw: unknown; count: number }>; truncated: boolean } {
        return distinctDiskBackedValues(storeId, spec, columnIndex, limit) ?? { values: [], truncated: false };
    }

    public aggregateDiskBackedRows(
        storeId: string,
        spec: DiskQuerySpec | undefined,
        requests: DiskAggregationRequest[],
    ): DiskAggregationResult[] {
        return aggregateDiskBackedRows(storeId, spec, requests) ?? [];
    }

    public queryDiskBackedGroups(
        storeId: string,
        spec: DiskQuerySpec | undefined,
        grouping: DiskGroupLevel[],
        path: DiskGroupPathItem[],
        offset: number,
        limit: number,
        aggregations: DiskAggregationRequest[] = [],
    ): DiskGroupQueryResult {
        return queryDiskBackedGroups(
            storeId,
            spec,
            grouping,
            path,
            { offset, limit },
            aggregations,
        ) ?? {
            kind: path.length >= grouping.length ? 'leafRows' : 'groups',
            path,
            depth: path.length,
            totalCount: 0,
            groups: [],
            rows: [],
            aggregations: [],
        };
    }

    public disposeAllDiskStores(): void {
        diskBackedStoreRegistry.disposeAll();
        tempFileRegistry.disposeAll();
    }

    public appendStreamingChunk(
        sourceUri: string,
        chunk: OneChunk,
        sql: string,
        refreshSql?: string,
    ): AppendStreamingResult {
        if (this._cancelledSources.has(sourceUri)) {
            return { type: 'ignore' };
        }

        const existingResults = this._resultsMap.get(sourceUri) || [];

        if (chunk.isFirstChunk && chunk.columns.length > 0) {
            const directSql = refreshSql ?? sql;
            const editSource = directSql ? detectEditSource(directSql) : null;
            const isEditable = editSource !== null;
            const newResultSet: ResultSet = {
                columns: chunk.columns,
                data: chunk.rows,
                executionTimestamp: Date.now(),
                sql,
                refreshSql: refreshSql ?? sql,
                limitReached: chunk.limitReached,
                isCancelled: chunk.isCancelled,
                bufferedBytes: estimateRowsBytes(chunk.rows),
                isEditable,
                editSource: editSource ?? undefined,
            };

            existingResults.push(newResultSet);
            this._resultsMap.set(sourceUri, existingResults);

            const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
            const resultId = `result_${++this._resultIdCounter}`;
            const resultSetIndex = existingResults.length - 1;
            this._pinnedResults.set(resultId, {
                sourceUri,
                resultSetIndex,
                timestamp: Date.now(),
                label: `${filename} - Result ${resultSetIndex}`
            });
            this._autoPinnedResults.add(resultId);

            if (!this._activeSourceUri || this._activeSourceUri === sourceUri) {
                this._activeSourceUri = sourceUri;
            }
            // Show streaming data as it arrives — Logs remain available on tab 0
            this._activeResultSetIndexMap.set(sourceUri, resultSetIndex);

            this._incrementDataVersion(sourceUri);
            this._pruneResults(sourceUri);

            const migrateResult = this._tryMigrateResultSetToDisk(
                sourceUri,
                newResultSet,
                resultSetIndex,
                chunk.totalRowsSoFar,
                chunk.limitReached,
            );
            if (migrateResult) {
                return migrateResult;
            }

            return {
                type: 'incremental',
                props: {
                    command: 'appendRows',
                    resultSetIndex,
                    rows: chunk.rows,
                    totalRows: chunk.totalRowsSoFar,
                    isLastChunk: chunk.isLastChunk,
                    limitReached: newResultSet.limitReached === true,
                    isFirstChunk: true,
                    isEditable,
                    editSource: editSource ?? undefined,
                    columns: chunk.columns,
                    sql,
                    refreshSql: refreshSql ?? sql,
                    executionTimestamp: newResultSet.executionTimestamp,
                },
            };
        } else if (chunk.rows.length > 0) {
            const resultSetIndex = existingResults.length - 1;
            const targetResultSet = existingResults[resultSetIndex];
            if (targetResultSet && !targetResultSet.isLog) {
                if (targetResultSet.storageMode === 'sqlite' && targetResultSet.diskStoreId) {
                    const store = diskBackedStoreRegistry.get(targetResultSet.diskStoreId);
                    store?.insertRows(chunk.rows);
                    targetResultSet.totalRowCount = chunk.totalRowsSoFar;
                    targetResultSet.limitReached = targetResultSet.limitReached === true || chunk.limitReached === true;
                    targetResultSet.isCancelled = targetResultSet.isCancelled === true || chunk.isCancelled === true;
                    this._incrementDataVersion(sourceUri);

                    return {
                        type: 'rowCountUpdate',
                        props: {
                            command: 'rowCountUpdate',
                            sourceUri,
                            resultSetIndex,
                            totalRows: chunk.totalRowsSoFar,
                            limitReached: targetResultSet.limitReached === true,
                        },
                    };
                }

                targetResultSet.data.push(...chunk.rows);
                targetResultSet.bufferedBytes = (targetResultSet.bufferedBytes ?? 0) + estimateRowsBytes(chunk.rows);
                targetResultSet.limitReached = targetResultSet.limitReached === true || chunk.limitReached === true;
                targetResultSet.isCancelled = targetResultSet.isCancelled === true || chunk.isCancelled === true;

                const migrateResult = this._tryMigrateResultSetToDisk(
                    sourceUri,
                    targetResultSet,
                    resultSetIndex,
                    chunk.totalRowsSoFar,
                    targetResultSet.limitReached === true,
                );
                if (migrateResult) {
                    return migrateResult;
                }

                return {
                    type: 'incremental',
                    props: {
                        command: 'appendRows',
                        resultSetIndex,
                        rows: chunk.rows,
                        totalRows: chunk.totalRowsSoFar,
                        isLastChunk: chunk.isLastChunk,
                        limitReached: targetResultSet.limitReached === true
                    }
                };
            }
        }

        if (chunk.isLastChunk) {
            this._incrementDataVersion(sourceUri);
        }

        return { type: 'ignore' };
    }

    public togglePin(sourceUri: string) {
        if (this._pinnedSources.has(sourceUri)) {
            this._pinnedSources.delete(sourceUri);
        } else {
            this._pinnedSources.add(sourceUri);
        }
        this._globalStateVersion++;
        this._onDidChangeState.fire();
    }

    public toggleResultPin(sourceUri: string, resultSetIndex: number) {
        const existingPinEntry = Array.from(this._pinnedResults.entries()).find(
            ([_, info]) => info.sourceUri === sourceUri && info.resultSetIndex === resultSetIndex
        );

        if (existingPinEntry) {
            // Unpin
            this._pinnedResults.delete(existingPinEntry[0]);
            this._autoPinnedResults.delete(existingPinEntry[0]);
        } else {
            // Pin
            const maxPinnedDataResults = this.getMaxPinnedDataResults();
            const currentPinnedCount = Array.from(this._pinnedResults.entries()).filter(
                ([id, info]) => info.sourceUri === sourceUri && !this._autoPinnedResults.has(id)
            ).length;

            if (currentPinnedCount >= maxPinnedDataResults) {
                const error = `Maximum of ${maxPinnedDataResults} pinned results reached. ` +
                    `Unpin some results or increase the limit in settings (netezza.results.maxPinnedDataResults).`;
                getLogger().warn(error);
                throw new Error(error);
            }

            // Log warning when approaching pinned limit (80% threshold)
            const warningThreshold = Math.floor(maxPinnedDataResults * 0.8);
            if (currentPinnedCount >= warningThreshold) {
                getLogger().warn(
                    `Approaching pinned result limit: ${currentPinnedCount}/${maxPinnedDataResults} for ${sourceUri}. ` +
                    `Consider unpinning older results or increasing the limit in settings.`
                );
            }

            const resultId = `result_${++this._resultIdCounter}`;
            const timestamp = Date.now();
            const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
            const label = `${filename} - Result ${resultSetIndex + 1}`;

            this._pinnedResults.set(resultId, {
                sourceUri,
                resultSetIndex,
                timestamp,
                label
            });
        }
        this._globalStateVersion++;
        this._onDidChangeState.fire();
    }

    public switchToPinnedResult(resultId: string) {
        const pinnedResult = this._pinnedResults.get(resultId);
        if (pinnedResult) {
            this._activeSourceUri = pinnedResult.sourceUri;
            this._activeResultSetIndexMap.set(pinnedResult.sourceUri, pinnedResult.resultSetIndex);
            this._onDidChangeState.fire();
            return pinnedResult.resultSetIndex;
        }
        return undefined;
    }

    public unpinResult(resultId: string) {
        this._pinnedResults.delete(resultId);
        this._autoPinnedResults.delete(resultId);
        this._globalStateVersion++;
        this._onDidChangeState.fire();
    }

    public addTextContentResult(sourceUri: string, content: string, name?: string): number {
        const existingResults = this._resultsMap.get(sourceUri) || [];
        const newResult: ResultSet = {
            columns: [],
            data: [[content]],
            executionTimestamp: Date.now(),
            name: name || 'MD Export',
            isTextContent: true
        };
        existingResults.push(newResult);
        this._resultsMap.set(sourceUri, existingResults);

        const filename = sourceUri.split(/[\\/]/).pop() || sourceUri;
        const resultId = `result_${++this._resultIdCounter}`;
        const resultSetIndex = existingResults.length - 1;
        this._pinnedResults.set(resultId, {
            sourceUri,
            resultSetIndex,
            timestamp: Date.now(),
            label: `${filename} - MD Export`
        });
        this._autoPinnedResults.add(resultId);
        this._activeResultSetIndexMap.set(sourceUri, resultSetIndex);
        this._activeSourceUri = sourceUri;
        this._incrementDataVersion(sourceUri);
        this._pruneResults(sourceUri);
        this._globalStateVersion++;
        this._onDidChangeState.fire();
        return resultSetIndex;
    }

    public closeSource(sourceUri: string) {
        const results = this._resultsMap.get(sourceUri);
        if (results) {
            for (const rs of results) {
                this._releaseResultSetResources(rs);
            }
        }

        if (this._resultsMap.has(sourceUri)) {
            this._resultsMap.delete(sourceUri);
            this._pinnedSources.delete(sourceUri);
            this._executingSources.delete(sourceUri);

            const pinnedResultsToRemove = Array.from(this._pinnedResults.entries())
                .filter(([_, info]) => info.sourceUri === sourceUri)
                .map(([id, _]) => id);
            pinnedResultsToRemove.forEach(id => {
                this._pinnedResults.delete(id);
                this._autoPinnedResults.delete(id);
            });

            if (this._activeSourceUri === sourceUri) {
                const remainingSources = Array.from(this._resultsMap.keys());
                this._activeSourceUri = remainingSources.length > 0 ? remainingSources[0] : undefined;
            }
            this._globalStateVersion++;
            this._onDidChangeState.fire();
        }
    }

    public closeResult(sourceUri: string, resultSetIndex: number) {
        const results = this._resultsMap.get(sourceUri);
        if (!results || resultSetIndex < 0 || resultSetIndex >= results.length) return;

        const rs = results[resultSetIndex];
        if (rs) {
            this._releaseResultSetResources(rs);
        }
        results.splice(resultSetIndex, 1);

        // Update pins
        const pins = Array.from(this._pinnedResults.entries()).filter(([_, info]) => info.sourceUri === sourceUri);
        for (const [id, info] of pins) {
            if (info.resultSetIndex === resultSetIndex) {
                this._pinnedResults.delete(id);
                this._autoPinnedResults.delete(id);
            } else if (info.resultSetIndex > resultSetIndex) {
                info.resultSetIndex--;
            }
        }

        // Update active index
        const activeIndex = this._activeResultSetIndexMap.get(sourceUri);
        if (activeIndex !== undefined) {
            if (activeIndex === resultSetIndex) {
                this._activeResultSetIndexMap.set(sourceUri, Math.max(0, resultSetIndex - 1));
            } else if (activeIndex > resultSetIndex) {
                this._activeResultSetIndexMap.set(sourceUri, activeIndex - 1);
            }
        }

        this._incrementDataVersion(sourceUri);
        this.markStale(sourceUri);
        this._globalStateVersion++;
        this._onDidChangeState.fire();
    }

    public closeAllResults(sourceUri: string) {
        const results = this._resultsMap.get(sourceUri);
        if (!results || results.length === 0) return;

        const logResult = results.find(r => r.isLog);

        results.forEach(r => {
            if (r !== logResult) {
                this._releaseResultSetResources(r);
            }
        });

        results.splice(0);
        if (logResult) {
            results.push(logResult);
        }

        // Remove all non-log pins for this source
        const pinsToKeep = Array.from(this._pinnedResults.entries()).filter(([_, info]) => {
            if (info.sourceUri !== sourceUri) return true;
            return info.resultSetIndex === 0 && results[0]?.isLog;
        });

        const allSourcePins = Array.from(this._pinnedResults.entries()).filter(([_, info]) => info.sourceUri === sourceUri);
        for (const [id] of allSourcePins) {
            if (!pinsToKeep.some(k => k[0] === id)) {
                this._pinnedResults.delete(id);
                this._autoPinnedResults.delete(id);
            }
        }

        this._activeResultSetIndexMap.set(sourceUri, 0);
        this._incrementDataVersion(sourceUri);
        this.markStale(sourceUri);
        this._globalStateVersion++;
        this._onDidChangeState.fire();
    }

    public clearLogs(sourceUri: string) {
        const results = this._resultsMap.get(sourceUri);
        if (results) {
            const logResultSet = results.find(r => r.isLog);
            if (logResultSet) {
                logResultSet.data = [];
                const timestamp = new Date().toLocaleTimeString();
                logResultSet.data.push([timestamp, '--- Logs Cleared ---']);
                this._incrementDataVersion(sourceUri);
                this.markStale(sourceUri);
                this._onDidChangeState.fire();
            }
        }
    }

    public setActiveResultSetIndex(sourceUri: string, index: number) {
        this._activeResultSetIndexMap.set(sourceUri, index);
    }
}
