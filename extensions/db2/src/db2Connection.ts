import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'events';
import type { Column as IbmDbColumnMetadata, Database as IbmDbDatabase, ODBCResult } from 'ibm_db';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader
} from '@justybase/contracts';
import { getErrorCode, getErrorMessage } from '../../../src/core/connectionUtils';

interface Db2ColumnDefinition {
    name: string;
    typeName: string;
}

type Db2Row = Record<string, unknown>;

interface Db2ExecutionResult {
    columns: Db2ColumnDefinition[];
    rows: Db2Row[];
    recordsAffected: number;
}

type IbmDbModule = typeof import('ibm_db');

let _ibmDbModulePromise: Promise<IbmDbModule> | undefined;
const _extensionRequire = createRequire(__filename);
const _bundledClidriverHome = path.resolve(__dirname, '../node_modules/ibm_db/installer/clidriver');



export function ensureClidriverOnPath(
    clidriverHome: string,
    platform: NodeJS.Platform = process.platform
): void {
    const binDir = path.join(clidriverHome, 'bin');
    const libDir = path.join(clidriverHome, 'lib');

    const prependPathEntry = (envName: string, dir: string): void => {
        if (!fs.existsSync(dir)) {
            return;
        }

        const sep = path.delimiter;
        const currentValue = process.env[envName] ?? '';
        const dirs = currentValue.split(sep).filter(Boolean);
        if (dirs.includes(dir)) {
            return;
        }

	process.env[envName] = [dir, ...dirs].join(sep);
	};

	prependPathEntry('PATH', libDir);
	prependPathEntry('PATH', binDir);

	// DB2CODEPAGE=1208 (UTF-8) - Layer 4 of Defense-in-Depth Strategy
	// This is the runtime fallback, executed before establishing connections.
	// See extension.ts for full documentation of the layered strategy:
	//   Layer 1: esbuild.db2.js banner (first for packaged extensions)
	//   Layer 2: .vscode/launch.json env (for F5 debug sessions)
	//   Layer 3: extension.ts module-level check (fallback)
	//   Layer 4: THIS FUNCTION - ensureClidriverOnPath() (runtime fallback)
	// On Windows this is critical; on Linux/macOS it ensures consistent behavior.
	if (!process.env.DB2CODEPAGE) {
		process.env.DB2CODEPAGE = '1208';
	}

	if (platform === 'linux') {
        prependPathEntry('LD_LIBRARY_PATH', libDir);
    } else if (platform === 'darwin') {
        prependPathEntry('DYLD_LIBRARY_PATH', libDir);
    }
}

export function isValidClidriverHome(
    clidriverHome: string | undefined,
    platform: NodeJS.Platform = process.platform
): clidriverHome is string {
    if (!clidriverHome || !fs.existsSync(clidriverHome)) {
        return false;
    }

    if (platform === 'win32') {
        return fs.existsSync(path.join(clidriverHome, 'bin', 'db2cli64.dll'));
    }

    if (platform === 'linux') {
        return fs.existsSync(path.join(clidriverHome, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverHome, 'lib', 'libdb2.so'))
            || fs.existsSync(path.join(clidriverHome, 'lib', 'libdb2.so.1'));
    }

    if (platform === 'darwin') {
        return fs.existsSync(path.join(clidriverHome, 'bin', 'db2cli'))
            || fs.existsSync(path.join(clidriverHome, 'lib', 'libdb2.dylib'));
    }

    return false;
}

function resolveBundledClidriverHome(): string | undefined {
    if (isValidClidriverHome(_bundledClidriverHome)) {
        process.env.IBM_DB_HOME = _bundledClidriverHome;
        ensureClidriverOnPath(_bundledClidriverHome);
        return _bundledClidriverHome;
    }

    if (isValidClidriverHome(process.env.IBM_DB_HOME)) {
        ensureClidriverOnPath(process.env.IBM_DB_HOME);
        return process.env.IBM_DB_HOME;
    }

    return undefined;
}

function getRuntimeVersionSummary(): string {
    const nodeVersion = process.version;
    const electronVersion = process.versions.electron ?? 'n/a';
    const abiVersion = process.versions.modules ?? 'n/a';
    return `Current runtime: Node ${nodeVersion}, Electron ${electronVersion}, ABI ${abiVersion}.`;
}

function isMissingIbmDbDependencyError(error: unknown): boolean {
    const code = getErrorCode(error);
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        return true;
    }

    const message = getErrorMessage(error);
    return (message.includes("Cannot find module 'ibm_db'") || message.includes('Cannot find package \'ibm_db\'')) &&
        !message.includes('bindings');
}

function isAbiMismatchError(error: unknown): boolean {
    const message = getErrorMessage(error);
    return message.includes('NODE_MODULE_VERSION') || message.includes('was compiled against a different Node.js version');
}

function isOdbcDriverManagerError(error: unknown): boolean {
    const message = getErrorMessage(error);
    return message.includes('Data source name not found')
        || message.includes('Nie mo') && message.includes('nazwy') && message.includes('danych')
        || message.includes('Mened') && message.includes('ODBC');
}

/**
 * Attempt to register the bundled IBM CLI driver as a Windows ODBC driver.
 * When the native addon is linked against the Windows ODBC Driver Manager
 * (odbc32.dll) instead of the IBM CLI library (db2app64.dll), a registered
 * ODBC driver entry is required for SQLDriverConnect to succeed.
 * `db2cli install -setup` writes those entries to the Windows registry
 * (HKLM — needs admin; may fail silently without elevation).
 */
function tryRegisterOdbcDriver(clidriverHome: string): boolean {
    const db2cliExe = path.join(clidriverHome, 'bin', 'db2cli.exe');
    if (!fs.existsSync(db2cliExe)) {
        return false;
    }
    try {
        execFileSync(db2cliExe, ['install', '-setup'], {
            cwd: path.join(clidriverHome, 'bin'),
            stdio: 'ignore',
            timeout: 15_000
        });
        return true;
    } catch {
        return false;
    }
}

function clearIbmDbRequireCache(): void {
    for (const cacheKey of Object.keys(_extensionRequire.cache)) {
        if (cacheKey.includes(`${path.sep}node_modules${path.sep}ibm_db${path.sep}`)
            || cacheKey.includes(`${path.sep}node_modules${path.sep}bindings${path.sep}`)) {
            delete _extensionRequire.cache[cacheKey];
        }
    }
    _ibmDbModulePromise = undefined;
}

function buildIbmDbLoadError(error: unknown, clidriverHome: string | undefined): Error {
    const runtimeSummary = getRuntimeVersionSummary();

    if (isMissingIbmDbDependencyError(error)) {
        return new Error(
            'Db2 runtime dependency "ibm_db" is not installed.\n' +
            `${runtimeSummary}\n` +
            'Fix: run "npm run install:db2" from the repository root, or "npm install" inside extensions/db2.',
            { cause: error }
        );
    }

    if (isAbiMismatchError(error)) {
        return new Error(
            'Db2 native module "ibm_db" was compiled for a different Node.js ABI version.\n' +
            `${runtimeSummary}\n` +
            'Fix: use the matching DB2 runtime helper from the repository root:\n' +
            '  - local Jest/live tests: npm run db2:runtime:node\n' +
            '  - F5 / VS Code Electron: npm run db2:runtime:electron\n' +
            'If auto-detect picked the wrong VS Code install, rerun with:\n' +
            '  npm run db2:runtime:electron -- --vscode-dir "C:\\Path\\To\\Microsoft VS Code"\n' +
            'or pass the Electron runtime explicitly:\n' +
            '  npm run db2:runtime:electron -- --electron <ElectronVersion>\n' +
            'Then close all VS Code and Extension Development Host windows before pressing F5 again.',
            { cause: error }
        );
    }

    const clidriverHint = clidriverHome
        ? `\nThe extension-local Db2 CLI driver is at: ${clidriverHome}`
        : '';

    return new Error(
        `Db2 native module "ibm_db" failed to load: ${getErrorMessage(error)}\n` +
        `${runtimeSummary}\n` +
        'Possible fixes:\n' +
        '  1. Ensure ibm_db is installed: npm run install:db2\n' +
        '  2. For local Jest/live tests, switch DB2 to Node: npm run db2:runtime:node\n' +
        '  3. For F5 debugging, switch DB2 to Electron: npm run db2:runtime:electron\n' +
        '  4. If auto-detect chooses the wrong VS Code runtime, rerun db2:runtime:electron with --vscode-dir or --electron.\n' +
        '  5. Close all VS Code / Extension Development Host windows before retrying.\n' +
        '  6. Check that IBM CLI driver (clidriver) is accessible and IBM_DB_HOME is set correctly.' +
        clidriverHint,
        { cause: error }
    );
}

async function loadIbmDb(): Promise<IbmDbModule> {
    if (!_ibmDbModulePromise) {
        const clidriverHome = resolveBundledClidriverHome();
        _ibmDbModulePromise = Promise.resolve()
            .then(() => _extensionRequire('ibm_db') as IbmDbModule)
            .catch(error => {
                _ibmDbModulePromise = undefined;
                throw buildIbmDbLoadError(error, clidriverHome);
            });
    }

    return _ibmDbModulePromise;
}

function escapeOdbcConnectionStringValue(value: string): string {
    if (!/[;={}]/.test(value) && value.trim() === value) {
        return value;
    }

    return '{' + value.replace(/\}/g, '}}') + '}';
}

function getConfiguredClientCodepage(config: DatabaseConnectionConfig): string {
	const configuredClientCodepage = typeof config.options?.clientCodepage === 'string'
		? config.options.clientCodepage.trim()
		: undefined;

	// If no codepage is configured, default to UTF-8 (1208) for proper Unicode support
	if (!configuredClientCodepage) {
		return '1208';
	}

	return configuredClientCodepage;
}

function appendConnectionStringPart(parts: string[], key: string, value: string | number | undefined): void {
    if (value === undefined || value === null || value === '') {
        return;
    }

    const normalizedValue = escapeOdbcConnectionStringValue(String(value));
    parts.push(`${key}=${normalizedValue}`);
}

export function buildConnectionString(config: DatabaseConnectionConfig): string {
    const parts: string[] = [];
    appendConnectionStringPart(parts, 'DATABASE', config.database);
    appendConnectionStringPart(parts, 'HOSTNAME', config.host);
    appendConnectionStringPart(parts, 'PORT', config.port);
    appendConnectionStringPart(parts, 'PROTOCOL', 'TCPIP');
    appendConnectionStringPart(parts, 'UID', config.user);
    appendConnectionStringPart(parts, 'PWD', config.password);

    const currentSchema = typeof config.options?.currentSchema === 'string' ? config.options.currentSchema : undefined;
    const security = typeof config.options?.security === 'string' ? config.options.security : undefined;
    const sslServerCertificate = typeof config.options?.sslServerCertificate === 'string'
        ? config.options.sslServerCertificate
        : undefined;
    const clientCodepage = getConfiguredClientCodepage(config);

    appendConnectionStringPart(parts, 'CURRENTSCHEMA', currentSchema);
    appendConnectionStringPart(parts, 'Security', security);
    appendConnectionStringPart(parts, 'SSLServerCertificate', sslServerCertificate);
    appendConnectionStringPart(parts, 'ClientCodepage', clientCodepage);
    return `${parts.join(';')};`;
}

function buildOpenOptions(config: DatabaseConnectionConfig): { connectTimeout?: number } | undefined {
    const connectTimeout = typeof config.options?.connectTimeout === 'number'
        ? config.options.connectTimeout
        : undefined;

    return connectTimeout !== undefined ? { connectTimeout } : undefined;
}

function buildConnectionDebugSummary(config: DatabaseConnectionConfig): string {
    const clientCodepage = getConfiguredClientCodepage(config);
    const parts = [
        `database=${config.database || '<empty>'}`,
        `host=${config.host || '<empty>'}`,
        `port=${config.port ?? '<default>'}`,
        `user=${config.user || '<empty>'}`,
        `clientCodepage=${clientCodepage || '<driver default>'}`,
        `IBM_DB_HOME=${process.env.IBM_DB_HOME || '<unset>'}`
    ];

    return parts.join(', ');
}

function isLikelyResultSetQuery(sql: string): boolean {
    const normalized = sql.trim().replace(/;+\s*$/, '').toUpperCase();
    return /^(SELECT|WITH|VALUES)\b/.test(normalized);
}

function buildColumnDefinitions(result: ODBCResult): Db2ColumnDefinition[] {
    const metadata = result.getColumnMetadataSync();
    const fallbackNames = result.getColumnNamesSync();

    return metadata.map((column: IbmDbColumnMetadata, index: number) => {
        const legacyColumn = column as IbmDbColumnMetadata & {
            NAME?: string;
            TYPE_NAME?: string;
            SQL_DESC_TYPE?: string | number;
        };

        return {
            name: legacyColumn.SQL_DESC_NAME || legacyColumn.NAME || fallbackNames[index] || `COLUMN_${index + 1}`,
            typeName: String(legacyColumn.SQL_DESC_TYPE_NAME || legacyColumn.TYPE_NAME || legacyColumn.SQL_DESC_TYPE || '')
        };
    });
}

function toDb2RowArray(rawRows: unknown): unknown[] {
    if (Array.isArray(rawRows)) {
        return rawRows;
    }

    return rawRows === undefined || rawRows === null ? [] : [rawRows];
}

function buildColumnDefinitionsFromRows(rawRows: unknown): Db2ColumnDefinition[] {
    const rows = toDb2RowArray(rawRows);
    const firstRow = rows[0];
    if (firstRow === undefined || firstRow === null) {
        return [];
    }

    if (firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)) {
        return Object.keys(firstRow as Db2Row).map(name => ({
            name,
            typeName: ''
        }));
    }

    if (Array.isArray(firstRow)) {
        return firstRow.map((_value, index) => ({
            name: `COLUMN_${index + 1}`,
            typeName: ''
        }));
    }

    return [{ name: 'VALUE', typeName: '' }];
}

function extractDb2QuerySyncError(rawResult: unknown): Error | undefined {
    const message = (() => {
        if (typeof rawResult === 'string') {
            return rawResult;
        }

        if (Array.isArray(rawResult) && rawResult.length === 1 && typeof rawResult[0] === 'string') {
            return rawResult[0];
        }

        if (rawResult && typeof rawResult === 'object') {
            const candidate = rawResult as { error?: unknown; message?: unknown };
            if (typeof candidate.error === 'string') {
                return candidate.error;
            }
            if (typeof candidate.message === 'string') {
                return candidate.message;
            }
        }

        return undefined;
    })();

    if (!message) {
        return undefined;
    }

    const normalizedMessage = message.trim();
    if (
        /\[node-ibm_db\]\s+Error in ODBCConnection::QuerySync/i.test(normalizedMessage)
        || /\bSQLSTATE=\w{5}\b/i.test(normalizedMessage)
        || /\bSQL\d{4,5}[A-Z]\b/i.test(normalizedMessage)
    ) {
        return new Error(normalizedMessage);
    }

    return undefined;
}

function normalizeRows(rawRows: unknown, columns: readonly Db2ColumnDefinition[]): Db2Row[] {
    return toDb2RowArray(rawRows).map(row => {
        if (row && typeof row === 'object' && !Array.isArray(row)) {
            return row as Db2Row;
        }

        if (Array.isArray(row)) {
            return Object.fromEntries(columns.map((column, index) => [column.name, row[index]]));
        }

        const firstColumn = columns[0]?.name || 'VALUE';
        return { [firstColumn]: row };
    });
}

function normalizeSingleRow(rawRow: unknown, columns: readonly Db2ColumnDefinition[]): Db2Row {
    if (rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)) {
        return rawRow as Db2Row;
    }

    if (Array.isArray(rawRow)) {
        return Object.fromEntries(columns.map((column, index) => [column.name, rawRow[index]]));
    }

    const firstColumn = columns[0]?.name || 'VALUE';
    return { [firstColumn]: rawRow };
}

interface RuntimeCloseableResult {
    closeSync?: () => boolean | void;
    close?: (callback?: (error?: Error | null) => void) => Promise<unknown> | void;
}

function isResultHandleLike(value: unknown): value is ODBCResult {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<ODBCResult>;
    return (typeof candidate.fetch === 'function' || typeof candidate.fetchAllSync === 'function')
        && typeof candidate.getColumnMetadataSync === 'function'
        && typeof candidate.getColumnNamesSync === 'function';
}

function isSyncResultHandleLike(value: unknown): value is ODBCResult {
    return isResultHandleLike(value) && typeof (value as Partial<ODBCResult>).fetchAllSync === 'function';
}

function extractResultHandle(
    queryResult: ODBCResult | [ODBCResult | null, unknown[]] | null | unknown
): ODBCResult | null {
    const candidate = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    return isResultHandleLike(candidate) ? candidate : null;
}

function extractSyncResultHandle(
    queryResult: ODBCResult | [ODBCResult | null, unknown[]] | null | unknown
): ODBCResult | null {
    const candidate = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    return isSyncResultHandleLike(candidate) ? candidate : null;
}

function closeResultHandle(resultHandle: ODBCResult): void {
    const closeable = resultHandle as ODBCResult & RuntimeCloseableResult;
    try {
        if (typeof closeable.closeSync === 'function') {
            closeable.closeSync();
            return;
        }

        if (typeof closeable.close === 'function') {
            closeable.close();
        }
    } catch {
        // Keep cleanup best-effort: returning result rows is more valuable
        // than throwing on handle-dispose differences across ibm_db builds.
    }
}

async function closeResultHandleAsync(resultHandle: ODBCResult): Promise<void> {
    const closeable = resultHandle as ODBCResult & RuntimeCloseableResult;
    try {
        if (typeof closeable.close === 'function') {
            await closeable.close();
            return;
        }

        if (typeof closeable.closeSync === 'function') {
            closeable.closeSync();
        }
    } catch {
        // Cleanup is best-effort across ibm_db runtime builds.
    }
}

class Db2DataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _currentIndex = -1;

    public constructor(
        private readonly _columns: readonly Db2ColumnDefinition[],
        private readonly _rows: readonly Db2Row[]
    ) {
        this.fieldCount = _columns.length;
    }

    public async read(): Promise<boolean> {
        const nextIndex = this._currentIndex + 1;
        if (nextIndex >= this._rows.length) {
            return false;
        }

        this._currentIndex = nextIndex;
        return true;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        return undefined;
    }

    public getName(index: number): string {
        return this._columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._columns[index]?.typeName ?? '';
    }

    public getValue(index: number): unknown {
        if (this._currentIndex < 0 || this._currentIndex >= this._rows.length) {
            return undefined;
        }

        const columnName = this._columns[index]?.name;
        return columnName ? this._rows[this._currentIndex]?.[columnName] : undefined;
    }
}

class Db2StreamingDataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _currentRow: Db2Row | undefined;
    private _closed = false;
    private _cancelled = false;

    public constructor(
        private readonly _columns: readonly Db2ColumnDefinition[],
        private readonly _resultHandle: ODBCResult,
        private readonly _isCommandCancelled: () => boolean
    ) {
        this.fieldCount = _columns.length;
    }

    public async read(): Promise<boolean> {
        if (this._closed || this._cancelled || this._isCommandCancelled()) {
            this._currentRow = undefined;
            await this.close();
            return false;
        }

        try {
            const rawRow = await this._resultHandle.fetch();
            if (this._closed || this._cancelled || this._isCommandCancelled() || rawRow === null) {
                this._currentRow = undefined;
                await this.close();
                return false;
            }

            this._currentRow = normalizeSingleRow(rawRow, this._columns);
            return true;
        } catch (error) {
            this._currentRow = undefined;
            await this.close();
            if (this._cancelled || this._isCommandCancelled()) {
                return false;
            }

            throw error;
        }
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;
        await closeResultHandleAsync(this._resultHandle);
    }

    public async abort(): Promise<void> {
        this._cancelled = true;
        this._currentRow = undefined;
        await this.close();
    }

    public getName(index: number): string {
        return this._columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._columns[index]?.typeName ?? '';
    }

    public getValue(index: number): unknown {
        const columnName = this._columns[index]?.name;
        return columnName ? this._currentRow?.[columnName] : undefined;
    }
}

export class Db2Connection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _database?: IbmDbDatabase;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        try {
            const ibmDb = await loadIbmDb();
            this._database = await ibmDb.open(buildConnectionString(this.config), buildOpenOptions(this.config));
            this._connected = true;
        } catch (error) {
            if (isOdbcDriverManagerError(error) && isValidClidriverHome(_bundledClidriverHome)) {
                // The native addon is linked against the Windows ODBC Driver
                // Manager (odbc32.dll) instead of the IBM CLI library directly.
                // Try registering the bundled CLI driver as a Windows ODBC
                // driver and retry the connection.
                try {
                    process.env.IBM_DB_HOME = _bundledClidriverHome;
                    ensureClidriverOnPath(_bundledClidriverHome);
                    tryRegisterOdbcDriver(_bundledClidriverHome);

                    clearIbmDbRequireCache();
                    const ibmDb = await loadIbmDb();
                    this._database = await ibmDb.open(buildConnectionString(this.config), buildOpenOptions(this.config));
                    this._connected = true;
                    return;
                } catch {
                    // Preserve the original connection error below.
                }
            }

            const db2cliExe = path.join(_bundledClidriverHome, 'bin', 'db2cli.exe');
            const odbcHint = isOdbcDriverManagerError(error)
                ? '\nThe native addon routes through the Windows ODBC Driver Manager.\n' +
                  'Fix: run "npm run db2:runtime:electron" (or the legacy alias "npm run rebuild:db2")\n' +
                  'to recompile with direct IBM CLI linking.\n' +
                  'Or register the bundled ODBC driver from an admin command prompt:\n' +
                  `  "${db2cliExe}" install -setup`
                : '';

            throw new Error(
                `Failed to connect to Db2: ${error instanceof Error ? error.message : String(error)}\n` +
                `Connection details: ${buildConnectionDebugSummary(this.config)}${odbcHint}`,
                { cause: error }
            );
        }
    }

    public async close(): Promise<void> {
        if (!this._database) {
            this._connected = false;
            return;
        }

        await this._database.close();
        this._database = undefined;
        this._connected = false;
    }

    public createCommand(sql: string): DatabaseCommand {
        return new Db2Command(this, sql);
    }

    public getDatabase(): IbmDbDatabase {
        if (!this._database) {
            throw new Error('Db2 connection is not open.');
        }

        return this._database;
    }

    public executeSql(sql: string): Db2ExecutionResult {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
            return {
                columns: [],
                rows: [],
                recordsAffected: -1
            };
        }

        const database = this.getDatabase();
        if (!isLikelyResultSetQuery(trimmedSql)) {
            database.querySync(trimmedSql);
            return {
                columns: [],
                rows: [],
                recordsAffected: -1
            };
        }

        const resultHandle = extractSyncResultHandle(database.queryResultSync(trimmedSql));
        if (!resultHandle) {
            const fallbackRows = database.querySync(trimmedSql);
            const fallbackError = extractDb2QuerySyncError(fallbackRows);
            if (fallbackError) {
                throw fallbackError;
            }
            if (fallbackRows === undefined || fallbackRows === null) {
                throw new Error('Db2 did not return a result set for a row-returning query.');
            }

            const columns = buildColumnDefinitionsFromRows(fallbackRows);
            return {
                columns,
                rows: normalizeRows(fallbackRows, columns),
                recordsAffected: -1
            };
        }

        try {
            const columns = buildColumnDefinitions(resultHandle);
            const rows = normalizeRows(resultHandle.fetchAllSync(), columns);
            return {
                columns,
                rows,
                recordsAffected: -1
            };
        } finally {
            closeResultHandle(resultHandle);
        }
    }
}

class Db2Command implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;
    private _activeReader: Db2StreamingDataReader | undefined;

    public constructor(
        private readonly _connection: Db2Connection,
        private readonly _sql: string
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const trimmedSql = this._sql.trim();
        if (!trimmedSql) {
            this._recordsAffected = -1;
            return new Db2DataReader([], []);
        }

        const database = this._connection.getDatabase();
        if (!isLikelyResultSetQuery(trimmedSql)) {
            const rawResult = await database.query(trimmedSql);
            const executionError = extractDb2QuerySyncError(rawResult);
            if (executionError) {
                throw executionError;
            }

            if (this._cancelled) {
                throw new Error('Query cancelled.');
            }

            this._recordsAffected = -1;
            return new Db2DataReader([], []);
        }

        const resultHandle = extractResultHandle(await database.queryResult(trimmedSql));
        if (!resultHandle) {
            const fallbackRows = await database.query(trimmedSql);
            const fallbackError = extractDb2QuerySyncError(fallbackRows);
            if (fallbackError) {
                throw fallbackError;
            }
            if (fallbackRows === undefined || fallbackRows === null) {
                throw new Error('Db2 did not return a result set for a row-returning query.');
            }

            if (this._cancelled) {
                throw new Error('Query cancelled.');
            }

            const columns = buildColumnDefinitionsFromRows(fallbackRows);
            this._recordsAffected = -1;
            return new Db2DataReader(columns, normalizeRows(fallbackRows, columns));
        }

        let columns: Db2ColumnDefinition[];
        try {
            columns = buildColumnDefinitions(resultHandle);
        } catch (error) {
            await closeResultHandleAsync(resultHandle);
            throw error;
        }

        if (this._cancelled) {
            await closeResultHandleAsync(resultHandle);
            throw new Error('Query cancelled.');
        }

        const reader = new Db2StreamingDataReader(columns, resultHandle, () => this._cancelled);
        this._activeReader = reader;
        this._recordsAffected = -1;
        return reader;
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        await this._activeReader?.abort();
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}
