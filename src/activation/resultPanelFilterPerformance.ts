/* istanbul ignore file -- this test-only command is exercised by the real Extension Host harness. */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { ResultSet } from '../types';
import type { ResultPanelView } from '../views/resultPanelView';
import { isResultPanelTraceEnabled } from '../views/resultPanelTrace';

const SCENARIO_ID = 'extension-host-result-panel-filter-performance';
const PERFORMANCE_ROW_COUNT = 4_000;
const PERFORMANCE_COLUMN_COUNT = 32;
const DEFAULT_TABLE_NAME = 'jbl_extension_host_filter_performance';
const SCENARIO_TIMEOUT_MS = 30_000;

export interface ExtensionHostFilterPerformanceMetric {
    name: string;
    expectedVisibleRows: number;
    actualVisibleRows: number;
    durationMs: number;
    filterApplyCount: number;
    filterApplyLatencyMs?: number;
    filterDebounceMs?: number;
    finalFilter: string;
}

export interface ExtensionHostFilterPerformanceReport {
    engine: 'sqlite';
    scenarioId: typeof SCENARIO_ID;
    status: 'passed' | 'failed';
    sourceUri: string;
    rowCount: number;
    columnCount: number;
    storageMode: string;
    metrics: ExtensionHostFilterPerformanceMetric[];
    durationMs: number;
    error?: string;
}

interface ExtensionHostFilterPerformanceOptions {
    sourceFilePath?: string;
    workDir?: string;
    sqliteDatabasePath?: string;
    tableName?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(description: string, predicate: () => boolean): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt >= SCENARIO_TIMEOUT_MS) {
            throw new Error(`Extension Host filter performance timed out waiting for ${description}.`);
        }
        await sleep(25);
    }
}

function fingerprint(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function quoteIdentifier(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(value)) {
        throw new Error('Extension Host filter performance table identifier is invalid.');
    }
    return `"${value}"`;
}

function performanceColumns(): string[] {
    return [
        'id',
        ...Array.from(
            { length: PERFORMANCE_COLUMN_COUNT - 1 },
            (_unused, index) => `c${String(index + 1).padStart(2, '0')}`,
        ),
    ];
}

function buildPerformanceSql(tableName: string): string {
    const columns = performanceColumns().map(quoteIdentifier).join(', ');
    return `SELECT ${columns} FROM ${quoteIdentifier(tableName)} ORDER BY ${quoteIdentifier('id')}`;
}

function writeReport(report: ExtensionHostFilterPerformanceReport): void {
    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    if (!reportPath) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function resultSetForSource(provider: ResultPanelView, sourceUri: string): {
    resultSets: ResultSet[];
    resultSetIndex: number;
    resultSet: ResultSet;
} | undefined {
    const resultSets = provider.getResultsForSource(sourceUri) ?? [];
    const resultSetIndex = resultSets.findIndex(resultSet => !resultSet.isLog && !resultSet.isError);
    const resultSet = resultSetIndex >= 0 ? resultSets[resultSetIndex] : undefined;
    return resultSet ? { resultSets, resultSetIndex, resultSet } : undefined;
}

async function openPerformanceSql(filePath: string, sql: string): Promise<vscode.TextDocument> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${sql}\n`, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
}

async function executePerformanceQuery(
    provider: ResultPanelView,
    document: vscode.TextDocument,
): Promise<{ sourceUri: string; resultSet: ResultSet; resultSetIndex: number }> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
        throw new Error('The Extension Host filter performance test lost its active SQL editor.');
    }
    editor.selection = new vscode.Selection(
        new vscode.Position(0, 0),
        document.positionAt(document.getText().length),
    );
    await vscode.commands.executeCommand('netezza.runQuery');

    const sourceUri = document.uri.toString();
    await waitFor('the 4,000-row production result', () => {
        const state = resultSetForSource(provider, sourceUri);
        return !provider.getExecutingSources().includes(sourceUri)
            && state !== undefined
            && (state.resultSet.totalRowCount ?? state.resultSet.data.length) === PERFORMANCE_ROW_COUNT;
    });

    const state = resultSetForSource(provider, sourceUri);
    if (!state) throw new Error('The production query did not create a tabular result.');
    return { sourceUri, resultSet: state.resultSet, resultSetIndex: state.resultSetIndex };
}

function toFilterMetric(
    name: string,
    result: Record<string, unknown>,
    expectedVisibleRows: number,
): ExtensionHostFilterPerformanceMetric {
    const applyLatency = result.filterApplyLatencyMs;
    return {
        name,
        expectedVisibleRows,
        actualVisibleRows: asNumber(result.visibleRowCount, -1),
        durationMs: asNumber(result.durationMs, -1),
        filterApplyCount: asNumber(result.filterApplyCount, -1),
        ...(typeof applyLatency === 'number' && Number.isFinite(applyLatency)
            ? { filterApplyLatencyMs: applyLatency }
            : {}),
        ...(typeof result.filterDebounceMs === 'number' && Number.isFinite(result.filterDebounceMs)
            ? { filterDebounceMs: result.filterDebounceMs }
            : {}),
        finalFilter: asString(result.filterValue),
    };
}

function assertMetric(
    metric: ExtensionHostFilterPerformanceMetric,
    expectedFilter: string,
): void {
    if (metric.actualVisibleRows !== metric.expectedVisibleRows) {
        throw new Error(`${metric.name} returned ${metric.actualVisibleRows} rows instead of ${metric.expectedVisibleRows}.`);
    }
    if (metric.filterApplyCount !== 1) {
        throw new Error(`${metric.name} applied the filter ${metric.filterApplyCount} times instead of once.`);
    }
    if (metric.finalFilter !== expectedFilter) {
        throw new Error(`${metric.name} finished with an unexpected filter value.`);
    }
    if (metric.filterDebounceMs !== 200) {
        throw new Error(`${metric.name} reported a ${metric.filterDebounceMs} ms debounce instead of 200 ms.`);
    }
    if (metric.filterApplyLatencyMs === undefined || metric.filterApplyLatencyMs < 180) {
        throw new Error(`${metric.name} applied before the 200 ms quiet period elapsed.`);
    }
}

export async function runExtensionHostFilterPerformance(
    context: vscode.ExtensionContext,
    provider: ResultPanelView,
    connectionManager: ConnectionManager,
    options: ExtensionHostFilterPerformanceOptions,
): Promise<ExtensionHostFilterPerformanceReport> {
    if (process.env.NODE_ENV !== 'test' || !isResultPanelTraceEnabled()) {
        throw new Error('The Extension Host filter performance test requires NODE_ENV=test and result-panel tracing.');
    }

    const startedAt = Date.now();
    const databasePath = options.sqliteDatabasePath || process.env.JUSTYBASE_EXTENSION_HOST_DATABASE_PATH;
    if (!databasePath) throw new Error('SQLite Extension Host filter performance database path is missing.');
    const workDir = options.workDir
        || process.env.JUSTYBASE_EXTENSION_HOST_WORK_DIR
        || context.storageUri?.fsPath
        || path.join(os.tmpdir(), 'justybase-extension-host-filter-performance');
    const tableName = options.tableName
        || process.env.JUSTYBASE_EXTENSION_HOST_TABLE
        || DEFAULT_TABLE_NAME;
    const sourceFilePath = options.sourceFilePath
        || process.env.JUSTYBASE_EXTENSION_HOST_SOURCE_FILE
        || path.join(workDir, 'filter-performance.sql');
    const connectionName = 'extension-host-filter-performance-sqlite';
    const documentUris: string[] = [];
    let sourceUri = '';
    let rowCount = 0;
    let columnCount = 0;
    let storageMode = 'unknown';
    const metrics: ExtensionHostFilterPerformanceMetric[] = [];

    try {
        await connectionManager.saveConnection({
            name: connectionName,
            host: '',
            port: 0,
            user: '',
            password: '',
            database: databasePath,
            dbType: 'sqlite',
        });
        await provider.ensureResultPanelTestBridgeReady();

        const document = await openPerformanceSql(sourceFilePath, buildPerformanceSql(tableName));
        sourceUri = document.uri.toString();
        documentUris.push(sourceUri);
        await connectionManager.setDocumentConnection(sourceUri, connectionName);

        const execution = await executePerformanceQuery(provider, document);
        rowCount = execution.resultSet.totalRowCount ?? execution.resultSet.data.length;
        columnCount = execution.resultSet.columns.length;
        storageMode = execution.resultSet.storageMode ?? 'memory';
        if (rowCount !== PERFORMANCE_ROW_COUNT || columnCount !== PERFORMANCE_COLUMN_COUNT) {
            throw new Error(`Performance fixture returned ${rowCount} x ${columnCount} instead of ${PERFORMANCE_ROW_COUNT} x ${PERFORMANCE_COLUMN_COUNT}.`);
        }
        if (storageMode !== 'memory') {
            throw new Error(`Performance fixture unexpectedly used ${storageMode} storage.`);
        }

        await provider.runResultPanelTestBridge('switchResultSet', {
            resultSetIndex: execution.resultSetIndex,
        });

        const cold = toFilterMetric(
            '4000x32/cold-inline',
            asRecord(await provider.runResultPanelTestBridge('setGlobalFilter', {
                value: 'needle-absent',
                expectedVisibleRowCount: 0,
            })),
            0,
        );
        assertMetric(cold, 'needle-absent');
        metrics.push(cold);

        const warm = toFilterMetric(
            '4000x32/warm-inline',
            asRecord(await provider.runResultPanelTestBridge('setGlobalFilter', {
                value: 'needle-middle',
                expectedVisibleRowCount: 1,
            })),
            1,
        );
        assertMetric(warm, 'needle-middle');
        metrics.push(warm);

        const rapid = toFilterMetric(
            '4000x32/rapid-typing',
            asRecord(await provider.runResultPanelTestBridge('setGlobalFilterBurst', {
                values: ['n', 'ne', 'needle-', 'needle-middle'],
                intervalMs: 50,
                expectedVisibleRowCount: 1,
            })),
            1,
        );
        assertMetric(rapid, 'needle-middle');
        metrics.push(rapid);

        const cleared = toFilterMetric(
            '4000x32/clear-after-typing',
            asRecord(await provider.runResultPanelTestBridge('clearGlobalFilter', {
                expectedVisibleRowCount: PERFORMANCE_ROW_COUNT,
            })),
            PERFORMANCE_ROW_COUNT,
        );
        assertMetric(cleared, '');
        metrics.push(cleared);

        const report: ExtensionHostFilterPerformanceReport = {
            engine: 'sqlite',
            scenarioId: SCENARIO_ID,
            status: 'passed',
            sourceUri: fingerprint(sourceUri),
            rowCount,
            columnCount,
            storageMode,
            metrics,
            durationMs: Date.now() - startedAt,
        };
        writeReport(report);
        return report;
    } catch (error: unknown) {
        const report: ExtensionHostFilterPerformanceReport = {
            engine: 'sqlite',
            scenarioId: SCENARIO_ID,
            status: 'failed',
            sourceUri: sourceUri ? fingerprint(sourceUri) : 'unavailable',
            rowCount,
            columnCount,
            storageMode,
            metrics,
            durationMs: Date.now() - startedAt,
            error: 'filter_performance_failed',
        };
        writeReport(report);
        throw error;
    } finally {
        for (const documentUri of documentUris) {
            await connectionManager.clearDocumentConnection(documentUri).catch(() => undefined);
        }
        await connectionManager.deleteConnection(connectionName).catch(() => undefined);
    }
}
