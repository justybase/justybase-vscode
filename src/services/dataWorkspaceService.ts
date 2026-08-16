/**
 * Persistent, local DuckDB workspaces and their materialized source profiles.
 *
 * A workspace profile deliberately only stores a stable id and source
 * definitions.  Its DuckDB database lives below extension globalStorage and
 * neither that path, connection passwords, nor macro values are exportable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { streamingManager } from '../core/queryCancellation';
import type { StreamingChunk } from '../core/streaming';
import type { ConnectionDetails, NzConnection } from '../types';
import { escapeSqlIdentifier, escapeSqlLiteral } from '../utils/sqlUtils';

export const DATA_WORKSPACE_OPTION = 'dataWorkspace';
export const DATA_WORKSPACE_VERSION = 2;
export const DATA_WORKSPACE_ROW_LIMIT = 2_000_000;
const DATA_WORKSPACE_PREFLIGHT_LIMIT = DATA_WORKSPACE_ROW_LIMIT + 1;

export type DataWorkspaceRefreshStatus = 'success' | 'error' | 'cancelled' | 'never';
export type DataWorkspaceObjectKind = 'table' | 'view' | 'query';

export interface DataWorkspaceRefreshMetadata {
    status: DataWorkspaceRefreshStatus;
    /** ISO timestamp; never contains a credential or parameter value. */
    completedAt?: string;
    rowCount?: number;
    message?: string;
}

interface DataWorkspaceSourceBase {
    id: string;
    tableName: string;
    lastRefresh?: DataWorkspaceRefreshMetadata;
}

export interface DataWorkspaceFileSource extends DataWorkspaceSourceBase {
    kind: 'file';
    path: string;
}

export interface DataWorkspaceExternalSource extends DataWorkspaceSourceBase {
    kind: 'external';
    connectionName: string;
    sourceKind: DataWorkspaceObjectKind;
    /** Required for table/view sources. It is an object reference, never SQL. */
    objectName?: string;
    /** Required for a manual query source. Values for $variables are never saved. */
    queryTemplate?: string;
}

export type DataWorkspaceSource = DataWorkspaceFileSource | DataWorkspaceExternalSource;

export interface DataWorkspaceConfig {
    version: typeof DATA_WORKSPACE_VERSION;
    workspaceId: string;
    sources: DataWorkspaceSource[];
}

/** Portable definition: intentionally has no DuckDB database path or secrets. */
export interface DataWorkspaceProfileExportEntry {
    name: string;
    workspace: DataWorkspaceConfig;
}

export interface DataWorkspaceProfileExport {
    format: 'justybase.data-workspaces';
    version: 1;
    workspaces: DataWorkspaceProfileExportEntry[];
}

export interface DataWorkspaceConnectionManager {
    getConnection(name: string): Promise<ConnectionDetails | undefined>;
    getConnections(): Promise<ConnectionDetails[]>;
    saveConnection(details: ConnectionDetails): Promise<void>;
    refreshDataWorkspaceConnection?(connectionName: string): Promise<void>;
}

export interface DataWorkspaceServiceDependencies {
    createConnection?: typeof createConnectedDatabaseConnectionFromDetails;
    createId?: () => string;
    now?: () => Date;
    promptForValue?: (name: string) => Promise<string | undefined>;
    promptForValues?: (names: readonly string[]) => Promise<Record<string, string> | undefined>;
    withProgress?: typeof vscode.window.withProgress;
}

type ParquetModule = typeof import('hyparquet-writer');

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function normalizeRefreshMetadata(value: unknown): DataWorkspaceRefreshMetadata | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const status = value.status;
    if (status !== 'success' && status !== 'error' && status !== 'cancelled' && status !== 'never') {
        return undefined;
    }
    return {
        status,
        completedAt: typeof value.completedAt === 'string' ? value.completedAt : undefined,
        rowCount: typeof value.rowCount === 'number' && value.rowCount >= 0 ? value.rowCount : undefined,
        message: typeof value.message === 'string' ? value.message : undefined,
    };
}

/** SQL identifiers for physical DuckDB source tables. */
export function validateDataWorkspaceTableName(value: string): string {
    const trimmed = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,127}$/.test(trimmed)) {
        throw new Error('Local table names must start with a letter or underscore and contain only letters, numbers, _ or $.');
    }
    return trimmed;
}

function normalizeSource(value: unknown): DataWorkspaceSource | undefined {
    if (!isRecord(value) || !isSafeId(value.id) || typeof value.tableName !== 'string') {
        return undefined;
    }
    let tableName: string;
    try {
        tableName = validateDataWorkspaceTableName(value.tableName);
    } catch {
        return undefined;
    }
    const base = { id: value.id, tableName, lastRefresh: normalizeRefreshMetadata(value.lastRefresh) };
    if (value.kind === 'file' && typeof value.path === 'string' && value.path.trim().length > 0) {
        return { ...base, kind: 'file', path: path.resolve(value.path.trim()) };
    }
    if (value.kind === 'external' && typeof value.connectionName === 'string'
        && (value.sourceKind === 'table' || value.sourceKind === 'view' || value.sourceKind === 'query')) {
        if ((value.sourceKind === 'table' || value.sourceKind === 'view')
            && typeof value.objectName === 'string' && isSafeQualifiedObjectReference(value.objectName)) {
            return {
                ...base,
                kind: 'external',
                connectionName: value.connectionName,
                sourceKind: value.sourceKind,
                objectName: value.objectName.trim(),
            };
        }
        if (value.sourceKind === 'query' && typeof value.queryTemplate === 'string') {
            try {
                validateReadOnlyQuery(value.queryTemplate);
                return {
                    ...base,
                    kind: 'external',
                    connectionName: value.connectionName,
                    sourceKind: 'query',
                    queryTemplate: value.queryTemplate.trim(),
                };
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

/** Serialize a v2 workspace definition for a connection profile. */
export function serializeDataWorkspace(config: DataWorkspaceConfig): string {
    const names = new Set<string>();
    const sources = config.sources.map(source => {
        const normalized = normalizeSource(source);
        if (!normalized) {
            throw new Error('The Data Workspace source definition is invalid.');
        }
        const key = normalized.tableName.toLowerCase();
        if (names.has(key)) {
            throw new Error(`Local table name '${normalized.tableName}' is already used by another source.`);
        }
        names.add(key);
        // Do not persist arbitrary driver messages. Some drivers include the
        // fully expanded SQL in errors, which may expose a one-time parameter.
        if (normalized.lastRefresh) delete normalized.lastRefresh.message;
        return normalized;
    });
    if (!isSafeId(config.workspaceId)) {
        throw new Error('The Data Workspace id is invalid.');
    }
    return JSON.stringify({ version: DATA_WORKSPACE_VERSION, workspaceId: config.workspaceId, sources });
}

/** Parse a profile option without treating an arbitrary DuckDB connection as a workspace. */
export function parseDataWorkspace(value: unknown): DataWorkspaceConfig | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        if (!isRecord(parsed) || parsed.version !== DATA_WORKSPACE_VERSION || !isSafeId(parsed.workspaceId)
            || !Array.isArray(parsed.sources)) {
            return undefined;
        }
        const sources: DataWorkspaceSource[] = [];
        for (const value of parsed.sources) {
            const source = normalizeSource(value);
            if (!source) return undefined;
            sources.push(source);
        }
        const names = new Set<string>();
        for (const source of sources) {
            const key = source.tableName.toLowerCase();
            if (names.has(key)) {
                return undefined;
            }
            names.add(key);
        }
        return { version: DATA_WORKSPACE_VERSION, workspaceId: parsed.workspaceId, sources };
    } catch {
        return undefined;
    }
}

export function isDataWorkspaceProfile(details: ConnectionDetails | undefined): boolean {
    return details?.dbType === 'duckdb' && Boolean(parseDataWorkspace(details.options?.[DATA_WORKSPACE_OPTION]));
}

export function serializeDataWorkspaceProfileExport(entries: readonly DataWorkspaceProfileExportEntry[]): string {
    const normalized = entries.map(entry => {
        if (!entry.name.trim()) {
            throw new Error('A Data Workspace export entry needs a name.');
        }
        const workspace = JSON.parse(serializeDataWorkspace(entry.workspace)) as DataWorkspaceConfig;
        // Driver errors can echo SQL literals.  Keep portable status metadata,
        // but never export a message that could contain a supplied $parameter.
        for (const source of workspace.sources) {
            if (source.lastRefresh) delete source.lastRefresh.message;
        }
        return { name: entry.name.trim(), workspace };
    });
    return JSON.stringify({
        format: 'justybase.data-workspaces',
        version: 1,
        workspaces: normalized,
    } satisfies DataWorkspaceProfileExport, null, 2);
}

export function parseDataWorkspaceProfileExport(json: string): DataWorkspaceProfileExportEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error('The selected file is not valid JSON.');
    }
    if (!isRecord(parsed) || parsed.format !== 'justybase.data-workspaces' || parsed.version !== 1) {
        throw new Error('The selected file is not a supported JustyBase Data Workspace export.');
    }
    if (!Array.isArray(parsed.workspaces)) {
        throw new Error('The export does not contain any Data Workspaces.');
    }
    return parsed.workspaces.map((entry, index) => {
        if (!isRecord(entry) || typeof entry.name !== 'string') {
            throw new Error(`Data Workspace export entry ${index + 1} is invalid.`);
        }
        const workspace = parseDataWorkspace(JSON.stringify(entry.workspace));
        if (!workspace) {
            throw new Error(`Data Workspace export entry '${entry.name}' has an invalid workspace definition.`);
        }
        return { name: entry.name.trim(), workspace };
    });
}

/** Create a readable, unique default local table name. */
export function defaultDataWorkspaceTableName(seed: string, existingNames: Iterable<string> = []): string {
    const existing = new Set(Array.from(existingNames, name => name.toLowerCase()));
    const trimmedSeed = seed.trim();
    // A file source benefits from a basename; an external source retains its
    // connection/schema context so names from different servers stay distinct.
    const fileSeed = /\.(?:xlsx|csv|tsv|parquet|avro)$/i.test(trimmedSeed)
        ? (trimmedSeed.split(/[\\/]/).pop() ?? trimmedSeed).replace(/\.[^.]+$/, '')
        : trimmedSeed;
    const base = fileSeed
        .replace(/[^A-Za-z0-9_$]+/g, '_')
        .replace(/^\d+/, '')
        .replace(/^_+/, '')
        .replace(/^_+$/, '') || 'source';
    const validBase = /^[A-Za-z_]/.test(base) ? base : `source_${base}`;
    const shortened = validBase.slice(0, 118);
    let candidate = shortened;
    let number = 2;
    while (existing.has(candidate.toLowerCase())) {
        candidate = `${shortened.slice(0, 120 - String(number).length)}_${number}`;
        number += 1;
    }
    return candidate;
}

/** Variables use the existing macro spelling, but their values remain operation-local. */
export function extractDataWorkspaceParameters(sql: string): string[] {
    const names = new Set<string>();
    const scanner = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of sql.matchAll(scanner)) {
        names.add(match[1] ?? match[2]);
    }
    return Array.from(names);
}

export function applyDataWorkspaceParameters(template: string, values: Readonly<Record<string, string>>): string {
    return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare;
        if (!name) {
            return match;
        }
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
            throw new Error(`No value was supplied for parameter '${name}'.`);
        }
        return values[name] ?? match;
    });
}

/**
 * Remove comments and quoted content for a conservative statement check.
 * Quoted strings are deliberately preserved as spaces, so `$var` inside
 * quotes retains normal macro semantics while SQL keywords inside strings do
 * not affect validation.
 */
function sqlCodeOnly(sql: string): string {
    let output = '';
    let index = 0;
    let state: 'code' | 'single' | 'double' | 'lineComment' | 'blockComment' = 'code';
    while (index < sql.length) {
        const char = sql[index];
        const next = sql[index + 1];
        if (state === 'code') {
            if (char === "'") { state = 'single'; output += ' '; }
            else if (char === '"') { state = 'double'; output += ' '; }
            else if (char === '-' && next === '-') { state = 'lineComment'; output += '  '; index += 1; }
            else if (char === '/' && next === '*') { state = 'blockComment'; output += '  '; index += 1; }
            else { output += char; }
        } else if (state === 'single') {
            output += char === '\n' ? '\n' : ' ';
            if (char === "'" && next === "'") { output += ' '; index += 1; }
            else if (char === "'") { state = 'code'; }
        } else if (state === 'double') {
            output += char === '\n' ? '\n' : ' ';
            if (char === '"' && next === '"') { output += ' '; index += 1; }
            else if (char === '"') { state = 'code'; }
        } else if (state === 'lineComment') {
            output += char === '\n' ? '\n' : ' ';
            if (char === '\n') { state = 'code'; }
        } else {
            output += char === '\n' ? '\n' : ' ';
            if (char === '*' && next === '/') { output += ' '; index += 1; state = 'code'; }
        }
        index += 1;
    }
    if (state === 'single' || state === 'double' || state === 'blockComment') {
        throw new Error('The SQL query has an unterminated string or comment.');
    }
    return output;
}

/** Reject DML/DDL and multiple statements before any source connection is opened. */
export function validateReadOnlyQuery(sql: string): string {
    const code = sqlCodeOnly(sql).trim();
    if (!code) {
        throw new Error('A Data Workspace query cannot be empty.');
    }
    const semicolons = [...code.matchAll(/;/g)];
    if (semicolons.length > 1 || (semicolons.length === 1 && code.slice((semicolons[0].index ?? 0) + 1).trim().length > 0)) {
        throw new Error('A Data Workspace source must contain exactly one SELECT or WITH statement.');
    }
    const statement = code.replace(/;\s*$/, '').trim();
    if (!/^(?:SELECT|WITH)\b/i.test(statement)) {
        throw new Error('Only a single read-only SELECT or WITH query can be materialized.');
    }
    const forbidden = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|EXEC(?:UTE)?|GRANT|REVOKE|SET|SHOW|USE|BEGIN|COMMIT|ROLLBACK|VACUUM|ANALYZE)\b/i;
    if (forbidden.test(statement) || /\bSELECT\b[\s\S]*\bINTO\b/i.test(statement)) {
        throw new Error('Only a read-only SELECT or WITH query can be materialized.');
    }
    return sql.trim().replace(/;\s*$/, '');
}

/** Table/view references are not SQL templates and must not have executable syntax. */
export function isSafeQualifiedObjectReference(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || /[;()'`]/.test(trimmed)) {
        return false;
    }
    // Accept TABLE, SCHEMA.TABLE, DB.SCHEMA.TABLE and DB..TABLE, including quoted parts.
    const identifier = '(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")+")';
    return new RegExp(`^${identifier}(?:\\.${identifier}){0,2}$|^${identifier}\\.\\.${identifier}$`).test(trimmed);
}

function sourceQuery(source: DataWorkspaceSource, parameterValues: Readonly<Record<string, string>>): string {
    if (source.kind === 'file') {
        const viewName = path.basename(source.path).replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').replace(/_+/g, '_') || 'file';
        return `SELECT * FROM ${escapeSqlIdentifier(viewName)}`;
    }
    if (source.sourceKind === 'query') {
        return validateReadOnlyQuery(applyDataWorkspaceParameters(source.queryTemplate ?? '', parameterValues));
    }
    if (!source.objectName || !isSafeQualifiedObjectReference(source.objectName)) {
        throw new Error('The selected source table or view is invalid.');
    }
    return `SELECT * FROM ${source.objectName}`;
}

function buildPreflightQuery(query: string): string {
    return `SELECT 1 FROM (${query}) AS justybase_workspace_preflight LIMIT ${DATA_WORKSPACE_PREFLIGHT_LIMIT}`;
}

function parquetType(typeName: string | undefined): import('hyparquet-writer').BasicType {
    const type = (typeName ?? '').toUpperCase();
    if (/\bBOOLEAN\b|\bBOOL\b/.test(type)) return 'BOOLEAN';
    if (/\bSMALLINT\b|\bINTEGER\b|\bINT\b/.test(type) && !/BIGINT/.test(type)) return 'INT32';
    if (/\bBIGINT\b|\bINT8\b/.test(type)) return 'INT64';
    if (/\bREAL\b|\bFLOAT4\b/.test(type)) return 'FLOAT';
    // Netezza drivers commonly return NUMERIC/DECIMAL values as strings so
    // their precision is retained. Parquet DOUBLE would round DECIMAL(38)
    // values before DuckDB sees them, so stage exact decimal text instead.
    if (/\bNUMERIC\b|\bDECIMAL\b/.test(type)) return 'STRING';
    if (/\bDOUBLE\b|\bFLOAT\b/.test(type)) return 'DOUBLE';
    if (/\bTIMESTAMP\b|\bDATETIME\b/.test(type)) return 'TIMESTAMP';
    return 'STRING';
}

function parquetValue(value: unknown, type: import('hyparquet-writer').BasicType): unknown {
    if (value === null || value === undefined) return null;
    if (type === 'BOOLEAN') return Boolean(value);
    if (type === 'INT32') return typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
    if (type === 'INT64') return typeof value === 'bigint' ? value : BigInt(String(value));
    if (type === 'FLOAT' || type === 'DOUBLE') return typeof value === 'number' ? value : Number(value);
    if (type === 'TIMESTAMP') return value instanceof Date ? value : new Date(String(value));
    return value instanceof Uint8Array ? value : String(value);
}

class WorkspaceParquetWriter {
    private writer: InstanceType<ParquetModule['ParquetWriter']> | undefined;
    private columns: StreamingChunk['columns'] = [];

    public constructor(
        private readonly parquet: ParquetModule,
        private readonly outputPath: string,
    ) {}

    public async write(chunk: StreamingChunk): Promise<void> {
        if (chunk.columns.length > 0) {
            this.columns = chunk.columns;
        }
        if (!this.writer) {
            const columns = this.columns.map(column => ({
                name: column.name,
                type: parquetType(column.type),
                data: [] as unknown[],
            }));
            const fileWriter = createParquetFileWriter(this.parquet, this.outputPath);
            this.writer = new this.parquet.ParquetWriter({
                writer: fileWriter,
                schema: this.parquet.schemaFromColumnData({ columnData: columns }),
            });
        }
        if (chunk.rows.length === 0) {
            return;
        }
        const columns = this.columns.map((column, index) => ({
            name: column.name,
            type: parquetType(column.type),
            data: chunk.rows.map(row => parquetValue(row[index], parquetType(column.type))),
        }));
        await Promise.resolve(this.writer.write({ columnData: columns, rowGroupSize: chunk.rows.length }));
    }

    public async finish(): Promise<void> {
        if (!this.writer) {
            throw new Error('The source did not provide result column metadata.');
        }
        await Promise.resolve(this.writer.finish());
    }
}

function refreshErrorMetadata(error: unknown, now: Date): DataWorkspaceRefreshMetadata {
    const message = error instanceof Error ? error.message : String(error);
    return {
        status: /cancelled/i.test(message) ? 'cancelled' : 'error',
        completedAt: now.toISOString(),
        // Never persist driver errors: many databases include the expanded SQL
        // in an error message, which could reveal an operation-only parameter.
        message: /cancelled/i.test(message)
            ? 'Refresh cancelled; the previous local table was kept.'
            : 'Refresh failed; the previous local table was kept.',
    };
}

function getParquetModule(): ParquetModule {
    // hyparquet-writer exposes a CommonJS condition for the VS Code extension
    // host. Keeping it lazy avoids loading the writer unless a refresh starts.
    return require('hyparquet-writer') as ParquetModule;
}

/**
 * Stream Hyparquet's byte writer to disk. Keeping this Node adapter local
 * avoids the package's browser export condition and bounds transfer memory.
 */
function createParquetFileWriter(parquet: ParquetModule, outputPath: string): import('hyparquet-writer').Writer {
    const writer = new parquet.ByteWriter() as import('hyparquet-writer').Writer & { index: number };
    const chunkSize = 1_000_000;
    fs.writeFileSync(outputPath, '');
    const flush = () => {
        if (writer.index === 0) return;
        fs.appendFileSync(outputPath, new Uint8Array(writer.buffer, 0, writer.index));
        writer.index = 0;
    };
    writer.ensure = size => {
        if (writer.index > chunkSize) flush();
        if (writer.index + size > writer.buffer.byteLength) {
            const nextSize = Math.max(writer.buffer.byteLength * 2, writer.index + size);
            const nextBuffer = new ArrayBuffer(nextSize);
            new Uint8Array(nextBuffer).set(new Uint8Array(writer.buffer));
            writer.buffer = nextBuffer;
            writer.view = new DataView(nextBuffer);
        }
    };
    writer.finish = flush;
    writer.getBuffer = () => {
        throw new Error('A disk-backed Parquet writer does not expose an in-memory buffer.');
    };
    writer.getBytes = () => {
        throw new Error('A disk-backed Parquet writer does not expose in-memory bytes.');
    };
    return writer;
}

export class DataWorkspaceService {
    /** One workspace/source pair can be refreshed at a time across all panel instances. */
    private static readonly activeRefreshes = new Map<string, Promise<DataWorkspaceRefreshMetadata>>();
    private readonly createConnection: typeof createConnectedDatabaseConnectionFromDetails;
    private readonly createId: () => string;
    private readonly now: () => Date;
    private readonly withProgress: typeof vscode.window.withProgress;
    private readonly promptForValue: (name: string) => Promise<string | undefined>;
    private readonly promptForValues: (names: readonly string[]) => Promise<Record<string, string> | undefined>;

    public constructor(
        private readonly context: Pick<vscode.ExtensionContext, 'globalStorageUri'>,
        private readonly connectionManager: DataWorkspaceConnectionManager,
        dependencies: DataWorkspaceServiceDependencies = {},
    ) {
        this.createConnection = dependencies.createConnection ?? createConnectedDatabaseConnectionFromDetails;
        this.createId = dependencies.createId ?? randomUUID;
        this.now = dependencies.now ?? (() => new Date());
        const hostProgress = vscode.window.withProgress;
        this.withProgress = dependencies.withProgress ?? (typeof hostProgress === 'function'
            ? hostProgress.bind(vscode.window)
            : (async (_options, task) => task(
                { report: () => undefined },
                {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => undefined }),
                } as unknown as vscode.CancellationToken,
            )) as typeof vscode.window.withProgress);
        this.promptForValue = dependencies.promptForValue ?? (async name => vscode.window.showInputBox({
            prompt: `Value for $${name}`,
            placeHolder: `Value for $${name} (used only for this refresh)`,
            ignoreFocusOut: true,
        }));
        this.promptForValues = dependencies.promptForValues ?? (async names => {
            if (names.length === 1) {
                const value = await this.promptForValue(names[0]);
                return value === undefined ? undefined : { [names[0]]: value };
            }
            const input = await vscode.window.showInputBox({
                prompt: `Values for ${names.map(name => `$${name}`).join(', ')}`,
                placeHolder: JSON.stringify(Object.fromEntries(names.map(name => [name, '']))),
                ignoreFocusOut: true,
            });
            if (input === undefined) return undefined;
            try {
                const parsed: unknown = JSON.parse(input);
                if (!isRecord(parsed) || names.some(name => typeof parsed[name] !== 'string')) {
                    throw new Error('missing value');
                }
                return Object.fromEntries(names.map(name => [name, parsed[name] as string]));
            } catch {
                throw new Error(`Enter one JSON object with string values for ${names.map(name => `$${name}`).join(', ')}.`);
            }
        });
    }

    public getDatabasePath(workspaceId: string): string {
        if (!isSafeId(workspaceId)) {
            throw new Error('The Data Workspace id is invalid.');
        }
        const storagePath = this.context.globalStorageUri?.fsPath;
        if (!storagePath) {
            throw new Error('VS Code global storage is unavailable; cannot create a persistent Data Workspace.');
        }
        return path.join(storagePath, 'data-workspaces', `${workspaceId}.duckdb`);
    }

    public async createWorkspace(requestedName: string): Promise<ConnectionDetails> {
        const baseName = requestedName.trim();
        if (!baseName) {
            throw new Error('A Data Workspace name is required.');
        }
        const existing = new Set((await this.connectionManager.getConnections()).map(connection => connection.name ?? ''));
        let name = baseName;
        let suffix = 2;
        while (existing.has(name)) {
            name = `${baseName} (${suffix})`;
            suffix += 1;
        }
        const workspaceId = this.createId();
        const databasePath = this.getDatabasePath(workspaceId);
        await fs.promises.mkdir(path.dirname(databasePath), { recursive: true });
        const config: DataWorkspaceConfig = { version: DATA_WORKSPACE_VERSION, workspaceId, sources: [] };
        const details: ConnectionDetails = {
            name,
            host: 'local',
            database: databasePath,
            user: 'duckdb',
            dbType: 'duckdb',
            options: { mode: 'file', [DATA_WORKSPACE_OPTION]: serializeDataWorkspace(config) },
        };
        // Open once so a workspace is a real DuckDB file immediately rather
        // than a profile that becomes materialized only after its first query.
        const connection = await this.createConnection(details);
        await connection.close();
        await this.connectionManager.saveConnection(details);
        return details;
    }

    public exportProfile(connectionName: string): Promise<DataWorkspaceProfileExportEntry> {
        return this.getWorkspace(connectionName).then(({ details, config }) => ({
            name: details.name ?? connectionName,
            // JSON round-trip keeps the export isolated from its live profile.
            workspace: JSON.parse(serializeDataWorkspace(config)) as DataWorkspaceConfig,
        }));
    }

    /**
     * Import always creates a new id/database.  The export's id identifies the
     * original workspace only; reusing it would accidentally point two profiles
     * at the same private cache on a machine where both happen to exist.
     */
    public async importProfile(entry: DataWorkspaceProfileExportEntry): Promise<ConnectionDetails> {
        const created = await this.createWorkspace(entry.name);
        const imported = parseDataWorkspace(serializeDataWorkspace(entry.workspace));
        if (!imported) {
            throw new Error('The imported Data Workspace definition is invalid.');
        }
        const config: DataWorkspaceConfig = {
            ...imported,
            workspaceId: parseDataWorkspace(created.options?.[DATA_WORKSPACE_OPTION])?.workspaceId ?? this.createId(),
        };
        await this.saveWorkspace(created, config);
        return { ...created, options: { ...(created.options ?? {}), [DATA_WORKSPACE_OPTION]: serializeDataWorkspace(config) } };
    }

    public async addFileSource(connectionName: string, filePath: string, tableName?: string): Promise<DataWorkspaceSource> {
        const normalizedPath = path.resolve(filePath.trim());
        if (!normalizedPath) {
            throw new Error('A local file path is required.');
        }
        return this.addSource(connectionName, config => ({
            id: this.createId(),
            kind: 'file',
            path: normalizedPath,
            tableName: tableName ?? defaultDataWorkspaceTableName(normalizedPath, config.sources.map(source => source.tableName)),
            lastRefresh: { status: 'never' },
        }));
    }

    public async addExternalSource(
        connectionName: string,
        input: Omit<DataWorkspaceExternalSource, 'id' | 'lastRefresh'>,
    ): Promise<DataWorkspaceSource> {
        return this.addSource(connectionName, config => ({
            ...input,
            id: this.createId(),
            tableName: input.tableName || defaultDataWorkspaceTableName(
                input.objectName ?? input.connectionName,
                config.sources.map(source => source.tableName),
            ),
            lastRefresh: { status: 'never' },
        }));
    }

    public async removeSource(connectionName: string, sourceId: string): Promise<void> {
        const { details, config } = await this.getWorkspace(connectionName);
        const source = config.sources.find(candidate => candidate.id === sourceId);
        if (!source) {
            throw new Error('The Data Workspace source no longer exists.');
        }
        const localConnection = await this.createConnection(details);
        try {
            await localConnection.createCommand(`DROP TABLE IF EXISTS ${escapeSqlIdentifier(source.tableName)}`).execute();
        } finally {
            await localConnection.close();
        }
        config.sources = config.sources.filter(candidate => candidate.id !== sourceId);
        await this.saveWorkspace(details, config);
        await this.connectionManager.refreshDataWorkspaceConnection?.(connectionName);
    }

    public refreshSource(connectionName: string, sourceId: string): Promise<DataWorkspaceRefreshMetadata> {
        const refreshKey = `${connectionName}\u0000${sourceId}`;
        const activeRefresh = DataWorkspaceService.activeRefreshes.get(refreshKey);
        if (activeRefresh) return activeRefresh;

        const refresh = this.refreshSourceInternal(connectionName, sourceId);
        DataWorkspaceService.activeRefreshes.set(refreshKey, refresh);
        void refresh.then(
            () => { DataWorkspaceService.activeRefreshes.delete(refreshKey); },
            () => { DataWorkspaceService.activeRefreshes.delete(refreshKey); },
        );
        return refresh;
    }

    private async refreshSourceInternal(connectionName: string, sourceId: string): Promise<DataWorkspaceRefreshMetadata> {
        const { details, config } = await this.getWorkspace(connectionName);
        const source = config.sources.find(candidate => candidate.id === sourceId);
        if (!source) {
            throw new Error('The Data Workspace source no longer exists.');
        }

        try {
            const progressLocation = vscode.ProgressLocation?.Notification ?? 15;
            const status = await this.withProgress(
                {
                    location: progressLocation,
                    title: `Refreshing ${source.tableName} in ${connectionName}`,
                    cancellable: true,
                },
                async (progress, cancellationToken) => {
                    const cancelKey = `data-workspace:${config.workspaceId}:${source.id}`;
                    const cancellationDisposable = cancellationToken.onCancellationRequested(() => {
                        streamingManager.abortQuery(cancelKey, 'Data Workspace refresh cancelled');
                    });
                    try {
                        return await this.materializeSource(details, config, source, progress, cancelKey);
                    } finally {
                        cancellationDisposable.dispose();
                        streamingManager.clearAborted(cancelKey);
                    }
                },
            );
            source.lastRefresh = status;
            await this.saveWorkspace(details, config);
            await this.connectionManager.refreshDataWorkspaceConnection?.(connectionName);
            return status;
        } catch (error) {
            const status = refreshErrorMetadata(error, this.now());
            source.lastRefresh = status;
            await this.saveWorkspace(details, config);
            throw error;
        }
    }

    private async addSource(
        connectionName: string,
        createSource: (config: DataWorkspaceConfig) => DataWorkspaceSource,
    ): Promise<DataWorkspaceSource> {
        const { details, config } = await this.getWorkspace(connectionName);
        const source = createSource(config);
        source.tableName = validateDataWorkspaceTableName(source.tableName);
        if (config.sources.some(existing => existing.tableName.toLowerCase() === source.tableName.toLowerCase())) {
            throw new Error(`Local table name '${source.tableName}' is already used by another source.`);
        }
        if (source.kind === 'external') {
            if (source.sourceKind === 'query') {
                source.queryTemplate = validateReadOnlyQuery(source.queryTemplate ?? '');
            } else if (!source.objectName || !isSafeQualifiedObjectReference(source.objectName)) {
                throw new Error('A valid table or view reference is required.');
            }
        }
        config.sources.push(source);
        await this.saveWorkspace(details, config);
        return source;
    }

    private async getWorkspace(connectionName: string): Promise<{ details: ConnectionDetails; config: DataWorkspaceConfig }> {
        const details = await this.connectionManager.getConnection(connectionName);
        const config = parseDataWorkspace(details?.options?.[DATA_WORKSPACE_OPTION]);
        if (!details || details.dbType !== 'duckdb' || !config) {
            throw new Error(`Connection '${connectionName}' is not a persistent Data Workspace.`);
        }
        return { details, config };
    }

    private async saveWorkspace(details: ConnectionDetails, config: DataWorkspaceConfig): Promise<void> {
        await this.connectionManager.saveConnection({
            ...details,
            options: {
                ...(details.options ?? {}),
                mode: 'file',
                [DATA_WORKSPACE_OPTION]: serializeDataWorkspace(config),
            },
        });
    }

    private async promptForParameters(queryTemplate: string): Promise<Record<string, string>> {
        const names = extractDataWorkspaceParameters(queryTemplate);
        if (names.length === 0) return {};
        const values = await this.promptForValues(names);
        if (!values) throw new Error('Data Workspace refresh cancelled while entering parameters.');
        return values;
    }

    private async materializeSource(
        workspaceDetails: ConnectionDetails,
        config: DataWorkspaceConfig,
        source: DataWorkspaceSource,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        cancelKey: string,
    ): Promise<DataWorkspaceRefreshMetadata> {
        const parameters = source.kind === 'external' && source.sourceKind === 'query'
            ? await this.promptForParameters(source.queryTemplate ?? '')
            : {};
        const query = sourceQuery(source, parameters);
        const sourceConnection = await this.openSourceConnection(source);
        const refreshToken = this.createId().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48);
        const stagedParquetPath = path.join(path.dirname(this.getDatabasePath(config.workspaceId)), `.staging-${source.id}-${refreshToken}.parquet`);
        let localConnection: NzConnection | undefined;
        let staging: string | undefined;
        try {
            progress.report({ message: 'Checking source row limit…' });
            const preflight = await streamingManager.executeWithStreaming(
                sourceConnection,
                buildPreflightQuery(query),
                DATA_WORKSPACE_PREFLIGHT_LIMIT,
                50_000,
                undefined,
                cancelKey,
                () => undefined,
                undefined,
                undefined,
                DATA_WORKSPACE_PREFLIGHT_LIMIT,
            );
            if (preflight.error) throw preflight.error;
            if (preflight.totalRows > DATA_WORKSPACE_ROW_LIMIT || preflight.limitReached) {
                throw new Error(`The source exceeds the ${DATA_WORKSPACE_ROW_LIMIT.toLocaleString()} row limit. Add a WHERE clause or LIMIT to the source SQL.`);
            }

            const parquetWriter = new WorkspaceParquetWriter(getParquetModule(), stagedParquetPath);
            progress.report({ message: 'Streaming typed data to local storage…' });
            const streamed = await streamingManager.executeWithStreaming(
                sourceConnection,
                query,
                DATA_WORKSPACE_PREFLIGHT_LIMIT,
                25_000,
                undefined,
                cancelKey,
                async chunk => {
                    await parquetWriter.write(chunk);
                    progress.report({ message: `${chunk.totalRowsSoFar.toLocaleString()} rows materialized…` });
                },
                undefined,
                undefined,
                DATA_WORKSPACE_PREFLIGHT_LIMIT,
            );
            if (streamed.error) throw streamed.error;
            if (streamed.totalRows > DATA_WORKSPACE_ROW_LIMIT || streamed.limitReached) {
                throw new Error(`The source exceeded the ${DATA_WORKSPACE_ROW_LIMIT.toLocaleString()} row limit while streaming; the previous local table was kept.`);
            }
            await parquetWriter.finish();

            progress.report({ message: 'Atomically replacing the local table…' });
            localConnection = await this.createConnection(workspaceDetails) as NzConnection;
            const stagingName = `__jbl_stage_${source.id.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64)}_${refreshToken}`;
            const target = escapeSqlIdentifier(source.tableName);
            staging = escapeSqlIdentifier(stagingName);
            const parquetLiteral = escapeSqlLiteral(stagedParquetPath.replace(/\\/g, '/'));
            await localConnection.createCommand(`CREATE OR REPLACE TABLE ${staging} AS SELECT * FROM read_parquet(${parquetLiteral})`).execute();
            try {
                await localConnection.createCommand('BEGIN TRANSACTION').execute();
                await localConnection.createCommand(`CREATE OR REPLACE TABLE ${target} AS SELECT * FROM ${staging}`).execute();
                await localConnection.createCommand(`DROP TABLE ${staging}`).execute();
                await localConnection.createCommand('COMMIT').execute();
            } catch (error) {
                try {
                    await localConnection.createCommand('ROLLBACK').execute();
                } catch {
                    // The original materialization failure is the useful error.
                }
                throw error;
            }

            return { status: 'success', completedAt: this.now().toISOString(), rowCount: streamed.totalRows };
        } finally {
            if (localConnection && staging) {
                await localConnection.createCommand(`DROP TABLE IF EXISTS ${staging}`).execute().catch(() => undefined);
            }
            if (localConnection) await localConnection.close().catch(() => undefined);
            await sourceConnection.close().catch(() => undefined);
            await fs.promises.unlink(stagedParquetPath).catch(() => undefined);
        }
    }

    private async openSourceConnection(source: DataWorkspaceSource): Promise<NzConnection> {
        if (source.kind === 'file') {
            return this.createConnection({
                host: 'local',
                database: source.path,
                user: 'file',
                dbType: 'file',
                options: {},
            }) as Promise<NzConnection>;
        }
        const details = await this.connectionManager.getConnection(source.connectionName);
        if (!details) {
            throw new Error(`Saved connection '${source.connectionName}' is unavailable. This source can be refreshed after that profile is restored.`);
        }
        return this.createConnection(details) as Promise<NzConnection>;
    }
}
