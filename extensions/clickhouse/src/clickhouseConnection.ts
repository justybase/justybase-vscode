import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import { createClient, type ClickHouseClient, type Row } from '@clickhouse/client';
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
    getOptionNumber,
    getOptionString,
    stripTrailingSemicolons,
} from '../../../src/core/connectionUtils';

type ClickHouseRow = Row<unknown, 'JSONCompactEachRowWithNamesAndTypes'>;
type ClickHouseRowStream = AsyncIterable<ReadonlyArray<ClickHouseRow>>;

const CLICKHOUSE_DEFAULT_PORT = 8123;
const CLICKHOUSE_STREAM_QUEUE_LIMIT = 128;
const CLICKHOUSE_CLIENT_APPLICATION = 'JustyBase ClickHouse';

interface BufferedColumn {
    name: string;
    typeName: string;
}

function normalizeError(error: unknown, cancelled = false): Error {
    if (cancelled || (error instanceof Error && error.name === 'AbortError')) {
        return new Error('Query cancelled.', { cause: error instanceof Error ? error : undefined });
    }

    return error instanceof Error ? error : new Error(String(error));
}

function normalizeIdentifier(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
        return trimmed.slice(1, -1).replace(/``/g, '`');
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }

    return trimmed;
}

function normalizeValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('base64');
    }
    return value;
}

function createBufferedReader(
    rows: readonly Record<string, unknown>[],
    columns: readonly BufferedColumn[],
): DatabaseDataReader {
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
            return columns[index]?.typeName ?? 'String';
        },
        getValue(index: number): unknown {
            if (rowIndex < 0) {
                return undefined;
            }
            return rows[rowIndex]?.[columns[index]?.name ?? ''];
        },
    };
}

/**
 * Adapts the ClickHouse client's row-batched async stream to the row-oriented
 * DatabaseDataReader contract used by the editor. The queue is deliberately
 * bounded: when the editor is slower than HTTP delivery, the async iterator
 * stops pulling from the response stream and lets Node apply backpressure.
 */
export class ClickHouseStreamingDataReader implements DatabaseDataReader {
    private readonly rows: unknown[][] = [];
    private readonly waiters: Array<() => void> = [];
    private readonly spaceWaiters: Array<() => void> = [];
    private readonly readyPromise: Promise<void>;
    private readyResolve!: () => void;
    private readyReject!: (error: Error) => void;
    private headersReady = false;
    private headerRowsSeen = 0;
    private columns: BufferedColumn[] = [];
    private currentRow: unknown[] | undefined;
    private ended = false;
    private closed = false;
    private streamError: Error | undefined;
    private closeNotified = false;

    public constructor(
        private readonly stream: ClickHouseRowStream,
        private readonly resultSet: { close(): void },
        private readonly onClose: () => void = () => undefined,
    ) {
        this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        void this.pump();
    }

    public async ready(): Promise<void> {
        await this.readyPromise;
    }

    public get fieldCount(): number {
        return this.columns.length;
    }

    public async read(): Promise<boolean> {
        if (this.closed) {
            return false;
        }

        while (!this.closed) {
            if (this.streamError) {
                throw this.streamError;
            }

            const row = this.rows.shift();
            if (row) {
                this.currentRow = row;
                this.wakeOne(this.spaceWaiters);
                return true;
            }

            if (this.ended) {
                this.currentRow = undefined;
                return false;
            }

            await new Promise<void>((resolve) => this.waiters.push(resolve));
        }

        this.currentRow = undefined;
        return false;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.ended = true;
        this.currentRow = undefined;
        this.resultSet.close();
        this.wakeAll(this.waiters);
        this.wakeAll(this.spaceWaiters);
        if (!this.headersReady) {
            this.readyReject(new Error('Query cancelled.'));
        }
        this.notifyClose();
    }

    public getName(index: number): string {
        return this.columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this.columns[index]?.typeName ?? 'String';
    }

    public getValue(index: number): unknown {
        return normalizeValue(this.currentRow?.[index]);
    }

    private async pump(): Promise<void> {
        try {
            for await (const batch of this.stream) {
                for (const row of batch) {
                    const values = this.readRowValues(row);
                    if (this.headerRowsSeen === 0) {
                        this.columns = values.map((value, index) => ({
                            name: String(value ?? `COLUMN_${index + 1}`),
                            typeName: 'String',
                        }));
                        this.headerRowsSeen = 1;
                        continue;
                    }

                    if (this.headerRowsSeen === 1) {
                        for (let index = 0; index < this.columns.length; index += 1) {
                            this.columns[index].typeName = String(values[index] ?? 'String');
                        }
                        this.headerRowsSeen = 2;
                        this.headersReady = true;
                        this.readyResolve();
                        this.wakeAll(this.waiters);
                        continue;
                    }

                    while (!this.closed && this.rows.length >= CLICKHOUSE_STREAM_QUEUE_LIMIT) {
                        await new Promise<void>((resolve) => this.spaceWaiters.push(resolve));
                    }
                    if (this.closed) {
                        return;
                    }

                    this.rows.push(values);
                    this.wakeOne(this.waiters);
                }
            }

            this.ended = true;
            if (!this.headersReady) {
                this.headersReady = true;
                this.readyResolve();
            }
            this.wakeAll(this.waiters);
            this.notifyClose();
        } catch (error) {
            if (this.closed) {
                return;
            }
            this.streamError = normalizeError(error);
            this.ended = true;
            if (!this.headersReady) {
                this.readyReject(this.streamError);
            }
            this.wakeAll(this.waiters);
            this.notifyClose();
        }
    }

    private readRowValues(row: ClickHouseRow): unknown[] {
        const values = row.json<unknown>();
        if (Array.isArray(values)) {
            return values.map(normalizeValue);
        }
        if (values && typeof values === 'object') {
            return Object.values(values as Record<string, unknown>).map(normalizeValue);
        }
        return [normalizeValue(values)];
    }

    private wakeOne(waiters: Array<() => void>): void {
        waiters.shift()?.();
    }

    private wakeAll(waiters: Array<() => void>): void {
        const pending = waiters.splice(0);
        for (const resolve of pending) {
            resolve();
        }
    }

    private notifyClose(): void {
        if (this.closeNotified) {
            return;
        }
        this.closeNotified = true;
        this.onClose();
    }
}

function resolveProtocol(config: DatabaseConnectionConfig): 'http' | 'https' {
    const explicitHost = config.host.trim();
    if (/^https:\/\//i.test(explicitHost)) {
        return 'https';
    }
    if (/^http:\/\//i.test(explicitHost)) {
        return 'http';
    }

    const protocol = getOptionString(config, 'protocol')?.toLowerCase();
    return protocol === 'https' ? 'https' : 'http';
}

function buildClientUrl(config: DatabaseConnectionConfig): URL {
    const host = config.host.trim();
    const protocol = resolveProtocol(config);
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `${protocol}://${host}`);
    if (!url.port) {
        url.port = String(config.port ?? CLICKHOUSE_DEFAULT_PORT);
    }
    return url;
}

function isTlsWithoutVerification(config: DatabaseConnectionConfig, url: URL): boolean {
    if (url.protocol !== 'https:') {
        return false;
    }
    return getOptionString(config, 'tlsMode')?.toLowerCase() === 'require';
}

function createClickHouseClient(config: DatabaseConnectionConfig, database: string): ClickHouseClient {
    const url = buildClientUrl(config);
    const clientConfig: Parameters<typeof createClient>[0] = {
        url,
        username: config.user,
        password: config.password ?? '',
        database,
        application: CLICKHOUSE_CLIENT_APPLICATION,
        request_timeout: getOptionNumber(config, 'requestTimeout') ?? 30_000,
        ...(isTlsWithoutVerification(config, url)
            ? { http_agent: new https.Agent({ rejectUnauthorized: false }) }
            : {}),
    };
    return createClient(clientConfig);
}

function isCompatibilityQuery(sql: string, pattern: RegExp): boolean {
    return pattern.test(stripTrailingSemicolons(sql));
}

function makeQueryId(): string {
    return `justybase_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class ClickHouseConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private client?: ClickHouseClient;
    private activeCommand?: ClickHouseCommand;
    private activeController?: AbortController;
    private currentDatabase = '';
    private readonly currentSid: number;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this.currentSid = Math.abs(hashConnectionIdentity(config)) || 1;
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const database = this.config.database?.trim() || 'default';
        const client = createClickHouseClient(this.config, database);
        try {
            const ping = await client.ping({ select: true });
            if (!ping.success) {
                throw ping.error;
            }
        } catch (error) {
            await client.close().catch(() => undefined);
            throw normalizeError(error);
        }

        this.client = client;
        this.currentDatabase = database;
        this._connected = true;
        this.emit('connect');
    }

    public async close(): Promise<void> {
        this.activeController?.abort();
        await this.activeCommand?.closeReader();
        this.activeCommand = undefined;
        this.activeController = undefined;

        const client = this.client;
        this.client = undefined;
        this._connected = false;
        this.currentDatabase = '';
        if (client) {
            await client.close();
        }
        this.emit('close');
    }

    public createCommand(sql: string): DatabaseCommand {
        return new ClickHouseCommand(this, sql);
    }

    public getCurrentDatabase(): string {
        return this.currentDatabase || this.config.database || 'default';
    }

    public getCurrentSid(): number {
        return this.currentSid;
    }

    public async setCurrentDatabase(database: string): Promise<void> {
        const normalized = normalizeIdentifier(database);
        if (!normalized) {
            throw new Error('ClickHouse database name cannot be empty.');
        }

        this.requireClient();
        if (this.activeController) {
            throw new Error('Cannot change the ClickHouse database while a query is running.');
        }
        if (normalized === this.getCurrentDatabase()) {
            return;
        }

        const nextClient = createClickHouseClient(this.config, normalized);
        try {
            const ping = await nextClient.ping({ select: true });
            if (!ping.success) {
                throw ping.error;
            }
        } catch (error) {
            await nextClient.close().catch(() => undefined);
            throw normalizeError(error);
        }

        const previousClient = this.client;
        this.client = nextClient;
        this.currentDatabase = normalized;
        if (previousClient) {
            await previousClient.close();
        }
    }

    public async runCommand(
        sql: string,
        controller: AbortController,
        queryId: string,
    ): Promise<{ summary?: { written_rows?: string } }> {
        const client = this.requireClient();
        this.activeController = controller;
        try {
            const result = await client.command({
                query: stripTrailingSemicolons(sql),
                abort_signal: controller.signal,
                query_id: queryId,
            });
            return result;
        } finally {
            if (this.activeController === controller) {
                this.activeController = undefined;
            }
        }
    }

    public async runQuery(
        sql: string,
        controller: AbortController,
        queryId: string,
        onReaderClose: () => void,
    ): Promise<ClickHouseStreamingDataReader> {
        const client = this.requireClient();
        this.activeController = controller;
        try {
            const result = await client.query({
                query: stripTrailingSemicolons(sql),
                format: 'JSONCompactEachRowWithNamesAndTypes',
                abort_signal: controller.signal,
                query_id: queryId,
            });
            const reader = new ClickHouseStreamingDataReader(
                result.stream(),
                result,
                () => {
                    if (this.activeController === controller) {
                        this.activeController = undefined;
                    }
                    onReaderClose();
                },
            );
            await reader.ready();
            return reader;
        } catch (error) {
            throw normalizeError(error, controller.signal.aborted);
        }
    }

    public registerCommand(command: ClickHouseCommand, controller: AbortController): void {
        this.activeCommand = command;
        this.activeController = controller;
    }

    public clearCommand(command: ClickHouseCommand): void {
        if (this.activeCommand === command) {
            this.activeCommand = undefined;
            this.activeController = undefined;
        }
    }

    public async cancelActiveCommand(): Promise<void> {
        this.activeController?.abort();
        await this.activeCommand?.closeReader();
    }

    public requireClient(): ClickHouseClient {
        if (!this.client || !this._connected) {
            throw new Error('ClickHouse connection is not open.');
        }
        return this.client;
    }
}

class ClickHouseCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = 0;
    private cancelled = false;
    private reader?: ClickHouseStreamingDataReader;
    private controller?: AbortController;
    private timeoutHandle?: ReturnType<typeof setTimeout>;

    public constructor(
        private readonly connection: ClickHouseConnection,
        private readonly sqlText: string,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this.cancelled) {
            throw new Error('Query cancelled.');
        }

        const sql = stripTrailingSemicolons(this.sqlText);
        const compatibilityReader = this.tryCompatibilityReader(sql);
        if (compatibilityReader) {
            return compatibilityReader;
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this.connection.setCurrentDatabase(setCatalogMatch[1]);
            return createBufferedReader([], []);
        }

        const controller = new AbortController();
        this.controller = controller;
        this.connection.registerCommand(this, controller);
        this.startTimeout();
        try {
            this.reader = await this.connection.runQuery(sql, controller, makeQueryId(), () => {
                this.clearExecutionState();
            });
            if (this.cancelled) {
                await this.reader.close();
                throw new Error('Query cancelled.');
            }
            return this.reader;
        } catch (error) {
            this.clearExecutionState();
            throw normalizeError(error, this.cancelled || controller.signal.aborted);
        }
    }

    public async execute(): Promise<void> {
        if (this.cancelled) {
            throw new Error('Query cancelled.');
        }

        const sql = stripTrailingSemicolons(this.sqlText);
        const compatibilityReader = this.tryCompatibilityReader(sql);
        if (compatibilityReader) {
            await compatibilityReader.close();
            return;
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this.connection.setCurrentDatabase(setCatalogMatch[1]);
            return;
        }

        const controller = new AbortController();
        this.controller = controller;
        this.connection.registerCommand(this, controller);
        this.startTimeout();
        try {
            const result = await this.connection.runCommand(sql, controller, makeQueryId());
            const writtenRows = Number(result.summary?.written_rows ?? 0);
            this._recordsAffected = Number.isFinite(writtenRows) ? writtenRows : 0;
        } catch (error) {
            throw normalizeError(error, this.cancelled || controller.signal.aborted);
        } finally {
            this.clearExecutionState();
        }
    }

    public async cancel(): Promise<void> {
        this.cancelled = true;
        this.controller?.abort();
        await this.reader?.close();
        await this.connection.cancelActiveCommand();
        this.clearExecutionState();
    }

    public async closeReader(): Promise<void> {
        await this.reader?.close();
    }

    private startTimeout(): void {
        if (this.commandTimeout <= 0) {
            return;
        }
        this.timeoutHandle = setTimeout(() => {
            void this.cancel();
        }, Math.round(this.commandTimeout * 1000));
    }

    private clearExecutionState(): void {
        if (this.timeoutHandle) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = undefined;
        }
        this.connection.clearCommand(this);
        this.controller = undefined;
    }

    private tryCompatibilityReader(sql: string): DatabaseDataReader | undefined {
        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)) {
            const database = this.connection.getCurrentDatabase();
            return createBufferedReader(
                [{ CURRENT_CATALOG: database, CURRENT_SCHEMA: database }],
                [
                    { name: 'CURRENT_CATALOG', typeName: 'String' },
                    { name: 'CURRENT_SCHEMA', typeName: 'String' },
                ],
            );
        }
        if (isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)) {
            return createBufferedReader(
                [{ CURRENT_CATALOG: this.connection.getCurrentDatabase() }],
                [{ name: 'CURRENT_CATALOG', typeName: 'String' }],
            );
        }
        if (isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)) {
            return createBufferedReader(
                [{ CURRENT_SCHEMA: this.connection.getCurrentDatabase() }],
                [{ name: 'CURRENT_SCHEMA', typeName: 'String' }],
            );
        }
        if (isCompatibilityQuery(sql, CURRENT_SID_QUERY)) {
            return createBufferedReader(
                [{ CURRENT_SID: this.connection.getCurrentSid() }],
                [{ name: 'CURRENT_SID', typeName: 'Int64' }],
            );
        }
        return undefined;
    }
}

function hashConnectionIdentity(config: DatabaseConnectionConfig): number {
    const value = `${config.host}:${config.port ?? CLICKHOUSE_DEFAULT_PORT}/${config.database}/${config.user}`;
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return hash;
}
