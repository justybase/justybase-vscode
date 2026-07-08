import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
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
    getErrorMessage,
    getOptionString,
    normalizeCatalogIdentifier,
    stripTrailingSemicolons,
} from '../../../src/core/connectionUtils';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';

interface VerticaClientConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    tls_mode?: string;
    tls_trusted_certs?: string;
    client_label?: string;
    workload?: string;
}

interface VerticaField {
    name?: string;
}

interface VerticaQueryResult {
    rows?: Array<Record<string, unknown> | unknown[]>;
    fields?: VerticaField[];
    rowCount?: number;
}

interface VerticaRuntimeClient {
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string): Promise<VerticaQueryResult>;
    on(event: string, listener: (arg?: unknown) => void): void;
    removeListener(event: string, listener: (arg?: unknown) => void): void;
}

interface VerticaModule {
    Client: new(config: VerticaClientConfig) => VerticaRuntimeClient;
}

interface VerticaColumnDefinition {
    name: string;
    typeName: string;
}

interface VerticaExecutionResult {
    columns: VerticaColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

const DROP_SESSION_QUERY = /^DROP\s+SESSION\s+(.+?)\s*;?$/i;
const _extensionRequire = createRequire(__filename);
let _verticaModulePromise: Promise<VerticaModule> | undefined;

function inferTypeName(value: unknown): string {
    if (value == null) {
        return 'VARCHAR';
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'DOUBLE PRECISION';
    }
    if (typeof value === 'boolean') {
        return 'BOOLEAN';
    }
    if (value instanceof Date) {
        return 'TIMESTAMP';
    }
    if (Buffer.isBuffer(value)) {
        return 'VARBINARY';
    }
    return 'VARCHAR';
}

function buildColumns(rows: readonly Record<string, unknown>[], fields: readonly VerticaField[] | undefined): VerticaColumnDefinition[] {
    const fieldNames = (fields ?? [])
        .map((field) => field.name?.trim())
        .filter((name): name is string => Boolean(name));

    const columnNames = fieldNames.length > 0 ? fieldNames : Object.keys(rows[0] ?? {});
    return columnNames.map((name) => ({
        name,
        typeName: inferTypeName(rows.find((row) => row[name] != null)?.[name]),
    }));
}

function normalizeRows(rows: readonly (Record<string, unknown> | unknown[])[], columns: readonly VerticaColumnDefinition[]): unknown[][] {
    return rows.map((row) => {
        if (Array.isArray(row)) {
            return [...row];
        }

        return columns.map((column) => row[column.name]);
    });
}

function isRecordsAffectedCommand(sql: string): boolean {
    return /^\s*(INSERT|UPDATE|DELETE|MERGE|COPY|CREATE|ALTER|DROP|TRUNCATE|SET|COMMIT|ROLLBACK|BEGIN|SELECT\s+CLOSE_SESSION|SELECT\s+PURGE_TABLE|SELECT\s+ANALYZE_STATISTICS)\b/i.test(sql);
}

function createReader(columns: readonly VerticaColumnDefinition[], rows: readonly unknown[][]): DatabaseDataReader {
    let rowIndex = -1;

    return {
        fieldCount: columns.length,
        async read(): Promise<boolean> {
            const nextIndex = rowIndex + 1;
            if (nextIndex >= rows.length) {
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
            return columns[index]?.name ?? '';
        },
        getTypeName(index: number): string {
            return columns[index]?.typeName ?? 'VARCHAR';
        },
        getValue(index: number): unknown {
            if (rowIndex < 0) {
                return undefined;
            }
            return rows[rowIndex]?.[index];
        },
    };
}

function generateClientLabel(): string {
    return `justybase-vertica-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function unwrapQuotedIdentifier(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
}

function buildSearchPathSql(searchPath: string): string | undefined {
    const parts = searchPath
        .split(',')
        .map((part) => unwrapQuotedIdentifier(part))
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => formatIdentifierForSql(part, 'vertica'));

    if (parts.length === 0) {
        return undefined;
    }

    return `SET SEARCH_PATH TO ${parts.join(', ')}`;
}

function buildClientConfig(config: DatabaseConnectionConfig, clientLabel: string): VerticaClientConfig {
    const tlsMode = getOptionString(config, 'tlsMode');
    const trustedCertsPath = getOptionString(config, 'trustedCertsPath');
    const workload = getOptionString(config, 'workload');

    const clientConfig: VerticaClientConfig = {
        host: config.host,
        port: config.port ?? 5433,
        database: config.database,
        user: config.user,
        password: config.password,
        client_label: clientLabel,
    };

    if (tlsMode) {
        clientConfig.tls_mode = tlsMode;
    }
    if (trustedCertsPath) {
        clientConfig.tls_trusted_certs = trustedCertsPath;
    }
    if (workload) {
        clientConfig.workload = workload;
    }

    return clientConfig;
}

async function loadVertica(): Promise<VerticaModule> {
    if (!_verticaModulePromise) {
        _verticaModulePromise = Promise.resolve()
            .then(() => _extensionRequire('vertica-nodejs') as VerticaModule)
            .catch((error) => {
                _verticaModulePromise = undefined;
                throw new Error(
                    'Vertica runtime dependency "vertica-nodejs" is not installed. ' +
                        'Run "npm install" inside extensions/vertica before using or packaging this extension.',
                    { cause: error },
                );
            });
    }

    return _verticaModulePromise;
}

export class VerticaConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _client?: VerticaRuntimeClient;
    private _currentDatabase = '';
    private _currentSchema = 'public';
    private _currentSessionId = '';
    private _clientLabel = '';

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const vertica = await loadVertica();
        this._clientLabel = getOptionString(this.config, 'clientLabel') ?? generateClientLabel();
        const client = new vertica.Client(buildClientConfig(this.config, this._clientLabel));

        client.on('error', (error) => this.emit('error', error));
        client.on('notice', (notice) => this.emit('notice', notice));
        client.on('end', () => this.emit('end'));
        client.on('close', () => this.emit('close'));

        await client.connect();

        this._client = client;
        this._connected = true;
        this._currentDatabase = this.config.database;

        const searchPathSql = buildSearchPathSql(getOptionString(this.config, 'searchPath') ?? '');
        if (searchPathSql) {
            await client.query(searchPathSql);
        }

        try {
            const currentInfo = await client.query('SELECT CURRENT_SCHEMA() AS CURRENT_SCHEMA');
            const row = currentInfo.rows?.[0];
            if (row && !Array.isArray(row) && typeof row.CURRENT_SCHEMA === 'string' && row.CURRENT_SCHEMA.trim().length > 0) {
                this._currentSchema = row.CURRENT_SCHEMA.trim();
            } else if (searchPathSql) {
                this._currentSchema = unwrapQuotedIdentifier((getOptionString(this.config, 'searchPath') ?? '').split(',')[0] ?? 'public') || 'public';
            }
        } catch {
            if (searchPathSql) {
                this._currentSchema = unwrapQuotedIdentifier((getOptionString(this.config, 'searchPath') ?? '').split(',')[0] ?? 'public') || 'public';
            }
        }

        this._currentSessionId = await this.resolveCurrentSessionId().catch(() => '');
    }

    public async close(): Promise<void> {
        const client = this._client;
        this._client = undefined;
        this._connected = false;
        this._currentSessionId = '';
        this._currentSchema = 'public';
        this._currentDatabase = this.config.database;

        if (!client) {
            return;
        }

        await client.end();
    }

    public createCommand(sql: string): DatabaseCommand {
        return new VerticaCommand(this, sql);
    }

    public getCurrentDatabase(): string {
        return this._currentDatabase || this.config.database;
    }

    public getCurrentSchema(): string {
        return this._currentSchema || 'public';
    }

    public getCurrentSessionId(): string {
        return this._currentSessionId;
    }

    public async executeSql(sql: string): Promise<VerticaExecutionResult> {
        const client = this.requireClient();
        const rawResult = await client.query(sql);
        const rawRows = Array.isArray(rawResult.rows) ? rawResult.rows : [];
        const normalizedRecordRows = rawRows.filter((row): row is Record<string, unknown> => !!row && !Array.isArray(row) && typeof row === 'object');
        const columns = buildColumns(normalizedRecordRows, rawResult.fields);
        const rows = normalizeRows(rawRows as (Record<string, unknown> | unknown[])[], columns);
        const recordsAffected = typeof rawResult.rowCount === 'number'
            ? rawResult.rowCount
            : isRecordsAffectedCommand(sql)
                ? 0
                : -1;
        return { columns, rows, recordsAffected };
    }

    public async terminateSession(sessionId: string): Promise<boolean> {
        const normalizedSessionId = sessionId.trim();
        if (!normalizedSessionId) {
            return false;
        }

        const vertica = await loadVertica();
        const adminClient = new vertica.Client(buildClientConfig(this.config, `${this._clientLabel}-cancel`));
        await adminClient.connect();
        try {
            await adminClient.query(`SELECT CLOSE_SESSION('${normalizedSessionId.replace(/'/g, "''")}');`);
            return true;
        } finally {
            await adminClient.end();
        }
    }

    private requireClient(): VerticaRuntimeClient {
        if (!this._client) {
            throw new Error('Vertica connection is not open.');
        }
        return this._client;
    }

    private async resolveCurrentSessionId(): Promise<string> {
        const client = this.requireClient();
        const result = await client.query(`
            SELECT SESSION_ID
            FROM V_MONITOR.SESSIONS
            WHERE CLIENT_LABEL = '${this._clientLabel.replace(/'/g, "''")}'
            ORDER BY LOGIN_TIMESTAMP DESC
            LIMIT 1
        `);
        const row = result.rows?.[0];
        if (row && !Array.isArray(row) && typeof row.SESSION_ID === 'string' && row.SESSION_ID.trim().length > 0) {
            return row.SESSION_ID.trim();
        }
        return '';
    }
}

class VerticaCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;

    public constructor(
        private readonly _connection: VerticaConnection,
        private readonly _sql: string,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        const result = await this.executeQuery();
        this._recordsAffected = result.recordsAffected;
        return createReader(result.columns, result.rows);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        const sessionId = this._connection.getCurrentSessionId();
        if (sessionId) {
            await this._connection.terminateSession(sessionId).catch(() => undefined);
        }
        await this._connection.close().catch(() => undefined);
    }

    public async execute(): Promise<void> {
        const result = await this.executeQuery();
        this._recordsAffected = result.recordsAffected;
    }

    private async executeQuery(): Promise<VerticaExecutionResult> {
        const trimmedSql = stripTrailingSemicolons(this._sql);
        const compatibility = await this.tryExecuteCompatibilityCommand(trimmedSql);
        if (compatibility) {
            return compatibility;
        }

        try {
            return await this.executeWithOptionalTimeout(() => this._connection.executeSql(trimmedSql));
        } catch (error) {
            if (this._cancelled) {
                throw new Error('Query cancelled.', { cause: error });
            }
            const message = getErrorMessage(error).toLowerCase();
            if (message.includes('close_session') || message.includes('socket') || message.includes('connection closed')) {
                throw new Error('Query cancelled.', { cause: error });
            }
            throw error;
        }
    }

    private async executeWithOptionalTimeout<T>(task: () => Promise<T>): Promise<T> {
        if (!Number.isFinite(this.commandTimeout) || this.commandTimeout <= 0) {
            return task();
        }

        return new Promise<T>((resolve, reject) => {
            let settled = false;
            const timeoutHandle = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                void this.cancel();
                reject(new Error(`Query timeout exceeded after ${this.commandTimeout} seconds.`));
            }, this.commandTimeout * 1000);

            task()
                .then((result) => {
                    clearTimeout(timeoutHandle);
                    if (!settled) {
                        settled = true;
                        resolve(result);
                    }
                })
                .catch((error) => {
                    clearTimeout(timeoutHandle);
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
        });
    }

    private async tryExecuteCompatibilityCommand(trimmedSql: string): Promise<VerticaExecutionResult | undefined> {
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                columns: [
                    { name: 'CURRENT_CATALOG', typeName: 'VARCHAR' },
                    { name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' },
                ],
                rows: [[this._connection.getCurrentDatabase(), this._connection.getCurrentSchema()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_CATALOG_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_CATALOG', typeName: 'VARCHAR' }],
                rows: [[this._connection.getCurrentDatabase()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' }],
                rows: [[this._connection.getCurrentSchema()]],
                recordsAffected: -1,
            };
        }

        if (CURRENT_SID_QUERY.test(trimmedSql)) {
            return {
                columns: [{ name: 'CURRENT_SID', typeName: 'VARCHAR' }],
                rows: [[this._connection.getCurrentSessionId() || null]],
                recordsAffected: -1,
            };
        }

        const dropSessionMatch = trimmedSql.match(DROP_SESSION_QUERY);
        if (dropSessionMatch) {
            const requestedSessionId = dropSessionMatch[1].trim().replace(/^['"]|['"]$/g, '');
            const terminated = await this._connection.terminateSession(requestedSessionId);
            if (!terminated) {
                throw new Error(`Failed to terminate Vertica session ${requestedSessionId}.`);
            }
            return {
                columns: [{ name: 'TERMINATED', typeName: 'BOOLEAN' }],
                rows: [[true]],
                recordsAffected: 0,
            };
        }

        const setCatalogMatch = trimmedSql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            const requestedDatabase = normalizeCatalogIdentifier(setCatalogMatch[1]);
            const currentDatabase = this._connection.getCurrentDatabase();
            if (requestedDatabase.toUpperCase() !== currentDatabase.toUpperCase()) {
                throw new Error(
                    'Vertica connections are database-scoped. Open a connection for the target database instead of using SET CATALOG.',
                );
            }
            return {
                columns: [],
                rows: [],
                recordsAffected: 0,
            };
        }

        return undefined;
    }
}
