import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
import type { Readable } from 'stream';
import type { Client, ClientConfig, ClientNotice, FieldDef, QueryResult as PgQueryResult } from 'pg';
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
    getErrorMessage,
    getOptionNumber as getNumberOption,
    getOptionString as getStringOption,
    normalizeCatalogIdentifier,
    stripTrailingSemicolons
} from '../../../src/core/connectionUtils';

interface PostgreSqlColumnDefinition {
    name: string;
    typeName: string;
}

interface PostgreSqlResultSet {
    columns: PostgreSqlColumnDefinition[];
    rows: unknown[][];
}

interface PostgreSqlExecutionResult {
    resultSets: PostgreSqlResultSet[];
    recordsAffected: number;
}

type PgModule = typeof import('pg');
type PgProtocolSerialize = typeof import('pg-protocol')['serialize'];

const DROP_SESSION_QUERY = /^DROP\s+SESSION\s+(\d+)\s*$/i;
const COPY_FROM_STDIN_QUERY = /^\s*COPY\b[\s\S]+\bFROM\s+STDIN\b/i;
const COPY_IMPORT_STREAM_MARKER = /\/\*\s*JBL_IMPORT_STREAM:([A-Za-z0-9._-]+)\s*\*\/$/i;

const _extensionRequire = createRequire(__filename);
let _pgModulePromise: Promise<PgModule> | undefined;
let _pgInternalQueryPromise: Promise<PgInternalQueryConstructor> | undefined;
let _pgProtocolSerializePromise: Promise<PgProtocolSerialize> | undefined;
let _typeNameByOid: Map<number, string> | undefined;

interface PgCopyProtocolConnection {
    stream: {
        write(buffer: Buffer): boolean;
        once(eventName: string, listener: () => void): void;
    };
    sendCopyFail(message: string): void;
}

interface PgInternalQuery {
    callback?: (error: Error | null, result?: unknown) => void;
    binary?: boolean;
    query_timeout?: number;
    _result?: { _types?: unknown };
    submit(connection: PgCopyProtocolConnection): Error | null;
    handleError(error: Error, connection: PgCopyProtocolConnection): void;
    handleReadyForQuery(connection: PgCopyProtocolConnection): void;
    handleCommandComplete?(msg: unknown, connection: PgCopyProtocolConnection): void;
    handleRowDescription?(msg: unknown): void;
    handleDataRow?(msg: unknown): void;
    handlePortalSuspended?(connection: PgCopyProtocolConnection): void;
    handleEmptyQuery?(connection: PgCopyProtocolConnection): void;
    handleCopyInResponse(connection: PgCopyProtocolConnection): void;
    handleCopyData(msg: unknown, connection: PgCopyProtocolConnection): void;
}

interface PgClientWithInternalQuery {
    query(query: PgInternalQuery): void;
}

interface CopyImportRequest {
    sql: string;
    streamName: string;
}

type PgInternalQueryConstructor = new (config: string | { text: string }) => PgInternalQuery;

function normalizeCopyChunk(chunk: string | Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }

    return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
}

function resolveCopyImportRequest(sql: string): CopyImportRequest | undefined {
    if (!COPY_FROM_STDIN_QUERY.test(sql)) {
        return undefined;
    }

    const match = sql.match(COPY_IMPORT_STREAM_MARKER);
    if (!match) {
        return undefined;
    }

    return {
        sql: sql.replace(COPY_IMPORT_STREAM_MARKER, '').trim(),
        streamName: match[1]
    };
}

function buildClientConfig(config: DatabaseConnectionConfig): ClientConfig {
    const sslMode = getStringOption(config, 'sslMode');
    const connectTimeout = getNumberOption(config, 'connectTimeout');

    const clientConfig: ClientConfig = {
        host: config.host,
        port: config.port ?? 5432,
        database: config.database,
        user: config.user,
        password: config.password,
        application_name: 'JustyBase PostgreSQL'
    };

    if (sslMode === 'require') {
        clientConfig.ssl = { rejectUnauthorized: false };
    } else if (sslMode === 'verify-full') {
        clientConfig.ssl = { rejectUnauthorized: true };
    }

    if (connectTimeout !== undefined && connectTimeout > 0) {
        clientConfig.connectionTimeoutMillis = Math.round(connectTimeout * 1000);
    }

    return clientConfig;
}

function isRecordsAffectedCommand(command: string | undefined): boolean {
    const normalized = command?.trim().toUpperCase();
    return normalized === 'INSERT'
        || normalized === 'UPDATE'
        || normalized === 'DELETE'
        || normalized === 'MERGE'
        || normalized === 'COPY'
        || normalized === 'MOVE';
}

function isQueryCancellationError(error: unknown): boolean {
    const message = getErrorMessage(error).toLowerCase();
    return message.includes('canceling statement due to user request')
        || message.includes('terminating connection due to administrator command')
        || message.includes('query cancelled');
}

function normalizeQueryError(error: unknown, cancelled: boolean): Error {
    if (cancelled || isQueryCancellationError(error)) {
        return new Error('Query cancelled.', { cause: error instanceof Error ? error : undefined });
    }

    return error instanceof Error ? error : new Error(String(error));
}

function getFirstRowValue(row: unknown): unknown {
    if (Array.isArray(row)) {
        return row[0];
    }

    if (row && typeof row === 'object') {
        const values = Object.values(row as Record<string, unknown>);
        return values[0];
    }

    return row;
}

function getBooleanResult(row: unknown): boolean {
    const value = getFirstRowValue(row);
    return value === true || value === 1 || value === '1' || value === 't';
}

function getTypeNameByOid(pg: PgModule, oid: number): string {
    if (!_typeNameByOid) {
        _typeNameByOid = new Map<number, string>();
        for (const [name, value] of Object.entries(pg.types?.builtins ?? {})) {
            if (typeof value === 'number') {
                _typeNameByOid.set(value, name);
            }
        }
    }

    return _typeNameByOid.get(oid) ?? String(oid);
}

function buildColumnDefinitions(pg: PgModule, fields: readonly FieldDef[]): PostgreSqlColumnDefinition[] {
    return fields.map(field => ({
        name: field.name,
        typeName: getTypeNameByOid(pg, field.dataTypeID)
    }));
}

function normalizeRows(rows: readonly unknown[], columns: readonly PostgreSqlColumnDefinition[]): unknown[][] {
    return rows.map(row => {
        if (Array.isArray(row)) {
            return [...row];
        }

        if (row && typeof row === 'object') {
            const record = row as Record<string, unknown>;
            return columns.map(column => record[column.name]);
        }

        return columns.length > 0 ? [row] : [];
    });
}

function normalizeQueryResults(
    pg: PgModule,
    rawResult: PgQueryResult<Record<string, unknown> | unknown[]> | PgQueryResult<Record<string, unknown> | unknown[]>[]
): PostgreSqlResultSet[] {
    const resultSets = Array.isArray(rawResult) ? rawResult : [rawResult];
    return resultSets.map(result => {
        const columns = buildColumnDefinitions(pg, result.fields ?? []);
        return {
            columns,
            rows: normalizeRows(result.rows ?? [], columns)
        };
    });
}

function resolveRecordsAffected(
    rawResult: PgQueryResult<Record<string, unknown> | unknown[]> | PgQueryResult<Record<string, unknown> | unknown[]>[]
): number {
    const resultSets = Array.isArray(rawResult) ? rawResult : [rawResult];
    for (let index = resultSets.length - 1; index >= 0; index--) {
        const rowCount = resultSets[index]?.rowCount;
        if (typeof rowCount === 'number' && isRecordsAffectedCommand(resultSets[index]?.command)) {
            return rowCount;
        }
    }

    return -1;
}

async function loadPg(): Promise<PgModule> {
    if (!_pgModulePromise) {
        _pgModulePromise = Promise.resolve()
            .then(() => _extensionRequire('pg') as PgModule)
            .catch(error => {
                _pgModulePromise = undefined;
                throw new Error(
                    'PostgreSQL runtime dependency "pg" is not installed. ' +
                    'Run "npm install" inside extensions/postgresql before using or packaging this extension.',
                    { cause: error }
                );
            });
    }

    return _pgModulePromise;
}

async function loadPgInternalQueryConstructor(): Promise<PgInternalQueryConstructor> {
    if (!_pgInternalQueryPromise) {
        _pgInternalQueryPromise = Promise.resolve()
            .then(() => _extensionRequire('pg/lib/query') as PgInternalQueryConstructor)
            .catch(error => {
                _pgInternalQueryPromise = undefined;
                throw new Error(
                    'PostgreSQL internal query runtime "pg/lib/query" is not available. ' +
                    'Ensure the optional PostgreSQL extension dependencies are installed.',
                    { cause: error }
                );
            });
    }

    return _pgInternalQueryPromise;
}

async function loadPgProtocolSerialize(): Promise<PgProtocolSerialize> {
    if (!_pgProtocolSerializePromise) {
        _pgProtocolSerializePromise = Promise.resolve()
            .then(() => (_extensionRequire('pg-protocol') as { serialize: PgProtocolSerialize }).serialize)
            .catch(error => {
                _pgProtocolSerializePromise = undefined;
                throw new Error(
                    'PostgreSQL protocol serializer "pg-protocol" is not available. ' +
                    'Ensure the optional PostgreSQL extension dependencies are installed.',
                    { cause: error }
                );
            });
    }

    return _pgProtocolSerializePromise;
}

// pg Connection.sendCopyFromChunk()/endCopyFrom() delegate to _send(), which returns the socket
// backpressure signal, but the public wrappers drop that boolean. Write serialized COPY frames
// through the live stream directly so large imports can still respect drain/backpressure.
async function writeCopyBuffer(connection: PgCopyProtocolConnection, buffer: Buffer): Promise<void> {
    if (!connection.stream.write(buffer)) {
        await new Promise<void>(resolve => connection.stream.once('drain', resolve));
    }
}

async function pipeCopySourceStream(
    sourceStream: Readable,
    connection: PgCopyProtocolConnection,
    serialize: PgProtocolSerialize
): Promise<void> {
    for await (const chunk of sourceStream) {
        await writeCopyBuffer(connection, serialize.copyData(normalizeCopyChunk(chunk as string | Buffer | Uint8Array)));
    }

    await writeCopyBuffer(connection, serialize.copyDone());
}

// pg exposes COPY protocol hooks on its internal Query implementation even though it does not
// provide a first-class public COPY API. We patch the live Query instance so we keep every
// internal handler the pg client expects while only overriding the COPY source-stream hook.
function createPostgreSqlCopyFromQuery(
    queryConstructor: PgInternalQueryConstructor,
    sql: string,
    sourceStream: Readable,
    serialize: PgProtocolSerialize
): PgInternalQuery {
    const copyQuery = new queryConstructor(sql);
    copyQuery.handleCopyInResponse = (connection: PgCopyProtocolConnection): void => {
        void pipeCopySourceStream(sourceStream, connection, serialize).catch(error => {
            connection.sendCopyFail(getErrorMessage(error));
        });
    };

    return copyQuery;
}

class PostgreSqlDataReader implements DatabaseDataReader {
    private _resultSetIndex = 0;
    private _rowIndex = -1;

    public constructor(private readonly _resultSets: readonly PostgreSqlResultSet[]) {}

    public get fieldCount(): number {
        return this._resultSets[this._resultSetIndex]?.columns.length ?? 0;
    }

    public async read(): Promise<boolean> {
        const currentRows = this._resultSets[this._resultSetIndex]?.rows ?? [];
        const nextIndex = this._rowIndex + 1;
        if (nextIndex >= currentRows.length) {
            return false;
        }

        this._rowIndex = nextIndex;
        return true;
    }

    public async nextResult(): Promise<boolean> {
        const nextResultIndex = this._resultSetIndex + 1;
        if (nextResultIndex >= this._resultSets.length) {
            return false;
        }

        this._resultSetIndex = nextResultIndex;
        this._rowIndex = -1;
        return true;
    }

    public async close(): Promise<void> {
        return undefined;
    }

    public getName(index: number): string {
        return this._resultSets[this._resultSetIndex]?.columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._resultSets[this._resultSetIndex]?.columns[index]?.typeName ?? '';
    }

    public getValue(index: number): unknown {
        if (this._rowIndex < 0) {
            return undefined;
        }

        return this._resultSets[this._resultSetIndex]?.rows[this._rowIndex]?.[index];
    }
}

export class PostgreSqlConnection extends EventEmitter implements DatabaseConnection {
    private static readonly _importStreams = new Map<string, Readable>();
    public _connected = false;
    private _client?: Client;
    private _backendPid?: number;
    private _currentSchema?: string;
    private _activeCommand?: PostgreSqlCommand;
    private readonly _clientConfig: ClientConfig;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._clientConfig = buildClientConfig(config);
    }

    public static registerImportStream(name: string, stream: unknown): void {
        if (!(stream instanceof EventEmitter) || typeof (stream as Readable).pipe !== 'function') {
            throw new Error('PostgreSQL import stream must be a readable stream.');
        }

        PostgreSqlConnection._importStreams.set(name, stream as Readable);
    }

    public static unregisterImportStream(name: string): void {
        PostgreSqlConnection._importStreams.delete(name);
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const pg = await loadPg();
        const client = new pg.Client(this._clientConfig);
        client.on('notice', (notice: ClientNotice | unknown) => this.emit('notice', notice));
        client.on('error', (error: Error | unknown) => this.emit('error', error));
        client.on('end', () => {
            this._connected = false;
            this._client = undefined;
            this._backendPid = undefined;
            this._currentSchema = undefined;
            this.emit('end', undefined);
        });

        try {
            await client.connect();
            this._client = client;
            this._connected = true;
            await this.applySessionOptions();
            this._currentSchema = await this.readCurrentSchema();
            this._backendPid = await this.readBackendPid();
        } catch (error) {
            try {
                await client.end();
            } catch {
                // Best-effort cleanup after a failed connect.
            }
            this._client = undefined;
            this._connected = false;
            this._backendPid = undefined;
            this._currentSchema = undefined;
            throw new Error(`Failed to connect to PostgreSQL: ${getErrorMessage(error)}`, {
                cause: error
            });
        }
    }

    public async close(): Promise<void> {
        const client = this._client;
        this._client = undefined;
        this._backendPid = undefined;
        this._currentSchema = undefined;
        this._activeCommand = undefined;
        this._connected = false;

        if (!client) {
            return;
        }

        try {
            await client.end();
        } catch {
            // Connection may already be terminated after pg_terminate_backend.
        }
    }

    public createCommand(sql: string): DatabaseCommand {
        return new PostgreSqlCommand(this, sql);
    }

    public async executeCopyFromStream(sql: string, streamName: string): Promise<number> {
        const sourceStream = PostgreSqlConnection._importStreams.get(streamName);
        if (!sourceStream) {
            throw new Error(`No PostgreSQL import stream registered as "${streamName}".`);
        }

        const [queryConstructor, serialize] = await Promise.all([
            loadPgInternalQueryConstructor(),
            loadPgProtocolSerialize()
        ]);
        const client = this.getClient() as unknown as PgClientWithInternalQuery;

        return await new Promise<number>((resolve, reject) => {
            const copyQuery = createPostgreSqlCopyFromQuery(queryConstructor, sql, sourceStream, serialize);
            copyQuery.callback = (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }

                const rowCount = (result as { rowCount?: unknown } | undefined)?.rowCount;
                resolve(typeof rowCount === 'number' ? rowCount : -1);
            };

            try {
                client.query(copyQuery);
            } catch (error) {
                reject(error);
            }
        });
    }

    public getClient(): Client {
        if (!this._client) {
            throw new Error('PostgreSQL connection is not open.');
        }

        return this._client;
    }

    public getCurrentDatabaseName(): string {
        return this.config.database;
    }

    public getCurrentSchemaName(): string {
        return this._currentSchema || 'public';
    }

    public async ensureBackendPid(): Promise<number | undefined> {
        if (this._backendPid !== undefined) {
            return this._backendPid;
        }

        this._backendPid = await this.readBackendPid();
        return this._backendPid;
    }

    public beginCommand(command: PostgreSqlCommand): void {
        if (this._activeCommand && this._activeCommand !== command) {
            throw new Error('Connection is already executing a command');
        }

        this._activeCommand = command;
    }

    public endCommand(command: PostgreSqlCommand): void {
        if (this._activeCommand === command) {
            this._activeCommand = undefined;
        }
    }

    public async cancelBackend(processId: number): Promise<boolean> {
        const pg = await loadPg();
        const adminClient = new pg.Client(this._clientConfig);
        await adminClient.connect();
        try {
            const result = await adminClient.query('SELECT pg_catalog.pg_cancel_backend($1) AS cancelled', [processId]);
            return getBooleanResult(result.rows[0]);
        } finally {
            try {
                await adminClient.end();
            } catch {
                // Ignore cleanup failures on the helper connection.
            }
        }
    }

    public async terminateBackend(processId: number): Promise<boolean> {
        const pg = await loadPg();
        const adminClient = new pg.Client(this._clientConfig);
        await adminClient.connect();
        try {
            const result = await adminClient.query('SELECT pg_catalog.pg_terminate_backend($1) AS terminated', [processId]);
            return getBooleanResult(result.rows[0]);
        } finally {
            try {
                await adminClient.end();
            } catch {
                // Ignore cleanup failures on the helper connection.
            }
        }
    }

    private async applySessionOptions(): Promise<void> {
        const client = this.getClient();
        const searchPath = getStringOption(this.config, 'searchPath');
        const statementTimeout = getNumberOption(this.config, 'statementTimeout');

        if (searchPath) {
            await client.query('SELECT pg_catalog.set_config($1, $2, false)', ['search_path', searchPath]);
        }

        if (statementTimeout !== undefined && statementTimeout > 0) {
            await client.query('SELECT pg_catalog.set_config($1, $2, false)', [
                'statement_timeout',
                String(Math.round(statementTimeout * 1000))
            ]);
        }
    }

    private async readBackendPid(): Promise<number | undefined> {
        const result = await this.getClient().query({
            text: 'SELECT pg_backend_pid() AS CURRENT_SID',
            rowMode: 'array'
        });
        const normalizedResult = Array.isArray(result) ? result[0] : result;
        const firstRow = normalizedResult.rows[0];
        const rawPid = Array.isArray(firstRow)
            ? firstRow[0]
            : firstRow && typeof firstRow === 'object'
                ? Object.values(firstRow as Record<string, unknown>)[0]
                : undefined;
        return typeof rawPid === 'number' ? rawPid : undefined;
    }

    private async readCurrentSchema(): Promise<string | undefined> {
        const result = await this.getClient().query({
            text: 'SELECT current_schema() AS CURRENT_SCHEMA',
            rowMode: 'array'
        });
        const normalizedResult = Array.isArray(result) ? result[0] : result;
        const rawSchema = getFirstRowValue(normalizedResult.rows[0]);
        return typeof rawSchema === 'string' && rawSchema.trim().length > 0 ? rawSchema : undefined;
    }
}

class PostgreSqlCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;
    private _cancelInFlightPromise: Promise<void> | undefined;

    public constructor(
        private readonly _connection: PostgreSqlConnection,
        private readonly _sql: string
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        const result = await this.executeInternal();
        this._recordsAffected = result.recordsAffected;
        return new PostgreSqlDataReader(result.resultSets);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;

        if (this._cancelInFlightPromise) {
            await this._cancelInFlightPromise;
            return;
        }

        const backendPid = await this._connection.ensureBackendPid();
        if (backendPid === undefined) {
            return;
        }

        this._cancelInFlightPromise = this._connection.cancelBackend(backendPid)
            .then(() => undefined, () => undefined)
            .finally(() => {
                this._cancelInFlightPromise = undefined;
            });

        await this._cancelInFlightPromise;
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }

    private async executeInternal(): Promise<PostgreSqlExecutionResult> {
        const trimmedSql = stripTrailingSemicolons(this._sql);
        if (!trimmedSql) {
            return {
                resultSets: [{
                    columns: [],
                    rows: []
                }],
                recordsAffected: 0
            };
        }

        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        this._connection.beginCommand(this);
        try {
            return await this.runWithTimeout(async () => {
                const compatibilityResult = await this.tryExecuteCompatibilityCommand(trimmedSql);
                if (compatibilityResult) {
                    return compatibilityResult;
                }

                const copyImportRequest = resolveCopyImportRequest(trimmedSql);
                if (copyImportRequest) {
                    return {
                        resultSets: [{
                            columns: [],
                            rows: []
                        }],
                        recordsAffected: await this._connection.executeCopyFromStream(
                            copyImportRequest.sql,
                            copyImportRequest.streamName
                        )
                    };
                }

                const pg = await loadPg();
                const rawResult = await this._connection.getClient().query({
                    text: trimmedSql,
                    rowMode: 'array',
                    queryMode: 'simple'
                });

                return {
                    resultSets: normalizeQueryResults(pg, rawResult),
                    recordsAffected: resolveRecordsAffected(rawResult)
                };
            });
        } catch (error) {
            throw normalizeQueryError(error, this._cancelled);
        } finally {
            this._connection.endCommand(this);
        }
    }

    private async runWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
        if (!(this.commandTimeout > 0)) {
            return operation();
        }

        return await new Promise<T>((resolve, reject) => {
            let settled = false;
            const timeoutHandle = setTimeout(() => {
                void this.cancel();
                if (!settled) {
                    settled = true;
                    reject(new Error(`Query timed out after ${this.commandTimeout}s`));
                }
            }, Math.round(this.commandTimeout * 1000));

            operation()
                .then(result => {
                    clearTimeout(timeoutHandle);
                    if (!settled) {
                        settled = true;
                        resolve(result);
                    }
                })
                .catch(error => {
                    clearTimeout(timeoutHandle);
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
        });
    }

    private async tryExecuteCompatibilityCommand(trimmedSql: string): Promise<PostgreSqlExecutionResult | undefined> {
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                resultSets: [{
                    columns: [
                        { name: 'CURRENT_CATALOG', typeName: 'TEXT' },
                        { name: 'CURRENT_SCHEMA', typeName: 'TEXT' }
                    ],
                    rows: [[this._connection.getCurrentDatabaseName(), this._connection.getCurrentSchemaName()]]
                }],
                recordsAffected: -1
            };
        }

        if (CURRENT_CATALOG_QUERY.test(trimmedSql)) {
            return {
                resultSets: [{
                    columns: [{ name: 'CURRENT_CATALOG', typeName: 'TEXT' }],
                    rows: [[this._connection.getCurrentDatabaseName()]]
                }],
                recordsAffected: -1
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(trimmedSql)) {
            return {
                resultSets: [{
                    columns: [{ name: 'CURRENT_SCHEMA', typeName: 'TEXT' }],
                    rows: [[this._connection.getCurrentSchemaName()]]
                }],
                recordsAffected: -1
            };
        }

        if (CURRENT_SID_QUERY.test(trimmedSql)) {
            const backendPid = await this._connection.ensureBackendPid();
            return {
                resultSets: [{
                    columns: [{ name: 'CURRENT_SID', typeName: 'INTEGER' }],
                    rows: [[backendPid ?? null]]
                }],
                recordsAffected: -1
            };
        }

        const dropSessionMatch = trimmedSql.match(DROP_SESSION_QUERY);
        if (dropSessionMatch) {
            const processId = Number(dropSessionMatch[1]);
            const terminated = await this._connection.terminateBackend(processId);
            if (!terminated) {
                throw new Error(`Failed to terminate PostgreSQL backend ${processId}.`);
            }

            return {
                resultSets: [{
                    columns: [{ name: 'TERMINATED', typeName: 'BOOLEAN' }],
                    rows: [[true]]
                }],
                recordsAffected: 0
            };
        }

        const setCatalogMatch = trimmedSql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            const requestedDatabase = normalizeCatalogIdentifier(setCatalogMatch[1]);
            const currentDatabase = this._connection.getCurrentDatabaseName();
            if (requestedDatabase.toUpperCase() !== currentDatabase.toUpperCase()) {
                throw new Error(
                    'PostgreSQL connections are database-scoped. Open a connection for the target database instead of using SET CATALOG.'
                );
            }

            return {
                resultSets: [{
                    columns: [],
                    rows: []
                }],
                recordsAffected: 0
            };
        }

        return undefined;
    }
}
