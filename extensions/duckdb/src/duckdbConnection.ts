import * as path from 'path';
import { EventEmitter } from 'events';
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
    getOptionString,
    stripTrailingSemicolons
} from '../../../src/core/connectionUtils';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import {
    createDuckDbModuleResolver,
    DuckDbSession,
    type DuckDbConnection as DuckDbRuntimeConnection,
    type DuckDbInstance,
    type DuckDbModule,
    type DuckDbModuleResolver,
    type DuckDbResultReader
} from '@justybase/duckdb-runtime';

interface DuckDbColumnDefinition {
    name: string;
    typeName: string;
}

interface DuckDbExecutionResult {
    columns: DuckDbColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

export type { DuckDbModule };

const _duckdbResolver: DuckDbModuleResolver = createDuckDbModuleResolver({
    resolveFrom: __filename,
    missingDependencyMessage: 'DuckDB runtime dependency "@duckdb/node-api" is not installed. Run "npm install" inside extensions/duckdb before using or packaging this extension.'
});

function resolveDuckDbDatabaseLocation(config: DatabaseConnectionConfig): { databasePath?: string; useCache: boolean } {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory') return { databasePath: undefined, useCache: false };
    const requestedDatabase = config.database.trim();
    if (!requestedDatabase || requestedDatabase === ':memory:') return { databasePath: undefined, useCache: false };
    return {
        databasePath: path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase),
        useCache: true
    };
}

function inferDuckDbCatalogName(config: DatabaseConnectionConfig): string {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory' || config.database.trim() === ':memory:') return 'memory';
    const normalizedDatabase = config.database.trim();
    const parsed = path.win32.parse(normalizedDatabase);
    return parsed.name || parsed.base || normalizedDatabase || 'memory';
}

function createReader(columns: readonly DuckDbColumnDefinition[], rows: readonly unknown[][]): DatabaseDataReader {
    let rowIndex = -1;
    return {
        fieldCount: columns.length,
        async read(): Promise<boolean> {
            const nextIndex = rowIndex + 1;
            if (nextIndex >= rows.length) return false;
            rowIndex = nextIndex;
            return true;
        },
        async nextResult(): Promise<boolean> { return false; },
        async close(): Promise<void> { return undefined; },
        getName(index: number): string { return columns[index]?.name ?? ''; },
        getTypeName(index: number): string { return columns[index]?.typeName ?? ''; },
        getValue(index: number): unknown { return rowIndex < 0 ? undefined : rows[rowIndex]?.[index]; }
    };
}

function normalizeDuckDbReader(result: DuckDbResultReader): DuckDbExecutionResult {
    const rows = result.getRowsJS();
    const columns: DuckDbColumnDefinition[] = Array.from({ length: result.columnCount }, (_, index) => ({
        name: result.columnName(index),
        typeName: result.columnType(index).toString()
    }));
    return { columns, rows, recordsAffected: Number(result.rowsChanged ?? 0) };
}

function normalizeDuckDbIdentifier(value: string): string {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
        return trimmed.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
    }
    return trimmed;
}

function formatDuckDbUseTarget(target: string): string {
    return target.split('.').map(part => formatIdentifierForSql(normalizeDuckDbIdentifier(part), 'duckdb')).join('.');
}

function isCompatibilityQuery(sql: string, pattern: RegExp): boolean {
    return pattern.test(stripTrailingSemicolons(sql));
}

function isUseStatement(sql: string): boolean { return /^USE\b/i.test(sql.trim()); }

export async function loadDuckDb(): Promise<DuckDbModule> {
    return _duckdbResolver.load();
}

export class DuckDbConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    protected _instance?: DuckDbInstance;
    protected _connection?: DuckDbRuntimeConnection;
    protected _session?: DuckDbSession;
    private _currentCatalog = '';
    private _currentSchema = 'main';
    private readonly _sessionId = `duckdb-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    private readonly _databaseLocation: { databasePath?: string; useCache: boolean };
    /**
     * Native executions in flight, in FIFO order. DuckDB serializes queries on
     * one connection, so the head entry's command is the command currently
     * interrupted by `session.interrupt()`. Keyed by execution promise
     * identity so concurrent executions on the same command object are each
     * tracked for draining (commands are typically single-flight, but this
     * must not lose the first promise if reused).
     */
    private readonly _executing = new Map<Promise<unknown>, DatabaseCommand>();

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._databaseLocation = resolveDuckDbDatabaseLocation(config);
    }

    public async connect(): Promise<void> {
        if (this._connected) return;
        const session = new DuckDbSession({
            databasePath: this._databaseLocation.databasePath,
            instanceOwnership: this._databaseLocation.useCache ? 'cached-file' : 'owned-memory',
            resolver: _duckdbResolver,
        });
        try {
            await session.connect();
            this._session = session;
            this._instance = session.nativeInstance;
            this._connection = session.nativeConnection;
            this._connected = true;
            const schema = getOptionString(this.config, 'schema');
            if (schema) await this._connection.run(`USE ${formatIdentifierForSql(schema, 'duckdb')}`);
            await this.initializeAfterConnect();
            await this.refreshSessionContext();
        } catch (error) {
            try { session.close(); } catch { /* preserve connection error */ }
            this._session = undefined;
            this._instance = undefined;
            this._connection = undefined;
            this._connected = false;
            throw new Error(`Failed to connect to DuckDB database: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }

    public async close(): Promise<void> {
        const session = this._session;
        // Invalidate first so executions racing close() fail requireSession()
        // instead of registering after the drain snapshot.
        this._connected = false;
        if (session && this._executing.size > 0) {
            // Drain in-flight commands before closing the native connection so
            // a pending query cannot hang or corrupt the close.
            try {
                await this.cancelActiveCommand();
            } catch {
                // Preserve the close path; cancellation failure must not skip draining.
            }
            await Promise.allSettled([...this._executing.keys()]);
        }
        this._session = undefined;
        this._connection = undefined;
        this._instance = undefined;
        this._currentCatalog = '';
        this._currentSchema = 'main';
        if (session) session.close();
        this.emit('close');
    }

    public createCommand(sql: string): DatabaseCommand { return new DuckDbCommand(this, sql); }
    public getCurrentCatalog(): string { return this._currentCatalog || inferDuckDbCatalogName(this.config); }
    public getCurrentSchema(): string { return this._currentSchema || getOptionString(this.config, 'schema') || 'main'; }
    public getCurrentSid(): string { return this._sessionId; }

    public async executeSql(sql: string, command?: DatabaseCommand): Promise<DuckDbExecutionResult> {
        const execution = command
            ? this.trackExecution(command, this.requireSession().runAndReadAll(sql))
            : this.requireSession().runAndReadAll(sql);
        const result = normalizeDuckDbReader(await execution);
        if (isUseStatement(sql)) await this.refreshSessionContext();
        return result;
    }

    public async executeStatement(sql: string, command?: DatabaseCommand): Promise<number> {
        const execution = command
            ? this.trackExecution(command, this.requireSession().run(sql))
            : this.requireSession().run(sql);
        const result = await execution;
        if (isUseStatement(sql)) await this.refreshSessionContext();
        return Number(result.rowsChanged ?? 0);
    }

    private trackExecution<T>(command: DatabaseCommand, execution: Promise<T>): Promise<T> {
        const key = execution as Promise<unknown>;
        this._executing.set(key, command);
        return execution.finally(() => {
            this._executing.delete(key);
        });
    }

    public async setCurrentCatalog(catalog: string): Promise<void> {
        const normalizedCatalog = catalog.trim();
        if (!normalizedCatalog) throw new Error('DuckDB catalog name cannot be empty.');
        await this.requireSession().run(`USE ${formatDuckDbUseTarget(normalizedCatalog)}`);
        await this.refreshSessionContext();
    }

    public async cancelActiveCommand(command?: DatabaseCommand): Promise<void> {
        if (command) {
            const head = this._executing.values().next().value as DatabaseCommand | undefined;
            if (head !== command) return; // Stale handle: never interrupt a newer command.
        }
        this._session?.interrupt();
    }

    protected requireConnection(): DuckDbRuntimeConnection { return this.requireSession().nativeConnection; }
    protected requireSession(): DuckDbSession {
        if (!this._session || !this._connected) throw new Error('DuckDB connection is not open.');
        return this._session;
    }
    protected async initializeAfterConnect(): Promise<void> { return undefined; }

    protected async refreshSessionContext(): Promise<void> {
        const reader = await this.requireSession().runAndReadAll('SELECT current_catalog() AS CURRENT_CATALOG, current_schema() AS CURRENT_SCHEMA');
        const row = reader.getRowObjectsJS?.()[0];
        this._currentCatalog = typeof row?.CURRENT_CATALOG === 'string' && row.CURRENT_CATALOG.trim().length > 0 ? row.CURRENT_CATALOG.trim() : inferDuckDbCatalogName(this.config);
        this._currentSchema = typeof row?.CURRENT_SCHEMA === 'string' && row.CURRENT_SCHEMA.trim().length > 0 ? row.CURRENT_SCHEMA.trim() : 'main';
    }
}

class DuckDbCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = 0;
    private _cancelled = false;

    public constructor(private readonly _connection: DuckDbConnection, private readonly _sql: string) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) throw new Error('Query cancelled.');
        const sql = stripTrailingSemicolons(this._sql);
        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)) return createReader([{ name: 'CURRENT_CATALOG', typeName: 'VARCHAR' }, { name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' }], [[this._connection.getCurrentCatalog(), this._connection.getCurrentSchema()]]);
        if (isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)) return createReader([{ name: 'CURRENT_CATALOG', typeName: 'VARCHAR' }], [[this._connection.getCurrentCatalog()]]);
        if (isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)) return createReader([{ name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' }], [[this._connection.getCurrentSchema()]]);
        if (isCompatibilityQuery(sql, CURRENT_SID_QUERY)) return createReader([{ name: 'CURRENT_SID', typeName: 'VARCHAR' }], [[this._connection.getCurrentSid()]]);
        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) { await this._connection.setCurrentCatalog(setCatalogMatch[1]); return createReader([], []); }
        const result = await this._connection.executeSql(sql, this);
        this._recordsAffected = result.recordsAffected;
        return createReader(result.columns, result.rows);
    }

    public async cancel(): Promise<void> { this._cancelled = true; await this._connection.cancelActiveCommand(this); }

    public async execute(): Promise<void> {
        if (this._cancelled) throw new Error('Query cancelled.');
        const sql = stripTrailingSemicolons(this._sql);
        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY) || isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY) || isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY) || isCompatibilityQuery(sql, CURRENT_SID_QUERY)) return;
        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) { await this._connection.setCurrentCatalog(setCatalogMatch[1]); return; }
        this._recordsAffected = await this._connection.executeStatement(sql, this);
    }
}
