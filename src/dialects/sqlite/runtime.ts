import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader
} from '../../contracts/database';
import { SqliteSession, type SqliteDatabase } from '@justybase/sqlite-runtime';

interface SqliteColumnDefinition {
    name: string;
    typeName: string;
}

interface SqliteExecutionResult {
    columns: SqliteColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

const CURRENT_CATALOG_QUERY = /^SELECT\s+CURRENT_CATALOG\s*;?$/i;
const CURRENT_SCHEMA_QUERY = /^SELECT\s+CURRENT_SCHEMA\s*;?$/i;
const CURRENT_CATALOG_AND_SCHEMA_QUERY = /^SELECT\s+CURRENT_CATALOG\s*,\s*CURRENT_SCHEMA\s*;?$/i;
const CURRENT_SID_QUERY = /^SELECT\s+CURRENT_SID\s*;?$/i;
const SET_CATALOG_QUERY = /^SET\s+CATALOG\s+(.+?)\s*;?$/i;

type SqliteStatementColumn = ReturnType<SqliteDatabase['prepare']>['columns'] extends () => infer T
    ? T extends readonly (infer C)[] ? C : never
    : never;

function resolveSqliteDatabaseLocation(config: DatabaseConnectionConfig): string {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory') {
        return ':memory:';
    }

    let requestedDatabase = config.database.trim();
    if (!requestedDatabase || requestedDatabase === ':memory:') {
        return ':memory:';
    }

    // Tolerate file:// URIs pasted into the connection form.
    if (requestedDatabase.startsWith('file://')) {
        requestedDatabase = requestedDatabase.slice('file://'.length);
    }

    return path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase);
}

/**
 * Creates the parent directory of a file-backed SQLite database so that a
 * new database file can be created on first connect (SQLite reports
 * "unable to open database file" when the parent directory is missing).
 */
function ensureDatabaseParentDirectory(databaseLocation: string): void {
    if (databaseLocation === ':memory:') {
        return;
    }
    const parent = path.dirname(databaseLocation);
    if (parent && parent !== databaseLocation) {
        fs.mkdirSync(parent, { recursive: true });
    }
}

function normalizeCatalogIdentifier(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
    }
    return trimmed;
}

/**
 * Normalizes `readBigInts` values for the desktop result pipeline. With
 * `readBigInts: true` node:sqlite returns every INTEGER as a BigInt; safe
 * values keep their historical number type, out-of-range values become
 * strings instead of throwing RangeError on read.
 */
function normalizeValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    return value;
}

function inferColumnTypeName(rows: readonly unknown[][], index: number): string {
    for (const row of rows) {
        const value = row[index];
        if (value === null || value === undefined) {
            continue;
        }
        if (typeof value === 'bigint' || typeof value === 'number') {
            return 'INTEGER';
        }
        if (typeof value === 'string') {
            return 'TEXT';
        }
        if (typeof value === 'boolean') {
            return 'INTEGER';
        }
        if (value instanceof Uint8Array) {
            return 'BLOB';
        }
        return 'TEXT';
    }

    return '';
}

function buildColumnDefinitions(columns: readonly SqliteStatementColumn[], rows: readonly unknown[][]): SqliteColumnDefinition[] {
    return columns.map((column, index) => ({
        name: column.name,
        typeName: column.type ?? inferColumnTypeName(rows, index)
    }));
}

function isDmlStatement(sql: string): boolean {
    const normalized = sql.trim().replace(/;+\s*$/, '').toUpperCase();
    return /^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(normalized);
}

class SqliteDataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _currentIndex = -1;

    public constructor(
        private readonly _columns: readonly SqliteColumnDefinition[],
        private readonly _rows: readonly unknown[][]
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

        return this._rows[this._currentIndex]?.[index];
    }
}

export class SqliteConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _session?: SqliteSession;
    private _currentCatalog = 'main';
    private readonly _sessionId = `sqlite-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    private readonly _databaseLocation: string;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._databaseLocation = resolveSqliteDatabaseLocation(config);
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        try {
            ensureDatabaseParentDirectory(this._databaseLocation);
            // Keep 64-bit integers lossless at the node:sqlite boundary; the
            // desktop adapter normalizes them below for display.
            this._session = new SqliteSession(this._databaseLocation, { readBigInts: true });
            this._connected = true;
        } catch (error) {
            throw new Error(`Failed to connect to SQLite database: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }

    public async close(): Promise<void> {
        if (!this._session) {
            this._connected = false;
            return;
        }

        this._session.close();
        this._session = undefined;
        this._connected = false;
    }

    public createCommand(sql: string): DatabaseCommand {
        return new SqliteCommand(this, sql);
    }

    public getDatabase(): SqliteDatabase {
        if (!this._session) {
            throw new Error('SQLite connection is not open.');
        }
        return this._session.database;
    }

    public getCurrentCatalog(): string {
        return this._currentCatalog;
    }

    public getCurrentSchema(): string {
        return this._currentCatalog;
    }

    public getSessionId(): string {
        return this._sessionId;
    }

    public setCurrentCatalog(catalog: string): void {
        const trimmedCatalog = normalizeCatalogIdentifier(catalog);
        if (!trimmedCatalog) {
            throw new Error('Catalog name cannot be empty.');
        }

        const database = this.getDatabase();
        const row = database.prepare('SELECT name FROM pragma_database_list WHERE name = ?').get(trimmedCatalog) as
            | { name?: string }
            | undefined;

        if (!row?.name) {
            throw new Error(`Catalog "${trimmedCatalog}" does not exist in this SQLite connection.`);
        }

        this._currentCatalog = trimmedCatalog;
    }

    public execute(sql: string): SqliteExecutionResult {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
            return {
                columns: [],
                rows: [],
                recordsAffected: -1
            };
        }

        const pseudoResult = this.tryExecuteCompatibilityCommand(trimmedSql);
        if (pseudoResult) {
            return pseudoResult;
        }

        const database = this.getDatabase();
        const statement = database.prepare(trimmedSql);
        statement.setReturnArrays(true);
        const rows = (statement.all() as unknown as unknown[][]).map(row => row.map(normalizeValue));
        const columns = buildColumnDefinitions(statement.columns(), rows);
        const recordsAffected = isDmlStatement(trimmedSql)
            ? Number(
                (database.prepare('SELECT changes() AS changes').get() as { changes?: number } | undefined)?.changes ?? 0
            )
            : -1;

        return {
            columns,
            rows,
            recordsAffected
        };
    }

    private tryExecuteCompatibilityCommand(sql: string): SqliteExecutionResult | undefined {
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [
                    { name: 'CURRENT_CATALOG', typeName: 'TEXT' },
                    { name: 'CURRENT_SCHEMA', typeName: 'TEXT' }
                ],
                rows: [[this.getCurrentCatalog(), this.getCurrentSchema()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_CATALOG_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_CATALOG', typeName: 'TEXT' }],
                rows: [[this.getCurrentCatalog()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SCHEMA', typeName: 'TEXT' }],
                rows: [[this.getCurrentSchema()]],
                recordsAffected: -1
            };
        }

        if (CURRENT_SID_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SID', typeName: 'TEXT' }],
                rows: [[this.getSessionId()]],
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

class SqliteCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;

    public constructor(
        private readonly _connection: SqliteConnection,
        private readonly _sql: string
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const result = this._connection.execute(this._sql);
        this._recordsAffected = result.recordsAffected;
        return new SqliteDataReader(result.columns, result.rows);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}
