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
    getOptionNumber,
    stripTrailingSemicolons
} from '../../../src/core/connectionUtils';

interface MysqlQueryResultSetHeader {
    affectedRows?: number;
}

interface MysqlFieldPacket {
    name: string;
    columnType?: number;
}

interface MysqlRuntimeConnection {
    query(sql: string): Promise<[unknown, MysqlFieldPacket[]]>;
    connect(): Promise<void>;
    end(): Promise<void>;
    destroy(): void;
    on(event: 'error' | 'end' | 'close', listener: (arg?: unknown) => void): void;
    removeListener(event: 'error' | 'end' | 'close', listener: (arg?: unknown) => void): void;
}

interface MysqlPromiseModule {
    createConnection(config: {
        host: string;
        port: number;
        database: string;
        user: string;
        password?: string;
        connectTimeout?: number;
        multipleStatements?: boolean;
    }): Promise<MysqlRuntimeConnection>;
}

interface MysqlExecutionResult {
    rows: Record<string, unknown>[];
    fields: MysqlFieldPacket[];
}

const _extensionRequire = createRequire(__filename);
let _mysqlModulePromise: Promise<MysqlPromiseModule> | undefined;

function inferTypeName(value: unknown): string {
    if (value == null) {
        return 'TEXT';
    }

    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
    }

    if (typeof value === 'boolean') {
        return 'TINYINT';
    }

    if (value instanceof Date) {
        return 'DATETIME';
    }

    if (Buffer.isBuffer(value)) {
        return 'BLOB';
    }

    return 'TEXT';
}

function createReader(rows: Record<string, unknown>[], fields: MysqlFieldPacket[]): DatabaseDataReader {
    const columns = fields.length > 0
        ? fields.map((field, index) => ({
            name: field.name || `COLUMN_${index + 1}`,
            typeName: inferTypeName(rows.find(row => row[field.name] != null)?.[field.name])
        }))
        : Object.keys(rows[0] ?? {}).map(name => ({
            name,
            typeName: inferTypeName(rows.find(row => row[name] != null)?.[name])
        }));

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
            return columns[index]?.typeName ?? 'TEXT';
        },
        getValue(index: number): unknown {
            if (rowIndex < 0) {
                return undefined;
            }
            const row = rows[rowIndex];
            return row ? row[columns[index]?.name] : undefined;
        }
    };
}

async function loadMysql(): Promise<MysqlPromiseModule> {
    if (!_mysqlModulePromise) {
        _mysqlModulePromise = Promise.resolve()
            .then(() => _extensionRequire('mysql2/promise') as MysqlPromiseModule)
            .catch(error => {
                _mysqlModulePromise = undefined;
                throw new Error(
                    'MySQL runtime dependency "mysql2" is not installed. ' +
                    'Run "npm install" inside extensions/mysql before using or packaging this extension.',
                    { cause: error }
                );
            });
    }

    return _mysqlModulePromise;
}

async function queryRows(connection: MysqlRuntimeConnection, sql: string): Promise<MysqlExecutionResult> {
    const [rows, fields] = await connection.query(sql);
    if (!Array.isArray(rows)) {
        return { rows: [], fields };
    }

    return {
        rows: rows.map(row => (row && typeof row === 'object' ? { ...row as Record<string, unknown> } : { VALUE: row })),
        fields
    };
}

export class MysqlConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _connection?: MysqlRuntimeConnection;
    private _currentDatabase = '';
    private _currentSid = 0;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const mysql = await loadMysql();
        const connectTimeout = getOptionNumber(this.config, 'connectTimeout');
        const database = this.config.database?.trim() || '';
        const connection = await mysql.createConnection({
            host: this.config.host,
            port: this.config.port ?? 3306,
            database,
            user: this.config.user,
            password: this.config.password,
            connectTimeout,
            multipleStatements: false
        });

        connection.on('error', err => this.emit('error', err));
        connection.on('end', () => this.emit('end'));
        connection.on('close', () => this.emit('close'));

        this._connection = connection;
        this._connected = true;

        const current = await queryRows(connection, 'SELECT DATABASE() AS CURRENT_CATALOG, DATABASE() AS CURRENT_SCHEMA, CONNECTION_ID() AS CURRENT_SID');
        this._currentDatabase = typeof current.rows[0]?.CURRENT_CATALOG === 'string' && current.rows[0].CURRENT_CATALOG.trim().length > 0
            ? String(current.rows[0].CURRENT_CATALOG)
            : database;
        this._currentSid = Number(current.rows[0]?.CURRENT_SID ?? 0) || 0;
    }

    public async close(): Promise<void> {
        const connection = this._connection;
        this._connection = undefined;
        this._connected = false;
        this._currentDatabase = '';
        this._currentSid = 0;

        if (!connection) {
            return;
        }

        try {
            await connection.end();
        } catch {
            connection.destroy();
        }
    }

    public createCommand(sql: string): DatabaseCommand {
        return new MysqlCommand(this, sql);
    }

    private requireConnection(): MysqlRuntimeConnection {
        if (!this._connection) {
            throw new Error('MySQL connection is not open.');
        }

        return this._connection;
    }

    public getCurrentDatabase(): string {
        return this._currentDatabase || this.config.database;
    }

    public getCurrentSid(): number {
        return this._currentSid;
    }

    public async executeSql(sql: string): Promise<MysqlExecutionResult> {
        const connection = this.requireConnection();
        return queryRows(connection, sql);
    }

    public async executeStatement(sql: string): Promise<number> {
        const connection = this.requireConnection();
        const [result] = await connection.query(sql);
        const header = result as MysqlQueryResultSetHeader | undefined;
        return header?.affectedRows ?? 0;
    }

    public async setCurrentDatabase(database: string): Promise<void> {
        const normalizedDatabase = normalizeMysqlIdentifier(database);
        if (!normalizedDatabase) {
            throw new Error('MySQL database name cannot be empty.');
        }

        const connection = this.requireConnection();
        await connection.query(`USE ${quoteMysqlIdentifier(normalizedDatabase)}`);
        this._currentDatabase = normalizedDatabase;
    }

    public async cancelActiveCommand(): Promise<void> {
        const connection = this._connection;
        if (!connection) {
            return;
        }

        this.emit('close');
        connection.destroy();
        this._connection = undefined;
        this._connected = false;
    }
}

function quoteMysqlIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
}

function normalizeMysqlIdentifier(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        return trimmed;
    }

    if ((trimmed.startsWith('`') && trimmed.endsWith('`'))
        || (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
        return trimmed.slice(1, -1)
            .replace(/``/g, '`')
            .replace(/""/g, '"')
            .replace(/''/g, '\'');
    }

    return trimmed;
}

function isCompatibilityQuery(sql: string, pattern: RegExp): boolean {
    return pattern.test(stripTrailingSemicolons(sql));
}

function normalizeQueryResult(rows: Record<string, unknown>[], fields: MysqlFieldPacket[]): DatabaseDataReader {
    return createReader(rows, fields);
}

class MysqlCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = 0;

    public constructor(private readonly _connection: MysqlConnection, private readonly _sql: string) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        const sql = stripTrailingSemicolons(this._sql);

        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)) {
            const currentDatabase = this._connection.getCurrentDatabase();
            return normalizeQueryResult([
                {
                    CURRENT_CATALOG: currentDatabase,
                    CURRENT_SCHEMA: currentDatabase
                }
            ], [
                { name: 'CURRENT_CATALOG' },
                { name: 'CURRENT_SCHEMA' }
            ]);
        }

        if (isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)) {
            const currentDatabase = this._connection.getCurrentDatabase();
            return normalizeQueryResult([{ CURRENT_CATALOG: currentDatabase }], [{ name: 'CURRENT_CATALOG' }]);
        }

        if (isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)) {
            const currentDatabase = this._connection.getCurrentDatabase();
            return normalizeQueryResult([{ CURRENT_SCHEMA: currentDatabase }], [{ name: 'CURRENT_SCHEMA' }]);
        }

        if (isCompatibilityQuery(sql, CURRENT_SID_QUERY)) {
            return normalizeQueryResult([{ CURRENT_SID: this._connection.getCurrentSid() }], [{ name: 'CURRENT_SID' }]);
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this._connection.setCurrentDatabase(setCatalogMatch[1]);
            return normalizeQueryResult([], []);
        }

        const result = await this._connection.executeSql(sql);
        return normalizeQueryResult(result.rows, result.fields);
    }

    public async execute(): Promise<void> {
        const sql = stripTrailingSemicolons(this._sql);

        if (isCompatibilityQuery(sql, CURRENT_CATALOG_AND_SCHEMA_QUERY)
            || isCompatibilityQuery(sql, CURRENT_CATALOG_QUERY)
            || isCompatibilityQuery(sql, CURRENT_SCHEMA_QUERY)
            || isCompatibilityQuery(sql, CURRENT_SID_QUERY)) {
            return undefined;
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            await this._connection.setCurrentDatabase(setCatalogMatch[1]);
            return undefined;
        }

        this._recordsAffected = await this._connection.executeStatement(sql);
    }

    public async cancel(): Promise<void> {
        await this._connection.cancelActiveCommand();
    }
}
