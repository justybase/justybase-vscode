import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader,
} from '@justybase/contracts';
import {
    JavaBridgeClient,
    type BridgeColumnDefinition,
    type BridgeFetchResponse,
    type PendingQuery,
} from './javaBridgeClient';
import { accessBridgePool, type AccessBridgeLease } from './accessBridgePool';

const CURRENT_CATALOG_QUERY = /^SELECT\s+CURRENT_CATALOG\s*;?$/i;
const CURRENT_SCHEMA_QUERY = /^SELECT\s+CURRENT_SCHEMA\s*;?$/i;
const CURRENT_CATALOG_AND_SCHEMA_QUERY = /^SELECT\s+CURRENT_CATALOG\s*,\s*CURRENT_SCHEMA\s*;?$/i;
const CURRENT_SID_QUERY = /^SELECT\s+CURRENT_SID\s*;?$/i;
const SET_CATALOG_QUERY = /^SET\s+CATALOG\s+(.+?)\s*;?$/i;
const SET_SCHEMA_QUERY = /^SET\s+SCHEMA\s+(.+?)\s*;?$/i;

const METADATA_MARKER_QUERY = /_access_metadata\.([a-z_]+)/i;
const ACCESS_WRITE_STATEMENT = /^(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/i;

interface ExecutionResult {
    columns: BridgeColumnDefinition[];
    rows: unknown[][];
    recordsAffected: number;
    cancelled: boolean;
    cursorId?: number;
    hasMore?: boolean;
}

interface MetadataMarker {
    kind: string;
    table?: string;
    pattern?: string;
    serverSide: boolean;
}

function resolveDatabaseLocation(config: DatabaseConnectionConfig): string {
    const requestedDatabase = config.database?.trim();
    if (!requestedDatabase) {
        throw new Error('No Microsoft Access database file configured.');
    }
    return path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase);
}

function resolveJavaExecutable(config: DatabaseConnectionConfig): string {
    const configured = config.options?.javaPath;
    if (typeof configured === 'string' && configured.trim().length > 0) {
        return configured.trim();
    }

    const setting = vscode.workspace.getConfiguration('justybase.access').get<string>('javaPath', '').trim();
    if (setting.length > 0) {
        return setting;
    }

    const javaHome = process.env.JAVA_HOME;
    if (javaHome && javaHome.trim().length > 0) {
        const executable = process.platform === 'win32' ? 'java.exe' : 'java';
        return path.join(javaHome.trim(), 'bin', executable);
    }

    return 'java';
}

/** Validate an explicitly configured Java launcher before it reaches spawn(). */
export function validateJavaExecutablePath(value: string): string {
    const candidate = value.trim();
    if (!candidate) {
        throw new Error('The Access Java path cannot be empty when explicitly configured.');
    }
    if (candidate.includes('"') || candidate.includes("'")) {
        throw new Error('The Access Java path must contain only the executable path, without arguments.');
    }
    if (!path.isAbsolute(candidate)) {
        throw new Error('The Access Java path must be an absolute path to java or java.exe.');
    }
    const executableName = path.basename(candidate).toLowerCase();
    if (executableName !== 'java' && executableName !== 'java.exe') {
        throw new Error('The Access Java path must point to an executable named java or java.exe.');
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        throw new Error(`The configured Access Java executable does not exist: ${candidate}`);
    }
    if (process.platform !== 'win32' && (fs.statSync(candidate).mode & 0o111) === 0) {
        throw new Error(`The configured Access Java executable is not executable: ${candidate}`);
    }
    return candidate;
}

function resolveBridgeJarPath(): string {
    return path.join(__dirname, '..', 'resources', 'access-bridge.jar');
}

export function verifyAccessBridgeJar(jarPath: string): void {
    const checksumPath = `${jarPath}.sha256`;
    if (!fs.existsSync(jarPath)) {
        throw new Error(`Missing Access bridge JAR: ${jarPath}`);
    }
    if (!fs.existsSync(checksumPath)) {
        throw new Error(`Missing Access bridge JAR checksum: ${checksumPath}`);
    }
    const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash('sha256').update(fs.readFileSync(jarPath)).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expected ?? '') || expected !== actual) {
        throw new Error(`Access bridge JAR checksum mismatch: expected ${expected || '<missing>'}, got ${actual}`);
    }
}

function parseMetadataMarker(sql: string): MetadataMarker | undefined {
    const match = sql.match(METADATA_MARKER_QUERY);
    if (!match) {
        return undefined;
    }

    const kind = match[1].toLowerCase();
    const table = readWhereString(sql, 'TABLE')
        ?? (kind === 'object_type' ? readWhereString(sql, 'TYPE') : undefined);
    const pattern = readWhereString(sql, 'PATTERN');
    const serverSide = /SERVER_SIDE\s*=\s*1/i.test(sql);
    return { kind, table, pattern, serverSide };
}

function readWhereString(sql: string, key: string): string | undefined {
    const pattern = new RegExp(`${key}\\s*=\\s*'((?:[^']|'')*)'`, 'i');
    const match = sql.match(pattern);
    if (!match) {
        return undefined;
    }
    return match[1].replace(/''/g, "'");
}

function startsWithAccessWriteStatement(sql: string): boolean {
    let remaining = sql.trim();
    while (remaining.length > 0) {
        if (remaining.startsWith('--')) {
            const newline = remaining.indexOf('\n');
            remaining = newline < 0 ? '' : remaining.slice(newline + 1).trim();
            continue;
        }
        if (remaining.startsWith('/*')) {
            const end = remaining.indexOf('*/', 2);
            remaining = end < 0 ? '' : remaining.slice(end + 2).trim();
            continue;
        }
        break;
    }
    return ACCESS_WRITE_STATEMENT.test(remaining);
}

type FetchMoreFn = (cursorId: number) => Promise<BridgeFetchResponse>;
type CloseCursorFn = (cursorId: number) => Promise<void>;

class AccessDataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private _buffer: unknown[][];
    private _readIndex = -1;
    private _closed = false;
    private readonly _schemaRows: { NumericScale?: number }[];

    public constructor(
        private readonly _columns: readonly BridgeColumnDefinition[],
        initialRows: readonly unknown[][],
        private _cursorId?: number,
        private _hasMore: boolean = false,
        private readonly _fetchMore?: FetchMoreFn,
        private readonly _closeCursor?: CloseCursorFn,
    ) {
        this.fieldCount = _columns.length;
        this._buffer = [...initialRows];
        this._schemaRows = _columns.map(column => ({
            NumericScale: typeof column.scale === 'number' && column.scale > 0 ? column.scale : undefined,
        }));
    }

    public async read(): Promise<boolean> {
        if (this._closed) {
            return false;
        }

        if (this._readIndex + 1 < this._buffer.length) {
            this._readIndex++;
            return true;
        }

        if (this._hasMore && this._cursorId !== undefined && this._fetchMore) {
            await this._fillMore();
        }

        if (this._readIndex + 1 < this._buffer.length) {
            this._readIndex++;
            return true;
        }

        return false;
    }

    private async _fillMore(): Promise<void> {
        const cursorId = this._cursorId;
        if (cursorId === undefined || !this._fetchMore) {
            this._hasMore = false;
            return;
        }
        const more = await this._fetchMore(cursorId);
        if (more.cancelled) {
            this._hasMore = false;
            this._cursorId = undefined;
            return;
        }
        if (more.rows.length > 0) {
            this._buffer.push(...more.rows);
        }
        this._hasMore = more.hasMore;
        if (!more.hasMore) {
            this._cursorId = undefined;
        }
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;
        const cursorId = this._cursorId;
        this._cursorId = undefined;
        this._hasMore = false;
        if (cursorId !== undefined && this._closeCursor) {
            await this._closeCursor(cursorId).catch(() => undefined);
        }
    }

    public getName(index: number): string {
        return this._columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._columns[index]?.type ?? '';
    }

    public getValue(index: number): unknown {
        if (this._readIndex < 0 || this._readIndex >= this._buffer.length) {
            return undefined;
        }
        return this._buffer[this._readIndex]?.[index];
    }

    public getSchemaTable(): { NumericScale?: number }[] {
        return this._schemaRows;
    }
}

export class AccessConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private _lease?: AccessBridgeLease;
    // Kept as an internal compatibility seam for existing tests and callers
    // that inject a bridge while exercising marker handling without Java.
    private _bridge?: JavaBridgeClient;
    private _connectPromise?: Promise<void>;
    private readonly _sessionId = `access-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    private readonly _databasePath: string;
    private readonly _javaExecutable: string;
    private readonly _javaPathIsExplicit: boolean;
    private readonly _readOnly: boolean;
    private readonly _chunkSize?: number;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._databasePath = resolveDatabaseLocation(config);
        // Keep construction side-effect free. The executable is validated at
        // connect time immediately before the sidecar can be spawned.
        this._javaExecutable = resolveJavaExecutable(config);
        const configuredOption = config.options?.javaPath;
        const configuredSetting = vscode.workspace.getConfiguration('justybase.access').get<string>('javaPath', '').trim();
        this._javaPathIsExplicit = (typeof configuredOption === 'string' && configuredOption.trim().length > 0)
            || configuredSetting.length > 0;
        this._readOnly = config.options?.readOnly !== false;
        const chunkSize = config.options?.chunkSize;
        this._chunkSize = typeof chunkSize === 'number' && Number.isInteger(chunkSize) && chunkSize > 0
            ? chunkSize
            : undefined;
    }

    public getSessionId(): string {
        return this._sessionId;
    }

    public getCurrentCatalog(): string {
        return 'default';
    }

    public getCurrentSchema(): string {
        return 'default';
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }
        if (!this._connectPromise) {
            this._connectPromise = this._connect();
        }
        try {
            await this._connectPromise;
        } finally {
            this._connectPromise = undefined;
        }
    }

    private async _connect(): Promise<void> {
        if (this._javaPathIsExplicit || path.isAbsolute(this._javaExecutable)) {
            validateJavaExecutablePath(this._javaExecutable);
        }
        verifyAccessBridgeJar(resolveBridgeJarPath());
        const lease = await accessBridgePool.acquire({
            databasePath: this._databasePath,
            javaExecutable: this._javaExecutable,
            bridgeJarPath: resolveBridgeJarPath(),
            user: this.config.user,
            password: this.config.password,
            readOnly: this._readOnly,
        });
        this._lease = lease;
        this._bridge = lease.bridge;
        this._connected = true;
    }

    public async close(): Promise<void> {
        if (this._connectPromise) {
            await this._connectPromise.catch(() => undefined);
        }
        const lease = this._lease;
        this._lease = undefined;
        this._bridge = undefined;
        this._connected = false;
        if (lease) {
            await lease.release();
        }
    }

    public createCommand(sql: string): DatabaseCommand {
        return new AccessCommand(this, sql);
    }

    public getBridge(): JavaBridgeClient {
        if (!this._bridge && !this._lease) {
            throw new Error('Microsoft Access connection is not open.');
        }
        return this._bridge ?? (this._lease as AccessBridgeLease).bridge;
    }

    public executeRaw(sql: string): Promise<ExecutionResult> | PendingQuery {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
            return Promise.resolve({ columns: [], rows: [], recordsAffected: -1, cancelled: false });
        }

        const pseudoResult = this.tryExecuteCompatibilityCommand(trimmedSql);
        if (pseudoResult) {
            return Promise.resolve(pseudoResult);
        }

        const metadataMarker = parseMetadataMarker(trimmedSql);
        if (metadataMarker) {
            return this.executeMetadataMarker(metadataMarker);
        }

        if (this._readOnly && startsWithAccessWriteStatement(trimmedSql)) {
            return Promise.reject(new Error(
                'Microsoft Access connection is read-only. Disable "Open database as read-only" to execute INSERT, UPDATE, DELETE, or DDL.',
            ));
        }

        return this.getBridge().query(trimmedSql, undefined, this._chunkSize);
    }

    public async fetchMore(cursorId: number): Promise<BridgeFetchResponse> {
        const bridge = this._bridge ?? this._lease?.bridge;
        if (!bridge) {
            return { kind: 'fetch', rows: [], hasMore: false, cancelled: true };
        }
        return bridge.fetchMore(cursorId, this._chunkSize);
    }

    public async closeCursor(cursorId: number): Promise<void> {
        const bridge = this._bridge ?? this._lease?.bridge;
        if (!bridge) {
            return;
        }
        await bridge.closeCursor(cursorId).catch(() => undefined);
    }

    public async cancelQuery(queryId: number): Promise<void> {
        const bridge = this._bridge ?? this._lease?.bridge;
        if (!bridge) {
            return;
        }
        await bridge.cancel(queryId).catch(() => undefined);
    }

    private async executeMetadataMarker(marker: MetadataMarker): Promise<ExecutionResult> {
        const response = await this.getBridge().metadata(marker.kind, {
            table: marker.kind === 'object_search' || marker.kind === 'view_source_search'
                ? marker.pattern
                : marker.table,
            serverSide: marker.serverSide,
        });
        return {
            columns: response.columns,
            rows: response.rows,
            recordsAffected: -1,
            cancelled: false,
        };
    }

    private tryExecuteCompatibilityCommand(sql: string): ExecutionResult | undefined {
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [
                    { name: 'CURRENT_CATALOG', type: 'TEXT' },
                    { name: 'CURRENT_SCHEMA', type: 'TEXT' },
                ],
                rows: [[this.getCurrentCatalog(), this.getCurrentSchema()]],
                recordsAffected: -1,
                cancelled: false,
            };
        }

        if (CURRENT_CATALOG_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_CATALOG', type: 'TEXT' }],
                rows: [[this.getCurrentCatalog()]],
                recordsAffected: -1,
                cancelled: false,
            };
        }

        if (CURRENT_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SCHEMA', type: 'TEXT' }],
                rows: [[this.getCurrentSchema()]],
                recordsAffected: -1,
                cancelled: false,
            };
        }

        if (CURRENT_SID_QUERY.test(sql)) {
            return {
                columns: [{ name: 'CURRENT_SID', type: 'TEXT' }],
                rows: [[this.getSessionId()]],
                recordsAffected: -1,
                cancelled: false,
            };
        }

        const setCatalogMatch = sql.match(SET_CATALOG_QUERY);
        if (setCatalogMatch) {
            return {
                columns: [],
                rows: [],
                recordsAffected: 0,
                cancelled: false,
            };
        }

        if (SET_SCHEMA_QUERY.test(sql)) {
            return {
                columns: [],
                rows: [],
                recordsAffected: 0,
                cancelled: false,
            };
        }

        return undefined;
    }
}

class AccessCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;
    private _pendingQuery?: PendingQuery;

    public constructor(
        private readonly _connection: AccessConnection,
        private readonly _sql: string,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }

        const execution = this._connection.executeRaw(this._sql);
        let result: ExecutionResult;
        if ('requestId' in execution) {
            this._pendingQuery = execution;
            try {
                result = await execution.result;
            } finally {
                this._pendingQuery = undefined;
            }
        } else {
            result = await execution;
        }

        this._recordsAffected = result.recordsAffected;

        if (result.cancelled) {
            return new AccessDataReader([], []);
        }

        return new AccessDataReader(
            result.columns,
            result.rows,
            result.cursorId,
            result.hasMore === true,
            cursorId => this._connection.fetchMore(cursorId),
            cursorId => this._connection.closeCursor(cursorId),
        );
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        const pending = this._pendingQuery;
        if (pending) {
            await this._connection.cancelQuery(pending.requestId);
        }
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}
