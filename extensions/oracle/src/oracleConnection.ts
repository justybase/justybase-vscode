import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader
} from '@justybase/contracts';
import {
    CURRENT_CATALOG_AND_SCHEMA_QUERY,
    CURRENT_CATALOG_QUERY,
    CURRENT_SCHEMA_QUERY,
    CURRENT_SID_QUERY,
    SET_CATALOG_QUERY,
    getErrorCode,
    getErrorMessage,
    getOptionNumber,
    getOptionString,
    normalizeCatalogIdentifier,
    normalizeCompatibilityIdentifier
} from '../../../src/core/connectionUtils';

interface OracleDbTypeDescriptor {
    name?: string;
}

interface OracleColumnMetadata {
    name?: string;
    dbTypeName?: string;
    dbType?: OracleDbTypeDescriptor | string | number;
    fetchType?: OracleDbTypeDescriptor | string | number;
}

interface OracleResultSet {
    getRow(): Promise<unknown[] | undefined>;
    close(): Promise<void>;
}

interface OracleExecutionResponse {
    metaData?: OracleColumnMetadata[];
    rows?: unknown[][];
    rowsAffected?: number;
    resultSet?: OracleResultSet;
}

interface OracleStatementInfo {
    statementType?: number;
}

interface OracleConnectionTraceConfig {
    connectString?: string;
    user?: string;
    serviceName?: string;
    instanceName?: string;
    hostName?: string;
    port?: number;
    protocol?: string;
}

interface OracleExecuteOptions {
    outFormat?: number;
    extendedMetaData?: boolean;
    resultSet?: boolean;
    maxRows?: number;
    fetchArraySize?: number;
    prefetchRows?: number;
}

interface OracleConnectOptions {
    user: string;
    password?: string;
    connectString: string;
    configDir?: string;
    connectTimeout?: number;
}

interface OracleRuntimeConnection {
    user?: string;
    currentSchema: string;
    callTimeout: number;
    dbName?: string;
    serviceName?: string;
    instanceName?: string;
    connectString?: string;
    connectTraceConfig?: OracleConnectionTraceConfig;
    getStatementInfo(sql: string): Promise<OracleStatementInfo>;
    execute(sql: string, bindParams?: unknown[] | Record<string, unknown>, options?: OracleExecuteOptions): Promise<OracleExecutionResponse>;
    close(): Promise<void>;
    commit(): Promise<void>;
    break(): Promise<void>;
    breakExecution?(): Promise<void>;
}

interface OracleDbModule {
    OUT_FORMAT_ARRAY: number;
    CLOB: unknown;
    NCLOB: unknown;
    fetchAsString: unknown[];
    BLOB: unknown;
    fetchAsBuffer: unknown[];
    STMT_TYPE_SELECT: number;
    getConnection(options: OracleConnectOptions): Promise<OracleRuntimeConnection>;
}

interface OracleColumnDefinition {
    name: string;
    typeName: string;
}

interface OracleExecutionResult {
    columns: OracleColumnDefinition[];
    rows?: readonly unknown[][];
    resultSet?: OracleResultSet;
    recordsAffected: number;
    restoreTimeout?: () => void;
}



const DEFAULT_FETCH_ARRAY_SIZE = 100;

let _oracleDbModulePromise: Promise<OracleDbModule> | undefined;
const _extensionRequire = createRequire(__filename);



function isMissingOracleDependencyError(error: unknown): boolean {
    const code = getErrorCode(error);
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
        return true;
    }

    const message = getErrorMessage(error);
    return message.includes("Cannot find module 'oracledb'") || message.includes("Cannot find package 'oracledb'");
}



function buildConnectionString(config: DatabaseConnectionConfig): string {
    const connectStringOverride = getOptionString(config, 'connectString');
    if (connectStringOverride) {
        return connectStringOverride;
    }

    const host = config.host.trim();
    const port = config.port ?? 1521;
    const database = config.database.trim();
    return `${host}:${port}/${database}`;
}

function buildConnectOptions(config: DatabaseConnectionConfig): OracleConnectOptions {
    const configDir = getOptionString(config, 'configDir');
    const connectTimeout = getOptionNumber(config, 'connectTimeout');

    return {
        user: config.user,
        password: config.password,
        connectString: buildConnectionString(config),
        configDir,
        connectTimeout
    };
}

function buildConnectionDebugSummary(config: DatabaseConnectionConfig): string {
    const connectStringOverride = getOptionString(config, 'connectString');
    return [
        `host=${config.host || '<empty>'}`,
        `port=${config.port ?? 1521}`,
        `database=${config.database || '<empty>'}`,
        `user=${config.user || '<empty>'}`,
        `connectStringOverride=${connectStringOverride || '<none>'}`
    ].join(', ');
}

function shouldPreserveTrailingSemicolon(sql: string): boolean {
    return /^\s*(BEGIN|DECLARE)\b/i.test(sql)
        || /^\s*CREATE(\s+OR\s+REPLACE)?\s+(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\b/i.test(sql);
}

function normalizeExecutableSql(sql: string): string {
    const trimmed = sql.trim();
    if (!trimmed) {
        return trimmed;
    }

    return shouldPreserveTrailingSemicolon(trimmed) ? trimmed : trimmed.replace(/;+\s*$/, '');
}

function buildColumnTypeName(column: OracleColumnMetadata | undefined): string {
    if (!column) {
        return '';
    }

    if (typeof column.dbTypeName === 'string' && column.dbTypeName.trim().length > 0) {
        return column.dbTypeName;
    }

    const dbType = column.dbType;
    if (dbType && typeof dbType === 'object' && 'name' in dbType && typeof dbType.name === 'string') {
        return dbType.name.replace(/^DB_TYPE_/, '');
    }
    if (typeof dbType === 'string' && dbType.length > 0) {
        return dbType.replace(/^DB_TYPE_/, '');
    }
    if (typeof column.fetchType === 'object' && column.fetchType && 'name' in column.fetchType && typeof column.fetchType.name === 'string') {
        return column.fetchType.name.replace(/^DB_TYPE_/, '');
    }

    return '';
}

function buildColumnDefinitions(metaData: readonly OracleColumnMetadata[] | undefined): OracleColumnDefinition[] {
    return (metaData ?? []).map((column, index) => ({
        name: column.name ?? `COLUMN_${index + 1}`,
        typeName: buildColumnTypeName(column)
    }));
}

async function loadOracleDb(): Promise<OracleDbModule> {
    if (!_oracleDbModulePromise) {
        _oracleDbModulePromise = Promise.resolve()
            .then(() => _extensionRequire('oracledb') as OracleDbModule)
            .then((oracleDb) => {
                const fetchAsString = Array.isArray(oracleDb.fetchAsString) ? [...oracleDb.fetchAsString] : [];
                if (!fetchAsString.includes(oracleDb.CLOB)) {
                    fetchAsString.push(oracleDb.CLOB);
                }
                if (!fetchAsString.includes(oracleDb.NCLOB)) {
                    fetchAsString.push(oracleDb.NCLOB);
                }
                oracleDb.fetchAsString = fetchAsString;
                const fetchAsBuffer = Array.isArray(oracleDb.fetchAsBuffer) ? [...oracleDb.fetchAsBuffer] : [];
                if (!fetchAsBuffer.includes(oracleDb.BLOB)) {
                    fetchAsBuffer.push(oracleDb.BLOB);
                }
                oracleDb.fetchAsBuffer = fetchAsBuffer;
                return oracleDb;
            })
            .catch(error => {
                _oracleDbModulePromise = undefined;
                if (isMissingOracleDependencyError(error)) {
                    throw new Error(
                        'Oracle runtime dependency "oracledb" is not installed.\n' +
                        'Fix: run "npm install" inside extensions\\oracle before building or packaging the Oracle extension.',
                        { cause: error }
                    );
                }

                throw new Error(`Oracle runtime failed to load: ${getErrorMessage(error)}`, { cause: error });
            });
    }

    return _oracleDbModulePromise;
}

class OracleDataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _arrayIndex = -1;
    private _currentRow: readonly unknown[] | undefined;
    private _closed = false;

    public constructor(
        private readonly _columns: readonly OracleColumnDefinition[],
        private readonly _rows?: readonly unknown[][],
        private readonly _resultSet?: OracleResultSet,
        private readonly _restoreTimeout?: () => void
    ) {
        this.fieldCount = _columns.length;
    }

    public async read(): Promise<boolean> {
        if (this._rows) {
            const nextIndex = this._arrayIndex + 1;
            if (nextIndex >= this._rows.length) {
                this._currentRow = undefined;
                return false;
            }

            this._arrayIndex = nextIndex;
            this._currentRow = this._rows[nextIndex];
            return true;
        }

        if (!this._resultSet) {
            this._currentRow = undefined;
            return false;
        }

        const row = await this._resultSet.getRow();
        if (!row) {
            this._currentRow = undefined;
            return false;
        }

        this._currentRow = row;
        return true;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        if (this._closed) {
            return;
        }

        this._closed = true;
        try {
            if (this._resultSet) {
                await this._resultSet.close();
            }
        } finally {
            this._restoreTimeout?.();
        }
    }

    public getName(index: number): string {
        return this._columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._columns[index]?.typeName ?? '';
    }

    public getValue(index: number): unknown {
        return this._currentRow?.[index];
    }
}

export class OracleConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _connection?: OracleRuntimeConnection;
    private _oracleDb?: OracleDbModule;
    private _currentCatalog: string;
    private _currentSchema: string;
    private _currentSid: string;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._currentCatalog = normalizeCompatibilityIdentifier(config.database, 'ORACLE');
        this._currentSchema = normalizeCompatibilityIdentifier(getOptionString(config, 'currentSchema') || config.user, 'PUBLIC');
        this._currentSid = `oracle-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        try {
            const oracleDb = await loadOracleDb();
            const connection = await oracleDb.getConnection(buildConnectOptions(this.config));

            const configuredCurrentSchema = getOptionString(this.config, 'currentSchema');
            if (configuredCurrentSchema) {
                connection.currentSchema = normalizeCompatibilityIdentifier(configuredCurrentSchema, configuredCurrentSchema);
            }

            this._oracleDb = oracleDb;
            this._connection = connection;
            this._connected = true;

            const traceConfig = connection.connectTraceConfig;
            this._currentCatalog = normalizeCompatibilityIdentifier(
                connection.serviceName
                || traceConfig?.serviceName
                || connection.dbName
                || this.config.database,
                'ORACLE'
            );
            this._currentSchema = normalizeCompatibilityIdentifier(
                configuredCurrentSchema || connection.currentSchema || connection.user || this.config.user,
                'PUBLIC'
            );
            this._currentSid = normalizeCompatibilityIdentifier(
                connection.instanceName || traceConfig?.instanceName || this._currentSid,
                this._currentSid
            );
        } catch (error) {
            throw new Error(
                `Failed to connect to Oracle: ${getErrorMessage(error)}\nConnection details: ${buildConnectionDebugSummary(this.config)}`,
                { cause: error }
            );
        }
    }

    public async close(): Promise<void> {
        if (!this._connection) {
            this._connected = false;
            return;
        }

        try {
            await this._connection.close();
        } finally {
            this._connection = undefined;
            this._connected = false;
        }
    }

    public createCommand(sql: string): DatabaseCommand {
        return new OracleCommand(this, sql);
    }

    public getCurrentCatalog(): string {
        return this._currentCatalog;
    }

    public getCurrentSchema(): string {
        return this._currentSchema;
    }

    public getCurrentSid(): string {
        return this._currentSid;
    }

    public setCurrentCatalog(catalog: string): void {
        const normalizedCatalog = normalizeCatalogIdentifier(catalog);
        if (!normalizedCatalog) {
            throw new Error('Catalog name cannot be empty.');
        }

        // Oracle sessions cannot switch services on an existing connection.
        // Keep compatibility commands working without pretending to reconnect.
        this._currentCatalog = normalizedCatalog;
    }

    public async breakCurrentOperation(): Promise<void> {
        const connection = this._connection;
        if (!connection) {
            return;
        }

        if (typeof connection.breakExecution === 'function') {
            try {
                await connection.breakExecution();
                return;
            } catch (breakExecutionError) {
                // Thin-mode versions differ in which break API they expose.
                // A failed breakExecution must still get the legacy fallback.
                try {
                    await connection.break();
                    return;
                } catch {
                    throw breakExecutionError;
                }
            }
        }

        await connection.break();
    }

    public async executeSql(sql: string, commandTimeoutSeconds: number): Promise<OracleExecutionResult> {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
            return {
                columns: [],
                rows: [],
                recordsAffected: -1
            };
        }

        const compatibilityResult = this.tryExecuteCompatibilityCommand(trimmedSql);
        if (compatibilityResult) {
            return compatibilityResult;
        }

        const connection = this.getConnection();
        const oracleDb = this.getOracleDb();
        const executableSql = normalizeExecutableSql(trimmedSql);
        const previousCallTimeout = this.applyCommandTimeout(commandTimeoutSeconds);

        try {
            const statementInfo = await connection.getStatementInfo(executableSql);
            const statementType = statementInfo.statementType ?? 0;
            if (statementType === oracleDb.STMT_TYPE_SELECT) {
                const result = await connection.execute(
                    executableSql,
                    [],
                    {
                        outFormat: oracleDb.OUT_FORMAT_ARRAY,
                        extendedMetaData: true,
                        resultSet: true,
                        fetchArraySize: DEFAULT_FETCH_ARRAY_SIZE,
                        prefetchRows: DEFAULT_FETCH_ARRAY_SIZE
                    }
                );

                const columns = buildColumnDefinitions(result.metaData);
                if (result.resultSet) {
                    return {
                        columns,
                        resultSet: result.resultSet,
                        recordsAffected: typeof result.rowsAffected === 'number' ? result.rowsAffected : -1,
                        restoreTimeout: () => {
                            this.restoreCallTimeout(previousCallTimeout);
                        }
                    };
                }

                this.restoreCallTimeout(previousCallTimeout);
                return {
                    columns,
                    rows: result.rows,
                    recordsAffected: typeof result.rowsAffected === 'number' ? result.rowsAffected : -1
                };
            }

            const result = await connection.execute(
                executableSql,
                [],
                {
                    outFormat: oracleDb.OUT_FORMAT_ARRAY,
                    extendedMetaData: true
                }
            );

            if (!result.metaData) {
                await connection.commit();
            }

            this.restoreCallTimeout(previousCallTimeout);
            return {
                columns: buildColumnDefinitions(result.metaData),
                rows: result.rows,
                recordsAffected: typeof result.rowsAffected === 'number' ? result.rowsAffected : -1
            };
        } catch (error) {
            this.restoreCallTimeout(previousCallTimeout);
            throw new Error(`Oracle query failed: ${getErrorMessage(error)}`, { cause: error });
        }
    }

    private getConnection(): OracleRuntimeConnection {
        if (!this._connection) {
            throw new Error('Oracle connection is not open.');
        }

        return this._connection;
    }

    private getOracleDb(): OracleDbModule {
        if (!this._oracleDb) {
            throw new Error('Oracle runtime is not loaded.');
        }

        return this._oracleDb;
    }

    private applyCommandTimeout(commandTimeoutSeconds: number): number {
        const connection = this.getConnection();
        const previousCallTimeout = connection.callTimeout ?? 0;
        connection.callTimeout = commandTimeoutSeconds > 0 ? commandTimeoutSeconds * 1000 : 0;
        return previousCallTimeout;
    }

    private restoreCallTimeout(previousCallTimeout: number): void {
        if (!this._connection) {
            return;
        }

        this._connection.callTimeout = previousCallTimeout;
    }

    private tryExecuteCompatibilityCommand(sql: string): OracleExecutionResult | undefined {
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [
                    { name: 'CURRENT_CATALOG', typeName: 'VARCHAR2' },
                    { name: 'CURRENT_SCHEMA', typeName: 'VARCHAR2' }
                ],
                rows: [[this.getCurrentCatalog(), this.getCurrentSchema()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_CATALOG_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_CATALOG', typeName: 'VARCHAR2' }],
                rows: [[this.getCurrentCatalog()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SCHEMA', typeName: 'VARCHAR2' }],
                rows: [[this.getCurrentSchema()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_SID_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SID', typeName: 'VARCHAR2' }],
                rows: [[this.getCurrentSid()]],
                recordsAffected: -1
            };
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            this.setCurrentCatalog(setCatalogMatch[1]);
            return {
                columns: [],
                rows: [],
                recordsAffected: 0
            };
        }

        return undefined;
    }
}

class OracleCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;
    private _cancelPromise?: Promise<void>;

    public constructor(
        private readonly _connection: OracleConnection,
        private readonly _sql: string
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const result = await this._connection.executeSql(this._sql, this.commandTimeout);
        this._recordsAffected = result.recordsAffected;

        if (this._cancelled) {
            result.restoreTimeout?.();
            if (result.resultSet) {
                await result.resultSet.close();
            }
            throw new Error('Query cancelled.');
        }

        return new OracleDataReader(result.columns, result.rows, result.resultSet, result.restoreTimeout);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        if (!this._cancelPromise) {
            this._cancelPromise = this._connection.breakCurrentOperation();
        }
        await this._cancelPromise;
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}
