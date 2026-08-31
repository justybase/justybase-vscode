import * as fs from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { runQueryRaw } from '../core/queryRunner';
import type { ConnectionManager } from '../core/connectionManager';
import type { ResultPanelView } from '../views/resultPanelView';
import { NEW_SQL_TAB_WITH_CONTEXT_COMMAND } from '../commands/newSqlTabCommand';
import {
    clearResultPanelTrace,
    isResultPanelTraceEnabled,
    traceResultPanelEvent,
    type ResultPanelTraceRecord,
} from '../views/resultPanelTrace';

interface ResultPanelRegressionCommandArgs {
    sourceUri?: string;
    mode?: 'synthetic' | 'cold-editor-command';
}

export interface ExtensionHostScenarioReport {
    engine: 'sqlite' | 'netezza';
    scenarioId: string;
    status: 'passed' | 'failed';
    sourceUri: string;
    resultSetCount: number;
    rowCounts: number[];
    webviewPhases: string[];
    hostRequests: string[];
    hostResponses: string[];
    pendingRequestCount: number;
    untitledLanguageLifecyclePassed: boolean;
    durationMs: number;
    error?: string;
}

interface ExtensionHostScenarioOptions {
    engine?: 'sqlite' | 'netezza';
    sourceFilePath?: string;
    workDir?: string;
    sqliteDatabasePath?: string;
    tableName?: string;
    schemaName?: string;
}

const SCENARIO_ID = 'extension-host-result-panel-sqlite-netezza';
const SCENARIO_TIMEOUT_MS = 30_000;

function fingerprint(value: string): string {
    return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function sourceFingerprint(sourceUri: string): string {
    return sourceUri ? fingerprint(sourceUri) : 'unavailable';
}

function quoteIdentifier(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
        throw new Error('Extension Host fixture identifier is invalid.');
    }
    return `"${value}"`;
}

function buildFixtureTableReference(tableName: string, schemaName?: string): string {
    return schemaName ? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
}

function buildFixtureSelect(tableName: string, schemaName?: string, where?: string): string {
    const table = buildFixtureTableReference(tableName, schemaName);
    const columns = [
        'id', 'group_a', 'group_b', 'amount', 'status', 'created_at',
        'unicode_text', 'quoted_text', 'empty_text', 'binary_text',
    ].map(quoteIdentifier).join(', ');
    return `SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${quoteIdentifier('id')} LIMIT 1000`;
}

/**
 * Deliberately wide and long deterministic result used by the Extension Host
 * viewport contract. A cross join keeps the fixture small while producing
 * enough rows to exercise virtualization and scroll restoration.
 */
function buildFixtureScrollSelect(tableName: string, schemaName?: string): string {
    const table = buildFixtureTableReference(tableName, schemaName);
    return `SELECT a.${quoteIdentifier('id')} * 100 + b.${quoteIdentifier('id')} AS ${quoteIdentifier('scroll_id')}, `
        + `a.${quoteIdentifier('group_a')}, a.${quoteIdentifier('group_b')}, a.${quoteIdentifier('amount')}, `
        + `a.${quoteIdentifier('status')}, a.${quoteIdentifier('created_at')}, a.${quoteIdentifier('unicode_text')}, `
        + `a.${quoteIdentifier('quoted_text')}, a.${quoteIdentifier('empty_text')}, a.${quoteIdentifier('binary_text')} `
        + `FROM ${table} a CROSS JOIN ${table} b `
        + `ORDER BY a.${quoteIdentifier('id')}, b.${quoteIdentifier('id')} LIMIT 1000`;
}

function buildScenarioSql(tableName: string, schemaName?: string): {
    all: string;
    beta: string;
    scroll: string;
    empty: string;
    update: string;
    retry: string;
} {
    const table = buildFixtureTableReference(tableName, schemaName);
    return {
        all: buildFixtureSelect(tableName, schemaName),
        beta: buildFixtureSelect(tableName, schemaName, `${quoteIdentifier('group_a')} = 'Beta'`),
        scroll: buildFixtureScrollSelect(tableName, schemaName),
        empty: buildFixtureSelect(tableName, schemaName, '1 = 0'),
        update: `UPDATE ${table} SET ${quoteIdentifier('amount')} = 11.5 WHERE ${quoteIdentifier('id')} = 1`,
        retry: `SELECT ${quoteIdentifier('id')} FROM ${table} WHERE ${quoteIdentifier('id')} = 1`,
    };
}

const NETEZZA_FIXTURE_ROWS: readonly (readonly (string | number | null)[])[] = [
    [1, 'Alpha', 'X', 10.5, 'open', '2024-01-01 08:00:00', 'Łódź', "O'Brien, alpha", '', '00FF'],
    [2, 'Alpha', 'X', 0, 'closed', '2024-01-02 09:15:00', '東京', 'comma, value', 'filled', '0102'],
    [3, 'Alpha', 'Y', null, 'open', '2024-01-03 10:30:00', '🙂', 'empty amount', '', '0304'],
    [4, 'Alpha', 'Y', 25.75, 'pending', '2024-01-04 11:45:00', 'Łódź', "O'Brien, alpha", 'filled', '0506'],
    [5, 'Beta', 'X', 100, 'open', '2024-01-05 12:00:00', '東京', 'comma, value', '', '0708'],
    [6, 'Beta', 'X', 10, 'closed', '2024-01-06 13:15:00', '🙂', 'empty amount', 'filled', '090A'],
    [7, 'Beta', 'Y', null, 'open', '2024-01-07 14:30:00', 'Łódź', "O'Brien, beta", '', '0B0C'],
    [8, 'Beta', 'Y', 0, 'pending', '2024-01-08 15:45:00', '東京', 'comma, value', 'filled', '0D0E'],
    [9, 'Gamma', 'X', 1.25, 'open', '2024-01-09 16:00:00', '🙂', 'empty amount', '', '0F10'],
    [10, 'Gamma', 'X', 5, 'closed', '2024-01-10 17:15:00', 'Łódź', "O'Brien, gamma", 'filled', '1112'],
    [11, 'Gamma', 'Y', null, 'open', '2024-01-11 18:30:00', '東京', 'comma, value', '', '1314'],
    [12, 'Gamma', 'Y', 50, 'pending', '2024-01-12 19:45:00', '🙂', "O'Brien, gamma", 'filled', '1516'],
];

function quoteSqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function buildNetezzaFixtureCreateSql(tableName: string, schemaName?: string): string {
    const table = buildFixtureTableReference(tableName, schemaName);
    return `CREATE TABLE ${table} (
        ${quoteIdentifier('id')} INTEGER,
        ${quoteIdentifier('group_a')} VARCHAR(32),
        ${quoteIdentifier('group_b')} VARCHAR(32),
        ${quoteIdentifier('amount')} NUMERIC(12,2),
        ${quoteIdentifier('status')} VARCHAR(32),
        ${quoteIdentifier('created_at')} TIMESTAMP,
        ${quoteIdentifier('unicode_text')} NVARCHAR(128),
        ${quoteIdentifier('quoted_text')} VARCHAR(128),
        ${quoteIdentifier('empty_text')} VARCHAR(128),
        ${quoteIdentifier('binary_text')} VARCHAR(32)
    )`;
}

function buildNetezzaFixtureInsertSqls(tableName: string, schemaName?: string): string[] {
    const table = buildFixtureTableReference(tableName, schemaName);
    const columns = [
        'id', 'group_a', 'group_b', 'amount', 'status', 'created_at',
        'unicode_text', 'quoted_text', 'empty_text', 'binary_text',
    ].map(quoteIdentifier).join(', ');
    return NETEZZA_FIXTURE_ROWS.map(row => {
        const values = row.map((value, index) => {
            if (value === null) return 'NULL';
            if (index === 0) return String(value);
            if (index === 3) return Number(value).toFixed(2);
            if (index === 5) return `TIMESTAMP ${quoteSqlString(String(value))}`;
            return quoteSqlString(String(value));
        });
        return `INSERT INTO ${table} (${columns}) VALUES (${values.join(', ')})`;
    });
}

function buildNetezzaFixtureDropSql(tableName: string, schemaName?: string): string {
    return `DROP TABLE ${buildFixtureTableReference(tableName, schemaName)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function screenshotFileName(value: string): string {
    const normalized = value
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
    return normalized || 'screenshot';
}

/**
 * Ask the parent Extension Host runner to capture the current VS Code
 * renderer. The normal test gate never creates these files; the request/ack
 * handshake is enabled only for an explicit screenshot run.
 */
async function requestExtensionHostScreenshot(name: string): Promise<void> {
    if (process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOTS !== '1') {
        return;
    }

    const requestDirectory = process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOT_REQUEST_DIR;
    if (!requestDirectory) {
        throw new Error('Screenshot mode requires JUSTYBASE_EXTENSION_HOST_SCREENSHOT_REQUEST_DIR.');
    }

    fs.mkdirSync(requestDirectory, { recursive: true });
    const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const requestFileName = screenshotFileName(requestId);
    const requestPath = path.join(requestDirectory, `${requestFileName}.request.json`);
    const responsePath = path.join(requestDirectory, `${requestFileName}.response.json`);
    const request = { id: requestId, name: screenshotFileName(name) };
    fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, 'utf8');

    const configuredTimeout = Number.parseInt(
        process.env.JUSTYBASE_EXTENSION_HOST_SCREENSHOT_TIMEOUT_MS || '',
        10,
    );
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 30_000;
    const deadline = Date.now() + timeoutMs;
    try {
        while (Date.now() < deadline) {
            if (fs.existsSync(responsePath)) {
                const response = JSON.parse(fs.readFileSync(responsePath, 'utf8')) as {
                    ok?: boolean;
                    error?: string;
                };
                if (response.ok !== true) {
                    throw new Error(`Screenshot '${request.name}' failed: ${response.error || 'unknown error'}`);
                }
                return;
            }
            await sleep(50);
        }
        throw new Error(`Timed out waiting for screenshot '${request.name}'.`);
    } finally {
        fs.rmSync(requestPath, { force: true });
        fs.rmSync(responsePath, { force: true });
    }
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = SCENARIO_TIMEOUT_MS): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt >= timeoutMs) {
            throw new Error(`Extension Host scenario timed out waiting for ${description}.`);
        }
        await sleep(30);
    }
}

function traceNames(
    trace: readonly ResultPanelTraceRecord[],
    predicate: (event: ResultPanelTraceRecord) => boolean,
    selector: (event: ResultPanelTraceRecord) => string | undefined,
): string[] {
    return [...new Set(trace.filter(predicate).map(selector).filter((value): value is string => Boolean(value)))];
}

function writeReport(report: ExtensionHostScenarioReport): void {
    const reportPath = process.env.JUSTYBASE_EXTENSION_HOST_REPORT_PATH;
    if (!reportPath) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/**
 * Persist only the bounded trace fields intended for CI diagnostics. In
 * particular, do not copy `error` from a webview/driver message: provider
 * errors are not a stable contract and can contain SQL fragments or values.
 */
function writeTraceArtifact(provider: ResultPanelView): void {
    const tracePath = process.env.JUSTYBASE_EXTENSION_HOST_TRACE_PATH;
    if (!tracePath) return;

    const safeTrace = provider.getResultPanelTraceSnapshot().map(event => ({
        seq: event.seq,
        at: event.at,
        origin: event.origin,
        phase: event.phase,
        ...(event.sourceUri ? { sourceUri: sourceFingerprint(event.sourceUri) } : {}),
        ...(event.command ? { command: event.command } : {}),
        ...(event.resultSetIndex !== undefined ? { resultSetIndex: event.resultSetIndex } : {}),
        ...(event.resultSetCount !== undefined ? { resultSetCount: event.resultSetCount } : {}),
        ...(event.rowCount !== undefined ? { rowCount: event.rowCount } : {}),
        ...(event.totalRows !== undefined ? { totalRows: event.totalRows } : {}),
        ...(event.isLog !== undefined ? { isLog: event.isLog } : {}),
        ...(event.isFirstChunk !== undefined ? { isFirstChunk: event.isFirstChunk } : {}),
        ...(event.isLastChunk !== undefined ? { isLastChunk: event.isLastChunk } : {}),
        ...(event.visible !== undefined ? { visible: event.visible } : {}),
        ...(event.ready !== undefined ? { ready: event.ready } : {}),
        ...(event.viewportWidth !== undefined ? { viewportWidth: event.viewportWidth } : {}),
        ...(event.viewportHeight !== undefined ? { viewportHeight: event.viewportHeight } : {}),
        ...(event.scrollTop !== undefined ? { scrollTop: event.scrollTop } : {}),
        ...(event.scrollLeft !== undefined ? { scrollLeft: event.scrollLeft } : {}),
        ...(event.scrollAnchorIndex !== undefined ? { scrollAnchorIndex: event.scrollAnchorIndex } : {}),
        ...(event.firstVisibleRowIndex !== undefined ? { firstVisibleRowIndex: event.firstVisibleRowIndex } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.delivered !== undefined ? { delivered: event.delivered } : {}),
        ...(event.webviewSeq !== undefined ? { webviewSeq: event.webviewSeq } : {}),
    }));
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.writeFileSync(tracePath, `${JSON.stringify(safeTrace, null, 2)}\n`, 'utf8');
}

function buildReport(
    provider: ResultPanelView,
    engine: 'sqlite' | 'netezza',
    sourceUri: string,
    startedAt: number,
    status: 'passed' | 'failed',
    untitledLanguageLifecyclePassed: boolean,
): ExtensionHostScenarioReport {
    const trace = provider.getResultPanelTraceSnapshot();
    writeTraceArtifact(provider);
    const resultSets = sourceUri ? provider.getResultsForSource(sourceUri) ?? [] : [];
    const rowCounts = resultSets
        .filter(resultSet => !resultSet?.isLog)
        .map(resultSet => resultSet?.totalRowCount ?? resultSet?.data?.length ?? 0);
    const hostRequests = traceNames(
        trace,
        event => event.origin === 'host' && event.phase === 'webview_message',
        event => event.command,
    );
    const hostResponses = traceNames(
        trace,
        event => event.origin === 'host' && event.phase === 'host_post',
        event => event.command,
    );
    const webviewPhases = traceNames(
        trace,
        event => event.origin === 'webview',
        event => event.phase,
    );
    return {
        engine,
        scenarioId: SCENARIO_ID,
        status,
        sourceUri: sourceFingerprint(sourceUri),
        resultSetCount: resultSets.length,
        rowCounts,
        webviewPhases,
        hostRequests,
        hostResponses,
        pendingRequestCount: provider.getResultPanelTestBridgePendingRequestCount(),
        untitledLanguageLifecyclePassed,
        durationMs: Date.now() - startedAt,
        ...(status === 'failed' ? { error: 'scenario_failed' } : {}),
    };
}

async function runRawFixtureQuery(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    query: string,
    documentUri?: string,
): Promise<void> {
    await runQueryRaw({
        context,
        query,
        silent: true,
        connectionManager,
        connectionName,
        documentUri,
        isUserQuery: false,
        maxRows: 100_000,
    });
}

function resultHasTerminalResult(resultSets: ReturnType<ResultPanelView['getResultsForSource']>): boolean {
    return Boolean(resultSets?.some(resultSet => !resultSet?.isLog));
}

async function executeProductionQuery(
    provider: ResultPanelView,
    document: vscode.TextDocument,
    command = 'netezza.runQuery',
): Promise<Record<string, unknown>> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
        throw new Error('The Extension Host scenario lost its active SQL editor.');
    }
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), document.positionAt(document.getText().length));
    await vscode.commands.executeCommand(command);
    const sourceUri = document.uri.toString();
    await waitFor('production query completion', () =>
        !provider.getExecutingSources().includes(sourceUri)
        && resultHasTerminalResult(provider.getResultsForSource(sourceUri)),
    );
    return asRecord(await provider.runResultPanelTestBridge('snapshot'));
}

async function openUntitledSql(sql: string): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
    const initialEditor = vscode.window.activeTextEditor;
    if (!initialEditor || initialEditor.document.uri.scheme !== 'untitled') {
        throw new Error('VS Code did not create an active untitled SQL editor.');
    }

    // Reproduce the user path exactly: Ctrl+N creates a Plain Text document,
    // then changing its language to SQL emits close/open for the same
    // TextDocument identity before Ctrl+Enter executes the query.
    const document = await vscode.languages.setTextDocumentLanguage(initialEditor.document, 'sql');
    if (document.languageId !== 'sql') {
        throw new Error('VS Code did not change the untitled document language to SQL.');
    }
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const changed = await editor.edit(editBuilder => {
        editBuilder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            sql,
        );
    });
    if (!changed) {
        throw new Error('Could not populate the untitled Extension Host fixture editor.');
    }
    return document;
}

async function openInheritedUntitledSql(sql: string): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand(NEW_SQL_TAB_WITH_CONTEXT_COMMAND);
    const editor = vscode.window.activeTextEditor;
    if (
        !editor
        || editor.document.uri.scheme !== 'untitled'
        || editor.document.languageId !== 'sql'
    ) {
        throw new Error('Ctrl+N did not create an active untitled SQL editor.');
    }

    const document = editor.document;
    const changed = await editor.edit(editBuilder => {
        editBuilder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            sql,
        );
    });
    if (!changed) {
        throw new Error('Could not populate the inherited untitled SQL editor.');
    }
    return document;
}

function assertUntitledScalarResult(
    provider: ResultPanelView,
    document: vscode.TextDocument,
    expectedValue: number,
    snapshot: Record<string, unknown>,
): string {
    const sourceUri = document.uri.toString();
    const resultSets = provider.getResultsForSource(sourceUri) ?? [];
    const dataResult = resultSets.find(resultSet => !resultSet?.isLog && !resultSet?.isError);
    if (!dataResult) {
        throw new Error(`Untitled SELECT ${expectedValue} did not produce a tabular result.`);
    }
    if ((dataResult.totalRowCount ?? dataResult.data.length) !== 1 || dataResult.data.length !== 1) {
        throw new Error(`Untitled SELECT ${expectedValue} did not produce exactly one row.`);
    }
    if (String(dataResult.data[0]?.[0]) !== String(expectedValue)) {
        throw new Error(`Untitled SELECT ${expectedValue} returned an unexpected host value.`);
    }
    if (snapshot.sourceUri !== sourceUri || asNumber(snapshot.visibleRowCount, -1) !== 1) {
        throw new Error(`Untitled SELECT ${expectedValue} was not visible in its active webview grid.`);
    }
    const webviewResultSets = Array.isArray(snapshot.resultSets) ? snapshot.resultSets : [];
    if (webviewResultSets.some(resultSet => asRecord(resultSet).isError === true)) {
        throw new Error(`Untitled SELECT ${expectedValue} rendered an error result in the webview.`);
    }
    const firstCellFingerprint = typeof snapshot.firstCellFingerprint === 'string'
        ? snapshot.firstCellFingerprint
        : '';
    if (!firstCellFingerprint) {
        throw new Error(`Untitled SELECT ${expectedValue} did not render its first cell in the webview.`);
    }
    return firstCellFingerprint;
}

async function openSavedSql(filePath: string, sql: string): Promise<vscode.TextDocument> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, sql, 'utf8');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
}

async function runExtensionHostScenario(
    context: vscode.ExtensionContext,
    provider: ResultPanelView,
    connectionManager: ConnectionManager,
    options: ExtensionHostScenarioOptions,
): Promise<ExtensionHostScenarioReport> {
    if (process.env.NODE_ENV !== 'test' || !isResultPanelTraceEnabled()) {
        throw new Error('The Extension Host scenario requires NODE_ENV=test and result-panel tracing.');
    }

    const startedAt = Date.now();
    const engine = options.engine
        ?? (process.env.JUSTYBASE_EXTENSION_HOST_ENGINE === 'netezza' ? 'netezza' : 'sqlite');
    const workDir = options.workDir
        || process.env.JUSTYBASE_EXTENSION_HOST_WORK_DIR
        || context.storageUri?.fsPath
        || osTempFallback();
    const tableName = options.tableName || process.env.JUSTYBASE_EXTENSION_HOST_TABLE || 'jbl_extension_host_fixture';
    const schemaName = options.schemaName || process.env.JUSTYBASE_EXTENSION_HOST_SCHEMA || undefined;
    const sourceFilePath = options.sourceFilePath
        || process.env.JUSTYBASE_EXTENSION_HOST_SOURCE_FILE
        || path.join(workDir, 'fixture.sql');
    const connectionName = `extension-host-${engine}`;
    const documentUris: string[] = [];
    let netezzaFixtureCreated = false;
    let sourceUri = '';
    let untitledLanguageLifecyclePassed = false;

    try {
        if (engine === 'netezza') {
            const required = ['NZ_DEV_HOST', 'NZ_DEV_PORT', 'NZ_DEV_USER', 'NZ_DEV_PASSWORD', 'NZ_DEV_DATABASE'];
            const missing = required.filter(name => !process.env[name]);
            if (missing.length > 0) {
                throw new Error(`Netezza Extension Host test configuration is incomplete: ${missing.join(', ')}`);
            }
            await connectionManager.saveConnection({
                name: connectionName,
                host: process.env.NZ_DEV_HOST as string,
                port: Number(process.env.NZ_DEV_PORT),
                user: process.env.NZ_DEV_USER as string,
                password: process.env.NZ_DEV_PASSWORD as string,
                database: process.env.NZ_DEV_DATABASE as string,
                schema: schemaName,
                dbType: 'netezza',
            });
            await runRawFixtureQuery(
                context,
                connectionManager,
                connectionName,
                buildNetezzaFixtureCreateSql(tableName, schemaName),
            );
            netezzaFixtureCreated = true;
            for (const insertSql of buildNetezzaFixtureInsertSqls(tableName, schemaName)) {
                await runRawFixtureQuery(context, connectionManager, connectionName, insertSql);
            }
        } else {
            const databasePath = options.sqliteDatabasePath || process.env.JUSTYBASE_EXTENSION_HOST_DATABASE_PATH;
            if (!databasePath) throw new Error('SQLite Extension Host test database path is missing.');
            await connectionManager.saveConnection({
                name: connectionName,
                host: '',
                port: 0,
                user: '',
                password: '',
                database: databasePath,
                dbType: 'sqlite',
            });
        }

        const sql = buildScenarioSql(tableName, engine === 'netezza' ? schemaName : undefined);

        clearResultPanelTrace();
        await provider.ensureResultPanelTestBridgeReady();
        await requestExtensionHostScreenshot('01-result-panel-ready');

        const firstUntitled = await openUntitledSql('SELECT 10 AS RESULT_PANEL_LIFECYCLE_VALUE;');
        documentUris.push(firstUntitled.uri.toString());
        if (connectionManager.getConnectionForExecution(firstUntitled.uri.toString()) !== connectionName) {
            throw new Error('The first untitled SQL tab did not inherit the active connection.');
        }
        const firstUntitledSnapshot = await executeProductionQuery(provider, firstUntitled);
        const firstFingerprint = assertUntitledScalarResult(
            provider,
            firstUntitled,
            10,
            firstUntitledSnapshot,
        );

        const inheritedDatabase = await connectionManager.getEffectiveDatabase(
            firstUntitled.uri.toString(),
        );
        if (!inheritedDatabase) {
            throw new Error('The first untitled SQL tab has no effective database to inherit.');
        }
        await connectionManager.setDocumentDatabase(
            firstUntitled.uri.toString(),
            inheritedDatabase,
        );

        // Keep the first tab open while creating the second one. This is the
        // original regression: Ctrl+N must copy the source connection/database,
        // while Plain Text -> SQL must not retire the new document execution.
        const secondUntitled = await openInheritedUntitledSql(
            'SELECT 11 AS RESULT_PANEL_LIFECYCLE_VALUE;',
        );
        documentUris.push(secondUntitled.uri.toString());
        if (secondUntitled.uri.toString() === firstUntitled.uri.toString()) {
            throw new Error('The parallel untitled SQL tabs unexpectedly share one URI.');
        }
        if (connectionManager.getDocumentConnection(secondUntitled.uri.toString()) !== connectionName) {
            throw new Error('Ctrl+N did not assign the source connection to the new SQL tab.');
        }
        if (connectionManager.getDocumentDatabase(secondUntitled.uri.toString()) !== inheritedDatabase) {
            throw new Error('Ctrl+N did not assign the source database to the new SQL tab.');
        }
        const secondUntitledSnapshot = await executeProductionQuery(provider, secondUntitled);
        const secondFingerprint = assertUntitledScalarResult(
            provider,
            secondUntitled,
            11,
            secondUntitledSnapshot,
        );
        if (secondFingerprint === firstFingerprint) {
            throw new Error('The second untitled grid retained the first tab value.');
        }

        await vscode.window.showTextDocument(firstUntitled, { preview: false });
        const restoredFirstSnapshot = asRecord(await provider.runResultPanelTestBridge('switchSource', {
            sourceUri: firstUntitled.uri.toString(),
        }));
        if (
            asNumber(restoredFirstSnapshot.visibleRowCount, -1) !== 1
            || restoredFirstSnapshot.firstCellFingerprint !== firstFingerprint
        ) {
            throw new Error('Switching back to the first untitled tab did not restore SELECT 10.');
        }
        untitledLanguageLifecyclePassed = true;

        const savedDocument = await openSavedSql(sourceFilePath, `${sql.all};\n${sql.beta};\n`);
        documentUris.push(savedDocument.uri.toString());
        sourceUri = savedDocument.uri.toString();
        await connectionManager.setDocumentConnection(sourceUri, connectionName);

        await executeProductionQuery(provider, savedDocument);
        const savedResults = provider.getResultsForSource(sourceUri) ?? [];
        if (!savedResults[0]?.isLog) throw new Error('Logs must be the first result set.');
        const allResultIndex = savedResults.findIndex(resultSet => !resultSet.isLog && !resultSet.isError);
        if (allResultIndex < 0) throw new Error('The saved SQL did not produce a tabular result.');
        if (asNumber(savedResults[allResultIndex].totalRowCount, savedResults[allResultIndex].data.length) !== 12) {
            throw new Error('The deterministic saved-fixture query did not return 12 rows.');
        }

        await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: allResultIndex });
        await provider.runResultPanelTestBridge('diskMove');
        await provider.runResultPanelTestBridge('diskQuery');
        await requestExtensionHostScreenshot('02-result-grid');

        const filteredByUnicode = asRecord(await provider.runResultPanelTestBridge('setGlobalFilter', { value: 'Łódź' }));
        if (asNumber(filteredByUnicode.visibleRowCount, -1) !== 4) {
            throw new Error(`Global filter did not reduce the deterministic result to four rows (observed ${String(filteredByUnicode.visibleRowCount)}).`);
        }
        await requestExtensionHostScreenshot('03-global-filter');
        const clearedGlobal = asRecord(await provider.runResultPanelTestBridge('clearGlobalFilter'));
        if (asNumber(clearedGlobal.visibleRowCount, -1) !== 12) {
            throw new Error('Clearing the global filter did not restore all rows.');
        }

        const columnFiltered = asRecord(await provider.runResultPanelTestBridge('setColumnFilter', {
            columnIndex: 1,
            value: 'Beta',
        }));
        if (asNumber(columnFiltered.visibleRowCount, -1) !== 4) {
            throw new Error('Column filter did not reduce the deterministic result to four rows.');
        }
        await provider.runResultPanelTestBridge('setColumnFilter', { columnIndex: 1, value: '' });

        const distinct = asRecord(await provider.runResultPanelTestBridge('databaseFilterValues', { columnIndex: 1 }));
        if (asNumber(distinct.valueCount, 0) < 3) throw new Error('Database filter values did not return all groups.');
        const databaseAggregations = asRecord(await provider.runResultPanelTestBridge('databaseAggregations', {
            aggregations: [
                { columnIndex: 3, fn: 'sum' },
                { columnIndex: 3, fn: 'avg' },
                { columnIndex: 3, fn: 'min' },
                { columnIndex: 3, fn: 'max' },
                { columnIndex: 3, fn: 'count' },
            ],
        }));
        if (asNumber(databaseAggregations.count, 0) !== 5) throw new Error('Database aggregations returned an unexpected count.');

        const databaseFiltered = asRecord(await provider.runResultPanelTestBridge('applyDatabaseFilter', {
            querySpec: { columnFilters: [{ columnIndex: 1, values: ['Alpha'] }] },
        }));
        if (asNumber(databaseFiltered.visibleRowCount, -1) !== 4) throw new Error('Database filter apply returned an unexpected row count.');

        await provider.runResultPanelTestBridge('openGroupingPanel');
        await provider.runResultPanelTestBridge('configureGrouping', {
            columns: [1, 2],
            functions: [
                { fn: 'count' },
                { fn: 'sum', columnIndex: 3 },
                { fn: 'avg', columnIndex: 3 },
                { fn: 'min', columnIndex: 3 },
                { fn: 'max', columnIndex: 3 },
                { fn: 'countDistinct', columnIndex: 4 },
            ],
        });
        const grouping = asRecord(await provider.runResultPanelTestBridge('runGrouping'));
        if (asNumber(grouping.rowCount, 0) !== 2) throw new Error('Grouping did not return the two Alpha groups.');
        if (asNumber(grouping.columnCount, 0) < 3 || typeof grouping.sqlFingerprint !== 'string') {
            throw new Error('Grouping result metadata is incomplete.');
        }
        await requestExtensionHostScreenshot('04-grouping');

        await provider.runResultPanelTestBridge('refresh');
        await provider.runResultPanelTestBridge('applyDatabaseFilter', { querySpec: undefined });
        const exportTargets = [
            ['csv', path.join(workDir, 'result-filtered.csv')],
            ['json', path.join(workDir, 'result-filtered.json')],
            ['markdown', path.join(workDir, 'result-filtered.md')],
        ] as const;
        for (const [format, destination] of exportTargets) {
            await provider.runResultPanelTestBridge('export', { format, destination });
            await waitFor(`${format} export`, () => fs.existsSync(destination), 10_000);
            if (fs.statSync(destination).size === 0) throw new Error(`${format} export is empty.`);
        }

        const dmlDocument = await openUntitledSql(`${sql.update};`);
        documentUris.push(dmlDocument.uri.toString());
        await connectionManager.setDocumentConnection(dmlDocument.uri.toString(), connectionName);
        // The batch command is the production sequential path and preserves
        // rowsAffected for statements that do not return a tabular result.
        await executeProductionQuery(provider, dmlDocument, 'netezza.runQueryBatch');
        const dmlResults = provider.getResultsForSource(dmlDocument.uri.toString()) ?? [];
        if (!dmlResults.some(resultSet => resultSet?.rowsAffected === 1)) {
            throw new Error('DML result did not report one affected row.');
        }
        // Execute again on the same Untitled URI. This is the regression path
        // for reusing a cold `Untitled` tab after its first execution.
        await executeProductionQuery(provider, dmlDocument, 'netezza.runQueryBatch');

        const emptyDocument = await openUntitledSql(`${sql.empty};`);
        documentUris.push(emptyDocument.uri.toString());
        await connectionManager.setDocumentConnection(emptyDocument.uri.toString(), connectionName);
        const emptySnapshot = await executeProductionQuery(provider, emptyDocument);
        if (asNumber(emptySnapshot.resultSetCount, 0) < 2) throw new Error('Empty SELECT did not produce Logs and a result set.');

        const errorDocument = await openUntitledSql('SELECT * FROM "jbl_extension_host_missing_table";');
        documentUris.push(errorDocument.uri.toString());
        await connectionManager.setDocumentConnection(errorDocument.uri.toString(), connectionName);
        const errorSnapshot = await executeProductionQuery(provider, errorDocument, 'netezza.runQueryContinueOnError');
        if (asNumber(errorSnapshot.resultSetCount, 0) < 2) throw new Error('SQL error was not represented in result state.');
        const errorResultSets = Array.isArray(errorSnapshot.resultSets) ? errorSnapshot.resultSets : [];
        if (!errorResultSets.some(resultSet => asRecord(resultSet).isError === true)) {
            throw new Error('SQL error was not represented in the webview result state.');
        }
        await requestExtensionHostScreenshot('05-error-result');

        const secondSource = await openUntitledSql(`${sql.beta};`);
        documentUris.push(secondSource.uri.toString());
        await connectionManager.setDocumentConnection(secondSource.uri.toString(), connectionName);
        const secondSnapshot = await executeProductionQuery(provider, secondSource);
        if (asNumber(secondSnapshot.visibleRowCount, -1) !== 4) throw new Error('Second source did not return the Beta fixture rows.');

        // Real viewport contract: exercise a virtualized, wide result and
        // verify that both axes survive a Logs tab switch and a source switch.
        const scrollSource = await openUntitledSql(`${sql.scroll};`);
        documentUris.push(scrollSource.uri.toString());
        await connectionManager.setDocumentConnection(scrollSource.uri.toString(), connectionName);
        const scrollInitialSnapshot = await executeProductionQuery(provider, scrollSource);
        const scrollResultSets = provider.getResultsForSource(scrollSource.uri.toString()) ?? [];
        const scrollResultIndex = scrollResultSets.findIndex(resultSet => !resultSet.isLog && !resultSet.isError);
        if (scrollResultIndex < 0) throw new Error('Viewport fixture did not produce a tabular result.');
        const scrollRowCount = scrollResultSets[scrollResultIndex].totalRowCount
            ?? scrollResultSets[scrollResultIndex].data.length;
        if (scrollRowCount !== 144) throw new Error(`Viewport fixture returned ${scrollRowCount} rows instead of 144.`);
        if (asNumber(scrollInitialSnapshot.visibleRowCount, -1) !== 144) {
            throw new Error('Viewport fixture was not fully rendered in the active webview.');
        }

        await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: scrollResultIndex });
        const scrolledSnapshot = asRecord(await provider.runResultPanelTestBridge('scrollResult', {
            rowIndex: 75,
            scrollLeft: 320,
        }));
        const scrolledViewport = asRecord(scrolledSnapshot.viewport);
        const scrolledAnchor = asNumber(scrolledViewport.scrollAnchorIndex, -1);
        const scrolledTop = asNumber(scrolledViewport.scrollTop, 0);
        const scrolledLeft = asNumber(scrolledViewport.scrollLeft, 0);
        if (scrolledAnchor < 65 && scrolledTop <= 0) {
            throw new Error('Viewport fixture did not move to a non-zero virtualized row position.');
        }
        if (scrolledLeft <= 0) {
            throw new Error('Viewport fixture did not move to a non-zero horizontal position.');
        }

        await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: 0 });
        const restoredFromLogs = asRecord(await provider.runResultPanelTestBridge('switchResultSet', {
            resultSetIndex: scrollResultIndex,
        }));
        const restoredFromLogsViewport = asRecord(restoredFromLogs.viewport);
        const restoredFromLogsAnchor = asNumber(restoredFromLogsViewport.scrollAnchorIndex, -1);
        const restoredFromLogsTop = asNumber(restoredFromLogsViewport.scrollTop, 0);
        const restoredFromLogsLeft = asNumber(restoredFromLogsViewport.scrollLeft, 0);
        const anchorRestoredFromLogs = scrolledAnchor >= 0
            && restoredFromLogsAnchor >= scrolledAnchor - 5
            && restoredFromLogsAnchor <= scrolledAnchor + 5;
        if (!anchorRestoredFromLogs && Math.abs(restoredFromLogsTop - scrolledTop) > 120) {
            throw new Error('Switching through Logs did not restore the vertical viewport.');
        }
        if (Math.abs(restoredFromLogsLeft - scrolledLeft) > 80) {
            throw new Error('Switching through Logs did not restore the horizontal viewport.');
        }

        // ResultPanelView keeps the active result source aligned with the
        // focused SQL editor. Reproduce the production source-switch path by
        // focusing the destination editor before asking the webview to switch.
        await vscode.window.showTextDocument(secondSource, { preview: false });
        await provider.runResultPanelTestBridge('switchSource', { sourceUri: secondSource.uri.toString() });
        await vscode.window.showTextDocument(scrollSource, { preview: false });
        await provider.runResultPanelTestBridge('switchSource', {
            sourceUri: scrollSource.uri.toString(),
        });
        const restoredFromSourceAfterTab = asRecord(await provider.runResultPanelTestBridge('switchResultSet', {
            resultSetIndex: scrollResultIndex,
        }));
        const restoredFromSourceViewport = asRecord(restoredFromSourceAfterTab.viewport);
        const restoredFromSourceAnchor = asNumber(restoredFromSourceViewport.scrollAnchorIndex, -1);
        const restoredFromSourceTop = asNumber(restoredFromSourceViewport.scrollTop, 0);
        const restoredFromSourceLeft = asNumber(restoredFromSourceViewport.scrollLeft, 0);
        const anchorRestoredFromSource = scrolledAnchor >= 0
            && restoredFromSourceAnchor >= scrolledAnchor - 5
            && restoredFromSourceAnchor <= scrolledAnchor + 5;
        if (!anchorRestoredFromSource && Math.abs(restoredFromSourceTop - scrolledTop) > 120) {
            throw new Error('Switching result sources did not restore the vertical viewport.');
        }
        if (Math.abs(restoredFromSourceLeft - scrolledLeft) > 80) {
            throw new Error('Switching result sources did not restore the horizontal viewport.');
        }

        await provider.runResultPanelTestBridge('togglePin');
        await provider.runResultPanelTestBridge('toggleResultPin');
        await vscode.window.showTextDocument(savedDocument, { preview: false });
        await provider.runResultPanelTestBridge('switchSource', { sourceUri });
        await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: allResultIndex });
        await provider.runResultPanelTestBridge('togglePin');
        await vscode.window.showTextDocument(secondSource, { preview: false });
        await provider.runResultPanelTestBridge('switchSource', { sourceUri: secondSource.uri.toString() });
        await vscode.window.showTextDocument(savedDocument, { preview: false });
        await provider.runResultPanelTestBridge('switchSource', { sourceUri });

        const finalSnapshot = asRecord(await provider.runResultPanelTestBridge('snapshot'));
        if (asNumber(finalSnapshot.pendingRequestCount, -1) !== 0) {
            throw new Error(`Result-panel webview left ${String(finalSnapshot.pendingRequestCount)} pending requests.`);
        }
        if (provider.getResultPanelTestBridgePendingRequestCount() !== 0) {
            throw new Error('Result-panel host left a pending bridge request.');
        }
        await requestExtensionHostScreenshot('06-final-result-panel');
        traceResultPanelEvent({ phase: 'extension_host_scenario_complete', sourceUri, reason: engine });
        const report = buildReport(
            provider,
            engine,
            sourceUri,
            startedAt,
            'passed',
            untitledLanguageLifecyclePassed,
        );
        writeReport(report);
        return report;
    } catch (error: unknown) {
        const report = buildReport(
            provider,
            engine,
            sourceUri,
            startedAt,
            'failed',
            untitledLanguageLifecyclePassed,
        );
        writeReport(report);
        throw error;
    } finally {
        if (netezzaFixtureCreated) {
            try {
                await runRawFixtureQuery(
                    context,
                    connectionManager,
                    connectionName,
                    buildNetezzaFixtureDropSql(tableName, schemaName),
                );
            } catch {
                traceResultPanelEvent({ phase: 'fixture_cleanup_failed', reason: 'drop_failed' });
            }
        }
        for (const documentUri of documentUris) {
            await connectionManager.clearDocumentConnection(documentUri).catch(() => undefined);
        }
        await connectionManager.deleteConnection(connectionName).catch(() => undefined);
    }
}

function osTempFallback(): string {
    return path.join(process.env.TMPDIR || process.env.TEMP || '.', 'justybase-extension-host');
}

/**
 * Register test-only result-panel commands. Neither command is contributed in
 * package.json, and both require the bounded trace flag at invocation time.
 */
export function registerResultPanelRegressionCommand(
    resultPanelProvider: ResultPanelView,
    connectionManager: ConnectionManager,
    context?: vscode.ExtensionContext,
): vscode.Disposable | undefined {
    if (process.env.NODE_ENV !== 'test') {
        return undefined;
    }

    const disposables: vscode.Disposable[] = [
        vscode.commands.registerCommand(
            'justybase.test.resultPanelRegression',
            (args?: ResultPanelRegressionCommandArgs) => {
                if (args?.mode === 'cold-editor-command') {
                    return runColdEditorCommandRegression(resultPanelProvider, connectionManager);
                }
                return resultPanelProvider.runResultPanelRegressionScenario(args?.sourceUri);
            },
        ),
    ];
    if (context) {
        disposables.push(vscode.commands.registerCommand(
            'justybase.test.extensionHostScenario',
            (args?: ExtensionHostScenarioOptions) => {
                if (!isResultPanelTraceEnabled()) {
                    throw new Error('Extension Host scenario requires result-panel tracing.');
                }
                return runExtensionHostScenario(context, resultPanelProvider, connectionManager, args ?? {});
            },
        ));
    }
    return {
        dispose: () => disposables.forEach(disposable => disposable.dispose()),
    };
}

async function runColdEditorCommandRegression(
    resultPanelProvider: ResultPanelView,
    connectionManager: ConnectionManager,
) {
    const password = process.env.NZ_DEV_PASSWORD;
    const hasLiveConnection = Boolean(password);

    const connectionName = 'result-panel-regression-netezza';
    if (password) {
        await connectionManager.saveConnection({
            name: connectionName,
            host: process.env.NZ_DEV_HOST || 'localhost',
            port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
            database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
            user: process.env.NZ_DEV_USER || 'admin',
            password,
            schema: process.env.NZ_DEV_SCHEMA || 'ADMIN',
            dbType: 'netezza',
        });
    }

    const openAndRun = async (value: number) => {
        resultPanelProvider.beginColdResultPanelRegressionScenario();
        await vscode.commands.executeCommand('workbench.action.files.newUntitledFile');
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'untitled') {
            throw new Error('VS Code did not create an active untitled editor.');
        }

        const sql = `SELECT ${value} AS RESULT_PANEL_REGRESSION_ID`;
        const edited = await editor.edit(builder => builder.insert(new vscode.Position(0, 0), sql));
        if (!edited) {
            throw new Error('Could not populate the untitled regression editor.');
        }

        const sourceUri = editor.document.uri.toString();
        if (hasLiveConnection) {
            await connectionManager.setDocumentConnection(sourceUri, connectionName);
        }
        await vscode.commands.executeCommand('netezza.runQuery');
        return {
            documentLanguageId: editor.document.languageId,
            snapshot: await resultPanelProvider.captureColdResultPanelRegressionScenario(
                sourceUri,
                hasLiveConnection ? 1 : 0,
                !hasLiveConnection,
            ),
        };
    };

    const first = await openAndRun(1);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const second = await openAndRun(2);
    return { first, second, hasLiveConnection };
}
