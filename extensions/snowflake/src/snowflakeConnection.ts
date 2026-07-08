import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
import type {
    Connection as SnowflakeRuntimeConnection,
    ConnectionOptions as SnowflakeConnectionOptions,
} from 'snowflake-sdk';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader,
} from '@justybase/contracts';
import {
    CURRENT_CATALOG_AND_SCHEMA_QUERY,
    CURRENT_CATALOG_QUERY,
    CURRENT_SCHEMA_QUERY,
    CURRENT_SID_QUERY,
    SET_CATALOG_QUERY,
    getOptionString,
    normalizeCatalogIdentifier,
    stripTrailingSemicolons,
} from '../../../src/core/connectionUtils';

interface SnowflakeColumnDefinition {
    name: string;
    typeName: string;
}

interface SnowflakeStatementLike {
    cancel?(callback: (error?: Error | null) => void): void;
}

interface SnowflakeColumnLike {
    getName(): string;
    getType(): string;
}

interface SnowflakeResultStatementLike {
    getNumUpdatedRows?(): number | undefined;
    getColumns?(): SnowflakeColumnLike[] | undefined;
}

interface SnowflakeExecutionResult {
    columns: SnowflakeColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

type SnowflakeSdkModule = typeof import('snowflake-sdk');
type SnowflakeRow = Record<string, unknown>;
type ExtendedSnowflakeConnectionOptions = SnowflakeConnectionOptions & {
    rowMode?: 'object';
};

const _extensionRequire = createRequire(__filename);
let _snowflakeModulePromise: Promise<SnowflakeSdkModule> | undefined;

const CURRENT_WAREHOUSE_QUERY = /^\s*SELECT\s+CURRENT_WAREHOUSE(?:\(\))?(?:\s+AS\s+CURRENT_WAREHOUSE)?\s*;?\s*$/i;
const CURRENT_ROLE_QUERY = /^\s*SELECT\s+CURRENT_ROLE(?:\(\))?(?:\s+AS\s+CURRENT_ROLE)?\s*;?\s*$/i;
const USE_DATABASE_QUERY = /^\s*USE\s+DATABASE\s+("?)([^"]+)\1\s*;?\s*$/i;
const USE_SCHEMA_QUERY = /^\s*USE\s+SCHEMA\s+("?)([^"]+)\1\s*;?\s*$/i;
const USE_WAREHOUSE_QUERY = /^\s*USE\s+WAREHOUSE\s+("?)([^"]+)\1\s*;?\s*$/i;
const USE_ROLE_QUERY = /^\s*USE\s+ROLE\s+("?)([^"]+)\1\s*;?\s*$/i;

function quoteSnowflakeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function inferTypeName(value: unknown): string {
    if (value == null) {
        return 'TEXT';
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return 'NUMBER';
    }

    if (typeof value === 'boolean') {
        return 'BOOLEAN';
    }

    if (value instanceof Date) {
        return 'TIMESTAMP_NTZ';
    }

    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return 'BINARY';
    }

    if (typeof value === 'object') {
        return 'VARIANT';
    }

    return 'TEXT';
}

function createReader(result: SnowflakeExecutionResult): DatabaseDataReader {
    let rowIndex = -1;

    return {
        fieldCount: result.columns.length,
        async read(): Promise<boolean> {
            const nextIndex = rowIndex + 1;
            if (nextIndex >= result.rows.length) {
                return false;
            }
            rowIndex = nextIndex;
            return true;
        },
        async nextResult(): Promise<boolean> {
            return false;
        },
        async close(): Promise<void> {
            return undefined;
        },
        getName(index: number): string {
            return result.columns[index]?.name ?? '';
        },
        getTypeName(index: number): string {
            return result.columns[index]?.typeName ?? 'TEXT';
        },
        getValue(index: number): unknown {
            if (rowIndex < 0 || rowIndex >= result.rows.length) {
                return undefined;
            }

            return result.rows[rowIndex]?.[index];
        },
    };
}

function normalizeRows(rows: readonly unknown[], columns: readonly SnowflakeColumnDefinition[]): unknown[][] {
    return rows.map((row) => {
        if (Array.isArray(row)) {
            return [...row];
        }

        if (row && typeof row === 'object') {
            const record = row as SnowflakeRow;
            return columns.map((column) => record[column.name]);
        }

        return columns.length > 0 ? [row] : [];
    });
}

function hasResultStatementCapabilities(statement: unknown): statement is SnowflakeResultStatementLike {
    return !!statement && typeof statement === 'object';
}

function buildColumnDefinitions(
    statementColumns: readonly unknown[] | undefined,
    rows: readonly unknown[],
): SnowflakeColumnDefinition[] {
    const safeStatementColumns = statementColumns ?? [];
    if (safeStatementColumns.length > 0) {
        return safeStatementColumns.map((column, index) => {
            const record = column as Record<string, unknown>;
            const name = typeof record.getName === 'function' ? String(record.getName()).trim() : '';
            const type = typeof record.getType === 'function' ? String(record.getType()).trim() : '';
            return {
                name: name || `COLUMN_${index + 1}`,
                typeName: type || inferTypeName((rows[0] as SnowflakeRow | undefined)?.[name || '']),
            };
        });
    }

    const firstRow = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row));
    if (!firstRow || Array.isArray(firstRow)) {
        return [];
    }

    return Object.keys(firstRow).map((name) => ({
        name,
        typeName: inferTypeName((firstRow as SnowflakeRow)[name]),
    }));
}

function normalizeIdentifier(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeCatalogIdentifier(value);
    return normalized || undefined;
}

function resolveEnvBackedValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }

    if (trimmed.startsWith('env:')) {
        const envName = trimmed.slice(4).trim();
        const envValue = process.env[envName]?.trim();
        return envValue && envValue.length > 0 ? envValue : undefined;
    }

    const bareDollarMatch = trimmed.match(/^\$([A-Z0-9_]+)$/i);
    if (bareDollarMatch) {
        const envValue = process.env[bareDollarMatch[1]]?.trim();
        return envValue && envValue.length > 0 ? envValue : undefined;
    }

    const bracedMatch = trimmed.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (bracedMatch) {
        const envValue = process.env[bracedMatch[1]]?.trim();
        return envValue && envValue.length > 0 ? envValue : undefined;
    }

    return trimmed;
}

function parseSessionParameters(value: string | undefined): Map<string, string> {
    const resolved = resolveEnvBackedValue(value);
    const output = new Map<string, string>();
    if (!resolved) {
        return output;
    }

    const tokens = resolved
        .split(/[;\n]+/)
        .map((token) => token.trim())
        .filter(Boolean);
    for (const token of tokens) {
        const equalsIndex = token.indexOf('=');
        if (equalsIndex <= 0) {
            continue;
        }

        const key = token.slice(0, equalsIndex).trim().toUpperCase();
        const rawValue = token.slice(equalsIndex + 1).trim();
        if (!key || !rawValue) {
            continue;
        }

        output.set(key, rawValue);
    }

    return output;
}

function getResolvedOption(config: DatabaseConnectionConfig, key: string): string | undefined {
    return resolveEnvBackedValue(getOptionString(config, key));
}

function buildConnectionOptions(config: DatabaseConnectionConfig): ExtendedSnowflakeConnectionOptions {
    // Snowflake treats unquoted identifiers as case-insensitive and resolves them as uppercase.
    // normalizeIdentifier preserves explicitly quoted case-sensitive names while normalizing the
    // common unquoted case to uppercase so later quoted USE statements still target the right object.
    const schema = normalizeIdentifier(getOptionString(config, 'schema'));
    const warehouse = normalizeIdentifier(getOptionString(config, 'warehouse'));
    const role = normalizeIdentifier(getOptionString(config, 'role'));
    const explicitAuthenticator = resolveEnvBackedValue(getOptionString(config, 'authenticator'));
    const authMode = resolveEnvBackedValue(getOptionString(config, 'authMode'))?.toUpperCase();
    const explicitAccount = resolveEnvBackedValue(getOptionString(config, 'account'));
    const accessUrl = resolveEnvBackedValue(getOptionString(config, 'accessUrl'));
    const host = config.host.trim();
    const oauthToken = getResolvedOption(config, 'oauthToken');
    const privateKeyPathOrValue = getResolvedOption(config, 'privateKeyPath');
    const privateKeyPassphrase = getResolvedOption(config, 'privateKeyPassphrase');
    const authenticator = explicitAuthenticator || authMode || 'SNOWFLAKE';

    let finalAccount = explicitAccount || host;
    if (finalAccount.toLowerCase().endsWith('.snowflakecomputing.com')) {
        finalAccount = finalAccount.slice(0, -23);
    }

    const options: ExtendedSnowflakeConnectionOptions = {
        account: finalAccount,
        username: config.user,
        password: resolveEnvBackedValue(config.password),
        database: normalizeIdentifier(config.database),
        schema,
        warehouse,
        role,
        authenticator,
        application: 'JustyBaseSnowflakeSupport',
        rowMode: 'object',
        clientSessionKeepAlive: true,
    };

    if (accessUrl) {
        options.accessUrl = accessUrl;
    }

    if (authenticator === 'OAUTH' && oauthToken) {
        options.token = oauthToken;
    }

    if (authenticator === 'SNOWFLAKE_JWT' && privateKeyPathOrValue) {
        if (privateKeyPathOrValue.includes('BEGIN PRIVATE KEY')) {
            options.privateKey = privateKeyPathOrValue;
        } else {
            options.privateKeyPath = privateKeyPathOrValue;
        }

        if (privateKeyPassphrase) {
            options.privateKeyPass = privateKeyPassphrase;
        }
    }

    return options;
}

async function loadSnowflake(): Promise<SnowflakeSdkModule> {
    if (!_snowflakeModulePromise) {
        _snowflakeModulePromise = Promise.resolve()
            .then(() => _extensionRequire('snowflake-sdk') as SnowflakeSdkModule)
            .catch((error) => {
                _snowflakeModulePromise = undefined;
                throw new Error(
                    'Snowflake runtime dependency "snowflake-sdk" is not installed. ' +
                        'Run "npm install snowflake-sdk" inside extensions/snowflake before using or packaging this extension.',
                    { cause: error },
                );
            });
    }

    return _snowflakeModulePromise;
}

export class SnowflakeConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _connection?: SnowflakeRuntimeConnection;
    private _currentDatabase = '';
    private _currentSchema = 'PUBLIC';
    private _currentWarehouse = '';
    private _currentRole = '';
    private readonly _sessionId = `snowflake-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
    }

    private requireConnection(): SnowflakeRuntimeConnection {
        if (!this._connection) {
            throw new Error('Snowflake connection is not open.');
        }

        return this._connection;
    }

    private async executeSessionStatement(connection: SnowflakeRuntimeConnection, sql: string): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            connection.execute({
                sqlText: stripTrailingSemicolons(sql),
                complete: (error: Error | undefined) => {
                    if (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                        return;
                    }

                    resolve();
                },
            });
        });
    }

    private async applySessionParameters(connection: SnowflakeRuntimeConnection): Promise<void> {
        const sessionParameters = parseSessionParameters(getOptionString(this.config, 'sessionParameters'));
        if (sessionParameters.size === 0) {
            return;
        }

        const assignments = [...sessionParameters.entries()]
            .map(([key, value]) => {
                const numeric = /^-?\d+(\.\d+)?$/.test(value);
                const boolean = /^(true|false)$/i.test(value);
                const formattedValue = numeric || boolean ? value : `'${value.replace(/'/g, "''")}'`;
                return `${quoteSnowflakeIdentifier(key)} = ${formattedValue}`;
            })
            .join(', ');

        await this.executeSessionStatement(connection, `ALTER SESSION SET ${assignments}`);
    }

    private async initializeSession(connection: SnowflakeRuntimeConnection): Promise<void> {
        // Role and warehouse are already passed to the SDK connection options. We mirror the resolved
        // values here so CURRENT_ROLE/CURRENT_WAREHOUSE compatibility queries stay in sync.
        const role = normalizeIdentifier(getOptionString(this.config, 'role'));
        if (role) {
            this._currentRole = role;
        }

        const warehouse = normalizeIdentifier(getOptionString(this.config, 'warehouse'));
        if (warehouse) {
            this._currentWarehouse = warehouse;
        }

        const database = normalizeIdentifier(this.config.database);
        if (database) {
            try {
                await this.executeSessionStatement(connection, `USE DATABASE ${quoteSnowflakeIdentifier(database)}`);
                this._currentDatabase = database;
            } catch {
                // Database may not exist or the user may not have privileges for USE DATABASE yet.
                // Keep tracking the resolved name so fully-qualified metadata queries can still work.
                this._currentDatabase = database;
            }
        }

        if (this._currentDatabase) {
            const schema = normalizeIdentifier(getOptionString(this.config, 'schema'));
            if (schema) {
                try {
                    await this.executeSessionStatement(connection, `USE SCHEMA ${quoteSnowflakeIdentifier(schema)}`);
                    this._currentSchema = schema;
                } catch {
                    this._currentSchema = 'PUBLIC';
                }
            }
        }

        // Session parameters are optional. If an ALTER SESSION assignment fails, leave the
        // connection usable and let the caller discover the setting problem explicitly later.
        try {
            await this.applySessionParameters(connection);
        } catch {
            // Session parameters are optional; don't fail the connection if they can't be applied.
        }
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const snowflake = await loadSnowflake();
        const connection = snowflake.createConnection(buildConnectionOptions(this.config));
        await new Promise<void>((resolve, reject) => {
            connection.connect((error: Error | undefined) => {
                if (error) {
                    reject(new Error(`Failed to connect to Snowflake: ${error.message}`, { cause: error }));
                    return;
                }

                resolve();
            });
        });

        try {
            await this.initializeSession(connection);
        } catch (error) {
            await new Promise<void>((resolve, reject) => {
                connection.destroy((destroyError: Error | undefined) => {
                    if (destroyError) {
                        reject(
                            new Error(
                                `Failed to initialize Snowflake session: ${error instanceof Error ? error.message : String(error)}. ` +
                                    `Additionally failed to close connection: ${destroyError.message}`,
                                { cause: destroyError },
                            ),
                        );
                        return;
                    }

                    resolve();
                });
            });
            throw error;
        }

        this._connection = connection;
        this._connected = true;
    }

    public async close(): Promise<void> {
        const connection = this._connection;
        this._connection = undefined;
        this._connected = false;

        if (!connection) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            connection.destroy((error: Error | undefined) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    public createCommand(sql: string): DatabaseCommand {
        return new SnowflakeCommand(this, sql);
    }

    public getCurrentDatabase(): string {
        return this._currentDatabase || this.config.database;
    }

    public getCurrentSchema(): string {
        return this._currentSchema;
    }

    public getCurrentWarehouse(): string {
        return this._currentWarehouse;
    }

    public getCurrentRole(): string {
        return this._currentRole;
    }

    public getSessionId(): string {
        return this._sessionId;
    }

    public setCurrentDatabase(database: string): void {
        const normalized = normalizeIdentifier(database);
        if (!normalized) {
            throw new Error('Snowflake database name cannot be empty.');
        }

        this._currentDatabase = normalized;
    }

    public async useDatabase(database: string): Promise<void> {
        const normalized = normalizeIdentifier(database);
        if (!normalized) {
            throw new Error('Snowflake database name cannot be empty.');
        }

        await this.executeSessionStatement(
            this.requireConnection(),
            `USE DATABASE ${quoteSnowflakeIdentifier(normalized)}`,
        );
        this._currentDatabase = normalized;
        this._currentSchema = 'PUBLIC';
    }

    public async useSchema(schema: string): Promise<void> {
        const normalized = normalizeIdentifier(schema);
        if (!normalized) {
            throw new Error('Snowflake schema name cannot be empty.');
        }

        await this.executeSessionStatement(
            this.requireConnection(),
            `USE SCHEMA ${quoteSnowflakeIdentifier(normalized)}`,
        );
        this._currentSchema = normalized;
    }

    public async useWarehouse(warehouse: string): Promise<void> {
        const normalized = normalizeIdentifier(warehouse);
        if (!normalized) {
            throw new Error('Snowflake warehouse name cannot be empty.');
        }

        await this.executeSessionStatement(
            this.requireConnection(),
            `USE WAREHOUSE ${quoteSnowflakeIdentifier(normalized)}`,
        );
        this._currentWarehouse = normalized;
    }

    public async useRole(role: string): Promise<void> {
        const normalized = normalizeIdentifier(role);
        if (!normalized) {
            throw new Error('Snowflake role name cannot be empty.');
        }

        await this.executeSessionStatement(
            this.requireConnection(),
            `USE ROLE ${quoteSnowflakeIdentifier(normalized)}`,
        );
        this._currentRole = normalized;
    }

    public async executeSql(
        sql: string,
        onStatement?: (statement: SnowflakeStatementLike | undefined) => void,
    ): Promise<SnowflakeExecutionResult> {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                columns: [
                    { name: 'CURRENT_CATALOG', typeName: 'TEXT' },
                    { name: 'CURRENT_SCHEMA', typeName: 'TEXT' },
                ],
                rows: [[this.getCurrentDatabase(), this.getCurrentSchema()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_CATALOG_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_CATALOG', typeName: 'TEXT' }],
                rows: [[this.getCurrentDatabase()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_SCHEMA', typeName: 'TEXT' }],
                rows: [[this.getCurrentSchema()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_WAREHOUSE_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_WAREHOUSE', typeName: 'TEXT' }],
                rows: [[this.getCurrentWarehouse()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_ROLE_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_ROLE', typeName: 'TEXT' }],
                rows: [[this.getCurrentRole()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_SID_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_SID', typeName: 'TEXT' }],
                rows: [[this.getSessionId()]],
                recordsAffected: -1,
            };
        }

        const setCatalogMatch = trimmedSql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this.useDatabase(setCatalogMatch[1]);
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        const useDatabaseMatch = trimmedSql.match(USE_DATABASE_QUERY);
        if (useDatabaseMatch) {
            await this.useDatabase(useDatabaseMatch[2]);
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        const useSchemaMatch = trimmedSql.match(USE_SCHEMA_QUERY);
        if (useSchemaMatch) {
            await this.useSchema(useSchemaMatch[2]);
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        const useWarehouseMatch = trimmedSql.match(USE_WAREHOUSE_QUERY);
        if (useWarehouseMatch) {
            await this.useWarehouse(useWarehouseMatch[2]);
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        const useRoleMatch = trimmedSql.match(USE_ROLE_QUERY);
        if (useRoleMatch) {
            await this.useRole(useRoleMatch[2]);
            return { columns: [], rows: [], recordsAffected: -1 };
        }

        const connection = this.requireConnection();
        return new Promise<SnowflakeExecutionResult>((resolve, reject) => {
            const statement = connection.execute({
                sqlText: stripTrailingSemicolons(trimmedSql),
                complete: (
                    error: Error | undefined,
                    completedStatement: SnowflakeResultStatementLike,
                    rows: SnowflakeRow[] | undefined,
                ) => {
                    if (error) {
                        reject(error instanceof Error ? error : new Error(String(error)));
                        return;
                    }

                    const normalizedRows = Array.isArray(rows) ? rows : [];
                    const statementColumns = hasResultStatementCapabilities(completedStatement)
                        ? completedStatement.getColumns?.()
                        : undefined;
                    const columns = buildColumnDefinitions(statementColumns, normalizedRows);
                    resolve({
                        columns,
                        rows: normalizeRows(normalizedRows, columns),
                        recordsAffected: hasResultStatementCapabilities(completedStatement)
                            ? (completedStatement.getNumUpdatedRows?.() ?? -1)
                            : -1,
                    });
                },
            });

            onStatement?.(statement);
        });
    }
}

class SnowflakeCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _statement?: SnowflakeStatementLike;

    public constructor(
        private readonly _connection: SnowflakeConnection,
        private readonly _sql: string,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        const result = await this._connection.executeSql(this._sql, (statement) => {
            this._statement = statement;
        });
        this._recordsAffected = result.recordsAffected;
        return createReader(result);
    }

    public async execute(): Promise<void> {
        const result = await this._connection.executeSql(this._sql, (statement) => {
            this._statement = statement;
        });
        this._recordsAffected = result.recordsAffected;
    }

    public async cancel(): Promise<void> {
        const statement = this._statement;
        if (!statement?.cancel) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            statement.cancel?.((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }
}
