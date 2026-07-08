import * as path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader
} from '../../contracts/database';

interface SqliteColumnDefinition {
    name: string;
    typeName: string;
}

interface SqliteExecutionResult {
    columns: SqliteColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

type SqliteModule = typeof import('node:sqlite');

const CURRENT_CATALOG_QUERY = /^SELECT\s+CURRENT_CATALOG\s*;?$/i;
const CURRENT_SCHEMA_QUERY = /^SELECT\s+CURRENT_SCHEMA\s*;?$/i;
const CURRENT_CATALOG_AND_SCHEMA_QUERY = /^SELECT\s+CURRENT_CATALOG\s*,\s*CURRENT_SCHEMA\s*;?$/i;
const CURRENT_SID_QUERY = /^SELECT\s+CURRENT_SID\s*;?$/i;
const SET_CATALOG_QUERY = /^SET\s+CATALOG\s+(.+?)\s*;?$/i;

type SqliteStatementColumn = ReturnType<StatementSync['columns']>[number];

let _sqliteModule: SqliteModule | undefined;

function loadSqliteModule(): SqliteModule {
    if (_sqliteModule) {
        return _sqliteModule;
    }

    try {
        const nativeRequire = createRequire(__filename);
        _sqliteModule = nativeRequire('node:sqlite') as SqliteModule;
        return _sqliteModule;
    } catch (error) {
        throw new Error(
            'SQLite runtime dependency "node:sqlite" is unavailable. Use a Node.js runtime that includes the built-in sqlite module.',
            { cause: error }
        );
    }
}

function resolveSqliteDatabaseLocation(config: DatabaseConnectionConfig): string {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory') {
        return ':memory:';
    }

    const requestedDatabase = config.database.trim();
    if (!requestedDatabase || requestedDatabase === ':memory:') {
        return ':memory:';
    }

    return path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase);
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
    private _database?: DatabaseSync;
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
            const { DatabaseSync } = loadSqliteModule();
            this._database = new DatabaseSync(this._databaseLocation);
            this._connected = true;
        } catch (error) {
            throw new Error(`Failed to connect to SQLite database: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }

    public async close(): Promise<void> {
        if (!this._database) {
            this._connected = false;
            return;
        }

        this._database.close();
        this._database = undefined;
        this._connected = false;
    }

    public createCommand(sql: string): DatabaseCommand {
        return new SqliteCommand(this, sql);
    }

    public getDatabase(): DatabaseSync {
        if (!this._database) {
            throw new Error('SQLite connection is not open.');
        }
        return this._database;
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
        const rows = statement.all() as unknown as unknown[][];
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
