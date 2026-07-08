import * as path from 'path';
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
    getOptionString,
    stripTrailingSemicolons
} from '../../../src/core/connectionUtils';
import { formatIdentifierForSql } from '../../../src/utils/identifierUtils';
import type { DuckDBConnection as DuckDbRuntimeConnection, DuckDBInstance, DuckDBResultReader } from '@duckdb/node-api';

interface DuckDbColumnDefinition {
    name: string;
    typeName: string;
}

interface DuckDbExecutionResult {
    columns: DuckDbColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
}

interface DuckDbModule {
    DuckDBInstance: {
        create(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
        fromCache(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
    };
}

const _extensionRequire = createRequire(__filename);
let _duckdbModulePromise: Promise<DuckDbModule> | undefined;

function resolveDuckDbDatabaseLocation(config: DatabaseConnectionConfig): { databasePath?: string; useCache: boolean } {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory') {
        return { databasePath: undefined, useCache: false };
    }

    const requestedDatabase = config.database.trim();
    if (!requestedDatabase || requestedDatabase === ':memory:') {
        return { databasePath: undefined, useCache: false };
    }

    return {
        databasePath: path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase),
        useCache: true
    };
}

function inferDuckDbCatalogName(config: DatabaseConnectionConfig): string {
    const mode = typeof config.options?.mode === 'string' ? config.options.mode.trim().toLowerCase() : undefined;
    if (mode === 'memory' || config.database.trim() === ':memory:') {
        return 'memory';
    }

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
            return columns[index]?.typeName ?? '';
        },
        getValue(index: number): unknown {
            if (rowIndex < 0) {
                return undefined;
            }
            return rows[rowIndex]?.[index];
        }
    };
}

function normalizeDuckDbReader(result: DuckDBResultReader): DuckDbExecutionResult {
    const rows = result.getRowsJS();
    const columns: DuckDbColumnDefinition[] = Array.from({ length: result.columnCount }, (_, index) => ({
        name: result.columnName(index),
        typeName: result.columnType(index).toString()
    }));

    return {
        columns,
        rows,
        recordsAffected: result.rowsChanged
    };
}

function normalizeDuckDbIdentifier(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1).replace(/""/g, '"').replace(/''/g, '\'');
    }
    return trimmed;
}

function formatDuckDbUseTarget(target: string): string {
    return target
        .split('.')
        .map(part => formatIdentifierForSql(normalizeDuckDbIdentifier(part), 'duckdb'))
        .join('.');
}

function isCompatibilityQuery(sql: string, pattern: RegExp): boolean {
    return pattern.test(stripTrailingSemicolons(sql));
}

function isUseStatement(sql: string): boolean {
    return /^USE\b/i.test(sql.trim());
}

async function loadDuckDb(): Promise<DuckDbModule> {
    if (!_duckdbModulePromise) {
        _duckdbModulePromise = Promise.resolve()
            .then(() => _extensionRequire('@duckdb/node-api') as DuckDbModule)
            .catch(error => {
                _duckdbModulePromise = undefined;
                throw new Error(
                    'DuckDB runtime dependency "@duckdb/node-api" is not installed. ' +
                    'Run "npm install" inside extensions/duckdb before using or packaging this extension.',
                    { cause: error }
                );
            });
    }

    return _duckdbModulePromise;
}

export class DuckDbConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _instance?: DuckDBInstance;
    private _connection?: DuckDbRuntimeConnection;
    private _currentCatalog = '';
    private _currentSchema = 'main';
    private readonly _sessionId = `duckdb-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    private readonly _databaseLocation: { databasePath?: string; useCache: boolean };

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._databaseLocation = resolveDuckDbDatabaseLocation(config);
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const duckdb = await loadDuckDb();
        const instance = this._databaseLocation.useCache
            ? await duckdb.DuckDBInstance.fromCache(this._databaseLocation.databasePath)
            : await duckdb.DuckDBInstance.create(this._databaseLocation.databasePath);

        try {
            const connection = await instance.connect();
            this._instance = instance;
            this._connection = connection;
            this._connected = true;

            const schema = getOptionString(this.config, 'schema');
            if (schema) {
                await connection.run(`USE ${formatIdentifierForSql(schema, 'duckdb')}`);
            }

            await this.refreshSessionContext();
        } catch (error) {
            try {
                instance.closeSync();
            } catch {
                // Ignore cleanup failures while surfacing the original connection error.
            }
            this._instance = undefined;
            this._connection = undefined;
            this._connected = false;
            throw new Error(`Failed to connect to DuckDB database: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }

    public async close(): Promise<void> {
        const connection = this._connection;
        const instance = this._instance;
        const shouldCloseInstance = !this._databaseLocation.useCache;

        this._connection = undefined;
        this._instance = undefined;
        this._connected = false;
        this._currentCatalog = '';
        this._currentSchema = 'main';

        if (connection) {
            connection.disconnectSync();
        }

        if (instance && shouldCloseInstance) {
            instance.closeSync();
        }

        this.emit('close');
    }

    public createCommand(sql: string): DatabaseCommand {
        return new DuckDbCommand(this, sql);
    }

    public getCurrentCatalog(): string {
        return this._currentCatalog || inferDuckDbCatalogName(this.config);
    }

    public getCurrentSchema(): string {
        return this._currentSchema || getOptionString(this.config, 'schema') || 'main';
    }

    public getCurrentSid(): string {
        return this._sessionId;
    }

    public async executeSql(sql: string): Promise<DuckDbExecutionResult> {
        const connection = this.requireConnection();
        const result = normalizeDuckDbReader(await connection.runAndReadAll(sql));
        if (isUseStatement(sql)) {
            await this.refreshSessionContext();
        }
        return result;
    }

    public async executeStatement(sql: string): Promise<number> {
        const connection = this.requireConnection();
        const result = await connection.run(sql);
        if (isUseStatement(sql)) {
            await this.refreshSessionContext();
        }
        return result.rowsChanged;
    }

    public async setCurrentCatalog(catalog: string): Promise<void> {
        const normalizedCatalog = catalog.trim();
        if (!normalizedCatalog) {
            throw new Error('DuckDB catalog name cannot be empty.');
        }

        await this.requireConnection().run(`USE ${formatDuckDbUseTarget(normalizedCatalog)}`);
        await this.refreshSessionContext();
    }

    public async cancelActiveCommand(): Promise<void> {
        this._connection?.interrupt();
    }

    private requireConnection(): DuckDbRuntimeConnection {
        if (!this._connection) {
            throw new Error('DuckDB connection is not open.');
        }

        return this._connection;
    }

    private async refreshSessionContext(): Promise<void> {
        const reader = await this.requireConnection().runAndReadAll(
            'SELECT current_catalog() AS CURRENT_CATALOG, current_schema() AS CURRENT_SCHEMA'
        );
        const row = reader.getRowObjectsJS()[0];
        this._currentCatalog = typeof row?.CURRENT_CATALOG === 'string' && row.CURRENT_CATALOG.trim().length > 0
            ? row.CURRENT_CATALOG.trim()
            : inferDuckDbCatalogName(this.config);
        this._currentSchema = typeof row?.CURRENT_SCHEMA === 'string' && row.CURRENT_SCHEMA.trim().length > 0
            ? row.CURRENT_SCHEMA.trim()
            : 'main';
    }
}

class DuckDbCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = 0;
    private _cancelled = false;

    public constructor(
        private readonly _connection: DuckDbConnection,
        private readonly _sql: string
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const sql = stripTrailingSemicolons(this._sql);

        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)) {
            return createReader(
                [
                    { name: 'CURRENT_CATALOG', typeName: 'VARCHAR' },
                    { name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' }
                ],
                [[this._connection.getCurrentCatalog(), this._connection.getCurrentSchema()]]
            );
        }

        if (isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)) {
            return createReader([{ name: 'CURRENT_CATALOG', typeName: 'VARCHAR' }], [[this._connection.getCurrentCatalog()]]);
        }

        if (isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)) {
            return createReader([{ name: 'CURRENT_SCHEMA', typeName: 'VARCHAR' }], [[this._connection.getCurrentSchema()]]);
        }

        if (isCompatibilityQuery(sql, CURRENT_SID_QUERY)) {
            return createReader([{ name: 'CURRENT_SID', typeName: 'VARCHAR' }], [[this._connection.getCurrentSid()]]);
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this._connection.setCurrentCatalog(setCatalogMatch[1]);
            return createReader([], []);
        }

        const result = await this._connection.executeSql(sql);
        this._recordsAffected = result.recordsAffected;
        return createReader(result.columns, result.rows);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        await this._connection.cancelActiveCommand();
    }

    public async execute(): Promise<void> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const sql = stripTrailingSemicolons(this._sql);

        if (
            isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)
            || isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)
            || isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)
            || isCompatibilityQuery(sql, CURRENT_SID_QUERY)
        ) {
            return undefined;
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this._connection.setCurrentCatalog(setCatalogMatch[1]);
            return undefined;
        }

        this._recordsAffected = await this._connection.executeStatement(sql);
        return undefined;
    }
}
