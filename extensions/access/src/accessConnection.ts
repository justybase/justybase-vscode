import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
    DatabaseCommand,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader,
} from '@justybase/contracts';
import {
    AccessFileError,
    AccessFileSession,
    type AccessColumnDefinition,
    type AccessQueryDefinition,
    type AccessTableDefinition,
    type AccessTableSnapshot,
    type AccessValue,
} from '@justybase/access-file';
import {
    AccessDuckDbMirror,
    type AccessMirrorColumn,
} from './accessDuckDbMirror';
import { acquireAccessFileLock } from './accessFileLock';
import { writeAccessSnapshotChanges, applyDdlSql } from '@justybase/access-file';
import { JetPageChannel } from '@justybase/access-file/jet/JetPageChannel';
import { jetLayoutFor } from '@justybase/access-file/jet/JetLayout';

const CURRENT_CATALOG_QUERY = /^SELECT\s+CURRENT_CATALOG\s*;?$/i;
const CURRENT_SCHEMA_QUERY = /^SELECT\s+CURRENT_SCHEMA\s*;?$/i;
const CURRENT_CATALOG_AND_SCHEMA_QUERY = /^SELECT\s+CURRENT_CATALOG\s*,\s*CURRENT_SCHEMA\s*;?$/i;
const CURRENT_SID_QUERY = /^SELECT\s+CURRENT_SID\s*;?$/i;
const LAST_IDENTITY_QUERY = /^SELECT\s+@@IDENTITY(?:\s+AS\s+(\[(?:[^\]]|\]\])+\]|"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?\s*;?$/i;
const SET_CATALOG_QUERY = /^SET\s+CATALOG\s+(.+?)\s*;?$/i;
const SET_SCHEMA_QUERY = /^SET\s+SCHEMA\s+(.+?)\s*;?$/i;
const METADATA_MARKER_QUERY = /_access_metadata\.([a-z_]+)/i;
const ACCESS_WRITE_STATEMENT = /^(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/i;

interface MetadataMarker {
    readonly kind: string;
    readonly table?: string;
    readonly pattern?: string;
    readonly serverSide: boolean;
}

interface ExecutionResult {
    readonly columns: readonly AccessMirrorColumn[];
    readonly rows?: readonly (readonly unknown[])[];
    readonly rowChunks?: AsyncIterable<readonly (readonly unknown[])[]>;
    readonly recordsAffected: number;
    readonly release?: () => void;
}

function resolveDatabaseLocation(config: DatabaseConnectionConfig): string {
    const requestedDatabase = config.database?.trim();
    if (!requestedDatabase) {
        throw new Error('No Microsoft Access database file configured.');
    }
    return path.isAbsolute(requestedDatabase) ? requestedDatabase : path.resolve(requestedDatabase);
}

function configuredReadOnly(config: DatabaseConnectionConfig): boolean {
    if (typeof config.options?.readOnly === 'boolean') {
        return config.options.readOnly;
    }
    return vscode.workspace.getConfiguration('justybase.access').get<boolean>('readOnly', true);
}

function stripLeadingComments(sql: string): string {
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
    return remaining;
}

/**
 * Splits a script into individual statements on top-level semicolons,
 * respecting SQL strings, quoted identifiers, Access date literals (#...#),
 * bracket identifiers and line/block comments.
 */
export function splitAccessStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let index = 0;
    while (index < sql.length) {
        const character = sql[index]!;
        const next = sql[index + 1];
        if (character === '-' && next === '-') {
            const end = sql.indexOf('\n', index + 2);
            const stop = end < 0 ? sql.length : end;
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (character === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            const stop = end < 0 ? sql.length : end + 2;
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (character === '\'' || character === '"') {
            const quote = character;
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== quote) {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === quote) {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (character === '#') {
            const end = sql.indexOf('#', index + 1);
            const stop = end < 0 ? sql.length : end + 1;
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (character === '[') {
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== ']') {
                    stop++;
                    continue;
                }
                // Access escapes a closing bracket in an identifier as ]].
                if (sql[stop + 1] === ']') {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            current += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (character === ';') {
            if (current.trim().length > 0) {
                statements.push(current.trim());
            }
            current = '';
            index++;
            continue;
        }
        current += character;
        index++;
    }
    if (current.trim().length > 0) {
        statements.push(current.trim());
    }
    return statements.filter(statement => stripLeadingComments(statement).length > 0);
}

function startsWithAccessWriteStatement(sql: string): boolean {
    return ACCESS_WRITE_STATEMENT.test(stripLeadingComments(sql));
}

interface AccessIdentifierAt {
    readonly name: string;
    readonly end: number;
}

function readAccessIdentifierAt(sql: string, start: number): AccessIdentifierAt | undefined {
    const opening = sql[start];
    if (opening === '[' || opening === '"') {
        const closing = opening === '[' ? ']' : '"';
        let name = '';
        let index = start + 1;
        while (index < sql.length) {
            const character = sql[index]!;
            if (character !== closing) {
                name += character;
                index++;
                continue;
            }
            if (sql[index + 1] === closing) {
                name += closing;
                index += 2;
                continue;
            }
            return { name, end: index + 1 };
        }
        return undefined;
    }
    const unquoted = sql.slice(start).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    return unquoted ? { name: unquoted[0], end: start + unquoted[0].length } : undefined;
}

function unquoteAccessIdentifier(value: string): string {
    const parsed = readAccessIdentifierAt(value, 0);
    if (!parsed || parsed.end !== value.length) return value;
    return parsed.name;
}

interface AccessQualifiedName {
    readonly name: string;
    readonly start: number;
    readonly end: number;
    /** Raw last segment, including any brackets or double quotes. */
    readonly lastRaw: string;
}

/**
 * Reads `table`, `schema.table`, `database.schema.table`, and the Access
 * `database..table` form. Access exposes a single flat catalog, so the last
 * segment is the physical table name.
 */
function readAccessQualifiedNameAt(sql: string, start: number): AccessQualifiedName | undefined {
    let index = start;
    let last: { readonly name: string; readonly raw: string; readonly end: number } | undefined;
    for (;;) {
        const parsed = readAccessIdentifierAt(sql, index);
        if (!parsed) break;
        last = { name: parsed.name, raw: sql.slice(index, parsed.end), end: parsed.end };
        index = parsed.end;
        if (sql[index] !== '.') break;
        index++;
        // `DB..TABLE` has an empty schema segment.
        while (sql[index] === '.') index++;
    }
    return last
        ? { name: last.name, start, end: last.end, lastRaw: last.raw }
        : undefined;
}

export function writeTargetTableName(sql: string): string | undefined {
    const statement = stripLeadingComments(sql);
    const prefix = statement.match(/^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+/i);
    return prefix ? readAccessQualifiedNameAt(statement, prefix[0].length)?.name : undefined;
}

/**
 * The DuckDB mirror uses a flat `main` schema, so the Access-only catalog /
 * schema qualifier must be removed before execution. Only the target name is
 * rewritten; the rest of the statement is preserved.
 */
function normalizeAccessWriteTarget(sql: string): string {
    const statement = stripLeadingComments(sql);
    const prefix = statement.match(/^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+/i);
    if (!prefix) return statement;
    const target = readAccessQualifiedNameAt(statement, prefix[0].length);
    if (!target) return statement;
    const qualifiedLength = target.end - target.start;
    if (qualifiedLength === target.lastRaw.length) return statement;
    return `${statement.slice(0, target.start)}${target.lastRaw}${statement.slice(target.end)}`;
}

/**
 * Accepts `TRUNCATE table` and `TRUNCATE TABLE table`; the optional catalog or
 * schema qualifier is discarded. Rejects any trailing clause so a malformed
 * statement can never silently delete only part of a table.
 */
function readAccessTruncateTarget(sql: string): AccessQualifiedName | undefined {
    const statement = stripLeadingComments(sql);
    const prefix = statement.match(/^TRUNCATE\s+(?:TABLE\s+)?/i);
    if (!prefix) return undefined;
    const target = readAccessQualifiedNameAt(statement, prefix[0].length);
    if (!target) {
        throw new Error('TRUNCATE requires a table name.');
    }
    const rest = statement.slice(target.end).trim();
    if (rest !== '' && rest !== ';') {
        throw new Error('TRUNCATE accepts only a table name and does not support a WHERE clause.');
    }
    return target;
}

function identityValueKey(value: unknown): string | undefined {
    if (typeof value === 'bigint') return `bigint:${value.toString()}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `number:${value}`;
    return undefined;
}

function insertedIdentityFromSnapshots(
    sql: string,
    before: readonly AccessTableSnapshot[],
    after: readonly AccessTableSnapshot[],
): number | bigint | undefined {
    if (!/^INSERT\b/i.test(stripLeadingComments(sql))) return undefined;
    const tableName = writeTargetTableName(sql);
    if (!tableName) return undefined;
    const beforeTable = before.find(table => table.definition.name.toLowerCase() === tableName.toLowerCase());
    const afterTable = after.find(table => table.definition.name.toLowerCase() === tableName.toLowerCase());
    if (!afterTable) return undefined;
    const identityColumn = afterTable.definition.columns.find(column => column.autoLong);
    if (!identityColumn) return undefined;
    const identityIndex = afterTable.definition.columns.indexOf(identityColumn);
    // AutoNumber values are unique, so comparing only the identity column is
    // both linear and correct when an INSERT duplicates an existing row.
    const previousIdentities = new Set(
        (beforeTable?.rows ?? [])
            .map(row => identityValueKey(row[identityIndex]))
            .filter((value): value is string => value !== undefined),
    );
    const candidate = afterTable.rows
        .map(row => row[identityIndex])
        .reverse()
        .find(value => {
            const key = identityValueKey(value);
            return key !== undefined && !previousIdentities.has(key);
        });
    if (typeof candidate === 'bigint') return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    return undefined;
}

function readWhereString(sql: string, key: string): string | undefined {
    const pattern = new RegExp(`${key}\\s*=\\s*'((?:[^']|'')*)'`, 'i');
    const match = sql.match(pattern);
    return match?.[1]?.replace(/''/g, "'");
}

function parseMetadataMarker(sql: string): MetadataMarker | undefined {
    const match = sql.match(METADATA_MARKER_QUERY);
    if (!match) {
        return undefined;
    }
    const kind = match[1].toLowerCase();
    return {
        kind,
        table: readWhereString(sql, 'TABLE') ?? (kind === 'object_type' ? readWhereString(sql, 'TYPE') : undefined),
        pattern: readWhereString(sql, 'PATTERN'),
        serverSide: /SERVER_SIDE\s*=\s*1/i.test(sql),
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesLike(value: string, pattern: string | undefined): boolean {
    if (!pattern) {
        return true;
    }
    const regex = `^${pattern.split('').map(character => {
        if (character === '%') {
            return '[\\s\\S]*';
        }
        if (character === '_') {
            return '.';
        }
        return escapeRegExp(character);
    }).join('')}$`;
    return new RegExp(regex, 'i').test(value);
}

function typeName(column: AccessColumnDefinition): string {
    switch (column.accessType) {
        case 'boolean': return 'BOOLEAN';
        case 'byte': return 'BYTE';
        case 'integer': return 'SHORT';
        case 'long': return 'LONG';
        case 'bigint': return 'BIGINT';
        case 'currency': return 'CURRENCY';
        case 'float': return 'SINGLE';
        case 'double': return 'DOUBLE';
        case 'datetime':
        case 'datetimextended': return 'DATETIME';
        case 'binary': return 'BINARY';
        case 'ole': return 'OLE';
        case 'memo': return 'MEMO';
        case 'numeric': return `DECIMAL(${column.precision ?? 18},${column.scale ?? 0})`;
        case 'repid': return 'GUID';
        case 'complex': return 'COMPLEX';
        case 'text': return `VARCHAR(${Math.max(1, Math.floor(column.size / 2))})`;
        default: return 'UNKNOWN';
    }
}

function metadataColumns(columns: readonly string[]): AccessMirrorColumn[] {
    return columns.map(name => ({ name, type: 'VARCHAR' }));
}

function result(columns: readonly string[], rows: readonly (readonly unknown[])[]): ExecutionResult {
    return { columns: metadataColumns(columns), rows, recordsAffected: -1 };
}

function tableDefinitions(session: AccessFileSession): AccessTableDefinition[] {
    return session.listTables(false);
}

type AccessWriteTask<T> = () => Promise<T>;
const accessFileWriteTails = new Map<string, Promise<void>>();
const accessFileVersions = new Map<string, number>();

function accessFileLockKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function currentAccessFileVersion(filePath: string): number {
    return accessFileVersions.get(accessFileLockKey(filePath)) ?? 0;
}

function markAccessFileChanged(filePath: string): number {
    const key = accessFileLockKey(filePath);
    const version = currentAccessFileVersion(filePath) + 1;
    accessFileVersions.set(key, version);
    return version;
}

async function withAccessFileWriteLock<T>(filePath: string, task: AccessWriteTask<T>): Promise<T> {
    const key = accessFileLockKey(filePath);
    const previous = accessFileWriteTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
        release = resolve;
    });
    accessFileWriteTails.set(key, current);
    await previous.catch(() => undefined);
    try {
        return await task();
    } finally {
        release();
        if (accessFileWriteTails.get(key) === current) {
            accessFileWriteTails.delete(key);
        }
    }
}

async function metadataResult(
    session: AccessFileSession,
    marker: MetadataMarker,
    mirror: AccessDuckDbMirror,
): Promise<ExecutionResult> {
    const tables = tableDefinitions(session);
    const queries = session.listQueryDefinitions();
    switch (marker.kind) {
        case 'databases':
            return result(['DATABASE'], [['default']]);
        case 'schemas':
            return result(['SCHEMA'], []);
        case 'tables':
        case 'views':
        case 'object_type': {
            const requestedType = marker.kind === 'views' ? 'VIEW' : marker.kind === 'object_type'
                ? marker.table?.toUpperCase() : 'TABLE';
            const rows = requestedType === 'VIEW'
                ? queries.filter(query => query.type === 'select')
                    .map(query => [query.name, query.objectId, 'VIEW', null, null])
                : requestedType === 'TABLE'
                    ? tables.map(table => [table.name, table.name, 'TABLE', null, null])
                    : [];
            return result(['OBJNAME', 'OBJID', 'OBJTYPE', 'SCHEMA', 'DESCRIPTION'], rows);
        }
        case 'type_groups':
            return result(['OBJTYPE'], [['TABLE'], ['VIEW']]);
        case 'procedures':
            return result(['OBJNAME'], []);
        case 'columns':
            return columnsMetadata(tables, queries, marker.table, mirror);
        case 'table_columns':
            return detailedColumnsMetadata(tables, queries, marker.table, false, mirror);
        case 'column_metadata':
            return detailedColumnsMetadata(tables, queries, marker.table, true, mirror);
        case 'table_comment':
            return result(['DESCRIPTION'], [['']]);
        case 'object_search':
            return objectSearchMetadata(tables, queries, marker.pattern);
        case 'view_source_search':
            return viewSourceMetadata(queries, marker.pattern, marker.serverSide);
        case 'procedure_source_search':
            return result(['NAME', 'SCHEMA', 'DATABASE', 'SOURCE'], []);
        case 'relationships': {
            const relationships = session.listRelationships();
            const rows = relationships
                .filter(relationship => !marker.table || relationship.table.localeCompare(marker.table, undefined, { sensitivity: 'accent' }) === 0)
                .map(relationship => [
                    relationship.name,
                    relationship.table,
                    relationship.columns.join(','),
                    relationship.foreignTable,
                    relationship.foreignColumns.join(','),
                    relationship.enforced ? 1 : 0,
                    relationship.updateCascade ? 1 : 0,
                    relationship.deleteCascade ? 1 : 0,
                ]);
            return result(['RELATIONSHIP', 'TABLE', 'COLUMN', 'FOREIGN_TABLE', 'FOREIGN_COLUMN', 'ENFORCED', 'UPDATE_CASCADE', 'DELETE_CASCADE'], rows);
        }
        case 'keys':
        case 'indexes': {
            const indexes = marker.table ? session.listIndexes(marker.table) : [];
            const rows = indexes
                .filter(index => marker.kind === 'keys'
                    ? index.primaryKey || index.unique
                    : !index.primaryKey && !index.unique)
                .map((index, position) => [
                    index.name || `${marker.kind === 'keys' ? 'Key' : 'Index'}${position + 1}`,
                    marker.kind === 'keys'
                        ? (index.primaryKey ? 'PRIMARY KEY' : 'UNIQUE')
                        : 'INDEX',
                    index.columns.join(', '),
                ]);
            return result(['NAME', 'KIND', 'DETAIL'], rows);
        }
        case 'triggers':
            return result(['NAME', 'KIND', 'DETAIL'], []);
        case 'linked_tables': {
            const linkedTables = session.listLinkedTables();
            const rows = linkedTables
                .filter(linked => !marker.table || linked.name.localeCompare(marker.table, undefined, { sensitivity: 'accent' }) === 0)
                .map(linked => [linked.name, linked.target, linked.foreignName]);
            return result(['OBJNAME', 'TARGET', 'FOREIGN_NAME'], rows);
        }
        default:
            throw new AccessFileError(`Unknown Access metadata marker '${marker.kind}'.`);
    }
}

interface MetadataColumn {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
    readonly isPrimaryKey: boolean;
    readonly isAuto: boolean;
    readonly isCalculated: boolean;
    readonly defaultValue?: string;
    readonly allowZeroLength?: boolean;
    readonly validationRule?: string;
    readonly validationText?: string;
}

/**
 * ACCDB calculated fields are variable-length LONG columns stored with a fixed
 * column size of 39 (their serialized evaluation-result cap). Plain LONG
 * columns are fixed-length 4-byte columns, so the two flags together
 * positively identify calculated fields. Calculated fields only exist in
 * ACCDB (2010+); Jet3/Jet4 .mdb files never carry them.
 */
function isCalculatedColumn(column: AccessColumnDefinition): boolean {
    return column.accessType === 'long' && !column.fixedLength && column.size === 39;
}

function findAccessTable(tables: readonly AccessTableDefinition[], requestedTable?: string): AccessTableDefinition | undefined {
    return tables.find(candidate => candidate.name.localeCompare(requestedTable ?? '', undefined, { sensitivity: 'accent' }) === 0);
}

async function metadataColumnsFor(
    tables: readonly AccessTableDefinition[],
    queries: readonly AccessQueryDefinition[],
    requestedTable: string | undefined,
    mirror: AccessDuckDbMirror,
): Promise<{ readonly name: string; readonly columns: readonly MetadataColumn[] } | undefined> {
    const table = findAccessTable(tables, requestedTable);
    if (table) {
        return {
            name: table.name,
            columns: table.columns.map(column => ({
                name: column.name,
                type: typeName(column),
                nullable: column.nullable,
                isPrimaryKey: column.isPrimaryKey,
                isAuto: column.autoLong || column.autoUuid,
                isCalculated: isCalculatedColumn(column),
                ...(column.defaultValue === undefined ? {} : { defaultValue: column.defaultValue }),
                ...(column.allowZeroLength === undefined ? {} : { allowZeroLength: column.allowZeroLength }),
                ...(column.validationRule === undefined ? {} : { validationRule: column.validationRule }),
                ...(column.validationText === undefined ? {} : { validationText: column.validationText }),
            })),
        };
    }
    const view = queries.find(query => query.type === 'select'
        && query.name.toLowerCase() === (requestedTable ?? '').toLowerCase());
    if (!view) {
        return undefined;
    }
    let columns: AccessMirrorColumn[] = [];
    try {
        columns = await mirror.readObjectColumns(view.name);
    } catch {
        // Unsupported saved queries remain listed as views but expose no
        // columns until the mirror can describe them.
    }
    return {
        name: view.name,
        columns: columns.map(column => ({
            name: column.name,
            type: column.type,
            nullable: true,
            isPrimaryKey: false,
            isAuto: false,
            isCalculated: false,
        })),
    };
}

async function columnsMetadata(
    tables: readonly AccessTableDefinition[],
    queries: readonly AccessQueryDefinition[],
    requestedTable: string | undefined,
    mirror: AccessDuckDbMirror,
): Promise<ExecutionResult> {
    const object = await metadataColumnsFor(tables, queries, requestedTable, mirror);
    const rows = (object?.columns ?? []).map((column, index) => [
        'default',
        null,
        object?.name ?? requestedTable ?? '',
        column.name,
        column.type,
        null,
        column.isPrimaryKey ? 1 : 0,
        0,
        index + 1,
    ]);
    return result(['DATABASE', 'SCHEMA', 'TABLENAME', 'ATTNAME', 'FORMAT_TYPE', 'DESCRIPTION', 'IS_PK', 'IS_FK', 'ATTNUM'], rows);
}

async function detailedColumnsMetadata(
    tables: readonly AccessTableDefinition[],
    queries: readonly AccessQueryDefinition[],
    requestedTable: string | undefined,
    includeMetadataFlag: boolean,
    mirror: AccessDuckDbMirror,
): Promise<ExecutionResult> {
    const object = await metadataColumnsFor(tables, queries, requestedTable, mirror);
    const rows = (object?.columns ?? []).map((column, index) => {
        const isAuto = column.isAuto ? 1 : 0;
        const isCalculated = column.isCalculated ? 1 : 0;
        const base = [
            column.name,
            column.type,
            column.type,
            column.nullable ? 0 : 1,
            column.defaultValue ?? null,
            null,
            column.isPrimaryKey ? 1 : 0,
            0,
            index + 1,
        ];
        const extended = [
            ...base,
            isAuto,
            isCalculated,
            column.allowZeroLength === undefined ? null : (column.allowZeroLength ? 1 : 0),
            column.validationRule ?? null,
            column.validationText ?? null,
        ];
        return includeMetadataFlag
            ? [base[0], base[1], base[2], base[3], base[3], base[4], base[5], base[6], base[7], base[8], isAuto, isCalculated,
                extended[11], extended[12], extended[13]]
            : extended;
    });
    return includeMetadataFlag
        ? result(['ATTNAME', 'FORMAT_TYPE', 'FULL_TYPE', 'ATTNOTNULL', 'IS_NOT_NULL', 'COLDEFAULT', 'DESCRIPTION', 'IS_PK', 'IS_FK', 'ATTNUM', 'IS_AUTO', 'IS_CALC', 'ALLOW_ZERO_LENGTH', 'VALIDATION_RULE', 'VALIDATION_TEXT'], rows)
        : result(['ATTNAME', 'FORMAT_TYPE', 'FULL_TYPE', 'IS_NOT_NULL', 'COLDEFAULT', 'DESCRIPTION', 'IS_PK', 'IS_FK', 'ATTNUM', 'IS_AUTO', 'IS_CALC', 'ALLOW_ZERO_LENGTH', 'VALIDATION_RULE', 'VALIDATION_TEXT'], rows);
}

function objectSearchMetadata(
    tables: readonly AccessTableDefinition[],
    queries: readonly AccessQueryDefinition[],
    pattern: string | undefined,
): ExecutionResult {
    const tableRows = tables
        .filter(table => matchesLike(table.name, pattern))
        .map(table => [1, table.name, null, 'default', 'TABLE', null, null, 'NAME']);
    const queryRows = queries
        .filter(query => query.type === 'select' && matchesLike(query.name, pattern))
        .map(query => [1, query.name, null, 'default', 'VIEW', null, null, 'NAME']);
    return result(
        ['PRIORITY', 'NAME', 'SCHEMA', 'DATABASE', 'TYPE', 'PARENT', 'DESCRIPTION', 'MATCH_TYPE'],
        [...tableRows, ...queryRows],
    );
}

function viewSourceMetadata(
    queries: readonly AccessQueryDefinition[],
    pattern: string | undefined,
    serverSide: boolean,
): ExecutionResult {
    const views = queries.filter(query => query.type === 'select');
    if (serverSide) {
        const matching = views.filter(query => matchesLike(query.sql ?? '', pattern));
        return result(
            ['NAME', 'SCHEMA', 'DATABASE'],
            matching.map(query => [query.name, 'default', 'default']),
        );
    }
    return result(
        ['NAME', 'SCHEMA', 'DATABASE', 'SOURCE'],
        views.map(query => [query.name, 'default', 'default', query.sql ?? '']),
    );
}

class AccessDataReader implements DatabaseDataReader {
    public readonly fieldCount: number;
    private readonly _buffer: unknown[][];
    private _readIndex = -1;
    private _closed = false;
    private _done = false;
    private readonly _iterator?: AsyncIterator<readonly (readonly unknown[])[]>;
    private readonly _schemaRows: { NumericScale?: number }[];
    private readonly _release?: () => void;
    private _released = false;

    public constructor(columns: readonly AccessMirrorColumn[], execution: ExecutionResult) {
        this.fieldCount = columns.length;
        this._buffer = execution.rows?.map(row => [...row]) ?? [];
        this._iterator = execution.rowChunks?.[Symbol.asyncIterator]();
        this._done = !this._iterator;
        this._schemaRows = columns.map(column => {
            const match = column.type.match(/DECIMAL\([^,]+,(\d+)\)/i);
            return match ? { NumericScale: Number(match[1]) } : {};
        });
        this._columns = columns;
        this._release = execution.release;
    }

    private readonly _columns: readonly AccessMirrorColumn[];

    public async read(): Promise<boolean> {
        if (this._closed) {
            return false;
        }
        while (this._readIndex + 1 >= this._buffer.length && !this._done && this._iterator) {
            const next = await this._iterator.next();
            if (next.done) {
                this._done = true;
                this.releaseQuery();
                break;
            }
            this._buffer.push(...next.value.map(row => [...row]));
        }
        if (this._readIndex + 1 >= this._buffer.length) {
            this.releaseQuery();
            return false;
        }
        this._readIndex++;
        return true;
    }

    public async nextResult(): Promise<boolean> {
        return false;
    }

    public async close(): Promise<void> {
        this._closed = true;
        this._done = true;
        await this._iterator?.return?.();
        this.releaseQuery();
    }

    public getName(index: number): string {
        return this._columns[index]?.name ?? '';
    }

    public getTypeName(index: number): string {
        return this._columns[index]?.type ?? '';
    }

    public getValue(index: number): unknown {
        return this._readIndex >= 0 ? this._buffer[this._readIndex]?.[index] : undefined;
    }

    public getSchemaTable(): { NumericScale?: number }[] {
        return this._schemaRows;
    }

    private releaseQuery(): void {
        if (this._released) return;
        this._released = true;
        this._release?.();
    }
}

export class AccessConnection extends EventEmitter implements DatabaseConnection {
    public _connected = false;
    private readonly _databasePath: string;
    private readonly _readOnly: boolean;
    private readonly _sessionId = `access-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    private readonly _mirror = new AccessDuckDbMirror();
    private _session?: AccessFileSession;
    private _lockRelease?: (() => Promise<void>) | null;
    private _connectPromise?: Promise<void>;
    private _snapshots: AccessTableSnapshot[] = [];
    private _lastInsertedIdentity?: number | bigint;
    private _nextQueryId = 1;
    private _queryTail: Promise<void> = Promise.resolve();
    private _activeExecution?: Promise<ExecutionResult>;
    private _activeQueryId?: number;
    private _activeQueryRelease?: () => void;
    private readonly _cancelledQueryIds = new Set<number>();
    private _observedFileVersion = 0;
    private _closing = false;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super();
        this._databasePath = resolveDatabaseLocation(config);
        this._readOnly = configuredReadOnly(config);
    }

    public getSessionId(): string {
        return this._sessionId;
    }

    public getCurrentCatalog(): string {
        return path.basename(this._databasePath, path.extname(this._databasePath)) || 'default';
    }

    public getCurrentSchema(): string {
        return 'default';
    }

    public async connect(): Promise<void> {
        if (this._connected) {
            return;
        }
        this._lastInsertedIdentity = undefined;
        if (!this._connectPromise) {
            this._connectPromise = this.openSession();
        }
        try {
            await this._connectPromise;
        } finally {
            this._connectPromise = undefined;
        }
    }

    private async openSession(): Promise<void> {
        const session = await AccessFileSession.open({
            filePath: this._databasePath,
            password: this.config.password,
            readOnly: this._readOnly,
        });
        try {
            if (!this._readOnly && !this._lockRelease) {
                this._lockRelease = await acquireAccessFileLock(this._databasePath, session.format);
            }
            await this._mirror.open(session);
            this._session = session;
            this._snapshots = await this._mirror.snapshotTables(session.listTables());
            this._observedFileVersion = currentAccessFileVersion(this._databasePath);
            this._connected = true;
        } catch (error) {
            await this.releaseLock();
            await this._mirror.close();
            await session.close();
            throw error;
        }
    }

    public async close(): Promise<void> {
        this._closing = true;
        try {
            const pendingConnection = this._connectPromise;
            if (pendingConnection) {
                await pendingConnection.catch(() => undefined);
            }
            this._mirror.interrupt();
            this._activeQueryRelease?.();
            await this._activeExecution?.catch(() => undefined);
            await this._queryTail.catch(() => undefined);
            this._queryTail = Promise.resolve();
            await this._mirror.close();
            const session = this._session;
            this._session = undefined;
            this._snapshots = [];
            this._lastInsertedIdentity = undefined;
            this._connected = false;
            await session?.close();
            await this.releaseLock();
            this.emit('close');
        } finally {
            this._closing = false;
        }
    }

    private async releaseLock(): Promise<void> {
        const release = this._lockRelease;
        this._lockRelease = undefined;
        await release?.();
    }

    public createCommand(sql: string): DatabaseCommand {
        return new AccessCommand(this, sql, this._nextQueryId++);
    }

    public async executeRaw(sql: string, queryId?: number): Promise<ExecutionResult> {
        if (this._closing) {
            throw new Error('Microsoft Access connection is closing.');
        }
        const ownerId = queryId ?? this._nextQueryId++;
        const previous = this._queryTail;
        let releaseQueue!: () => void;
        const current = new Promise<void>(resolve => {
            releaseQueue = resolve;
        });
        this._queryTail = current;
        await previous;
        if (this._cancelledQueryIds.delete(ownerId)) {
            releaseQueue();
            throw new Error('Query cancelled.');
        }
        if (this._closing) {
            releaseQueue();
            throw new Error('Microsoft Access connection is closing.');
        }
        this._activeQueryId = ownerId;
        const release = (): void => {
            if (this._activeQueryId === ownerId) {
                this._activeQueryId = undefined;
                this._activeQueryRelease = undefined;
            }
            this._cancelledQueryIds.delete(ownerId);
            releaseQueue();
        };
        this._activeQueryRelease = release;
        const executionPromise = this.executeRawUnlocked(sql, ownerId);
        this._activeExecution = executionPromise;
        try {
            const execution = await executionPromise;
            if (execution.rowChunks) {
                return { ...execution, release };
            }
            release();
            return execution;
        } catch (error) {
            release();
            throw error;
        } finally {
            if (this._activeExecution === executionPromise) {
                this._activeExecution = undefined;
            }
        }
    }

    private async executeRawUnlocked(sql: string, _queryId: number): Promise<ExecutionResult> {
        const statements = splitAccessStatements(sql);
        if (statements.length === 0) {
            return { columns: [], rows: [], recordsAffected: -1 };
        }
        let lastResult: ExecutionResult | undefined;
        for (const statement of statements) {
            lastResult = await this.executeSingleStatement(statement);
        }
        return lastResult ?? { columns: [], rows: [], recordsAffected: -1 };
    }

    private async executeSingleStatement(trimmedSql: string): Promise<ExecutionResult> {
        const compatibility = this.tryExecuteCompatibilityCommand(trimmedSql);
        if (compatibility) {
            return compatibility;
        }

        const metadataMarker = parseMetadataMarker(trimmedSql);
        if (metadataMarker) {
            return withAccessFileWriteLock(this._databasePath, async () => {
                await this.refreshSessionIfStale();
                return metadataResult(this.requireSession(), metadataMarker, this._mirror);
            });
        }

        if (startsWithAccessWriteStatement(trimmedSql)) {
            if (this._readOnly) {
                throw new Error('Microsoft Access connection is read-only. Disable "Open database as read-only" to execute writes.');
            }
            const truncateTarget = readAccessTruncateTarget(trimmedSql);
            if (truncateTarget) {
                return this.executeWrite(`DELETE FROM ${truncateTarget.lastRaw}`);
            }
            if (/^(?:CREATE|DROP|ALTER)\b/i.test(stripLeadingComments(trimmedSql))) {
                return this.executeDdl(trimmedSql);
            }
            if (!/^(?:INSERT|UPDATE|DELETE)\b/i.test(stripLeadingComments(trimmedSql))) {
                throw new Error('Unsupported statement. INSERT, UPDATE, DELETE and CREATE/DROP/ALTER are supported by the staged writer.');
            }
            return this.executeWrite(trimmedSql);
        }

        return withAccessFileWriteLock(this._databasePath, async () => {
            await this.refreshSessionIfStale();
            return this._mirror.execute(trimmedSql);
        });
    }

    /**
     * Executes a DDL statement (CREATE/DROP TABLE/INDEX/VIEW) against the
     * staged file copy through the direct-mutation engine, then reloads the
     * mirror so the new schema is immediately queryable.
     */
    private async executeDdl(sql: string): Promise<ExecutionResult> {
        this.requireSession();
        return withAccessFileWriteLock(this._databasePath, async () => {
            await this.refreshSessionIfStale();
            const session = this.requireSession();
            await session.writeAtomically(async context => {
                const buffer = await fs.readFile(context.stagedPath);
                const layout = jetLayoutFor(context.format);
                const channel = new JetPageChannel(buffer, layout);
                applyDdlSql(channel, sql);
                await fs.writeFile(context.stagedPath, channel.buffer);
            }, { verifyAllTables: true });
            await this.reloadSessionFromDisk();
            this._observedFileVersion = markAccessFileChanged(this._databasePath);
            return { columns: [], rows: [], recordsAffected: 0 };
        });
    }

    public async cancelQuery(queryId?: number): Promise<void> {
        if (queryId === undefined) {
            return;
        }
        this._cancelledQueryIds.add(queryId);
        if (this._activeQueryId === queryId) {
            this._mirror.interrupt();
        }
    }

    private async executeWrite(sql: string): Promise<ExecutionResult> {
        this.requireSession();
        return withAccessFileWriteLock(this._databasePath, async () => {
            await this.refreshSessionIfStale();
            const session = this.requireSession();
            const targetTable = writeTargetTableName(sql);
            if (!targetTable) {
                throw new Error('Access writes require an explicit target table.');
            }
            const definition = session.getTableDefinition(targetTable);
            if (definition.columns.some(column => column.accessType === 'complex')) {
                throw new Error(
                    `Writes to Access complex columns in table '${definition.name}' are not supported yet; use its flat child table.`,
                );
            }
            const beforeSnapshots = this._snapshots;
            const beforeTable = beforeSnapshots.find(snapshot => snapshot.definition.name.localeCompare(definition.name, undefined, { sensitivity: 'accent' }) === 0);
            if (!beforeTable) {
                throw new Error(`Access snapshot for table '${definition.name}' is not available.`);
            }
            const execution = await this._mirror.executeAndReadAll(normalizeAccessWriteTarget(sql));
            const afterTable = await this._mirror.snapshotTables([definition]).then(snapshots => snapshots[0]);
            if (!afterTable) {
                throw new Error(`Access snapshot for table '${definition.name}' could not be refreshed.`);
            }
            try {
                await session.writeAtomically(context => writeAccessSnapshotChanges(
                    context.stagedPath,
                    context.format,
                    [beforeTable],
                    [afterTable],
                    definition.name,
                ), { tableRowCounts: { [definition.name]: afterTable.rows.length } });
                const afterSnapshots = this._snapshots.map(snapshot => snapshot.definition.name.localeCompare(definition.name, undefined, { sensitivity: 'accent' }) === 0
                    ? afterTable
                    : snapshot);
                this._snapshots = afterSnapshots;
                const identity = insertedIdentityFromSnapshots(sql, beforeSnapshots, afterSnapshots);
                if (identity !== undefined) {
                    this._lastInsertedIdentity = identity;
                }
                this._observedFileVersion = markAccessFileChanged(this._databasePath);
                return execution;
            } catch (error) {
                await this.reloadSessionFromDisk();
                throw error;
            }
        });
    }

    private async reloadSessionFromDisk(): Promise<void> {
        const previousSession = this._session;
        await this._mirror.close();
        this._session = undefined;
        this._snapshots = [];
        await previousSession?.close();
        await this.openSession();
    }

    private async refreshSessionIfStale(): Promise<void> {
        if (this._observedFileVersion === currentAccessFileVersion(this._databasePath)) {
            return;
        }
        await this.reloadSessionFromDisk();
    }

    private requireSession(): AccessFileSession {
        if (!this._session) {
            throw new Error('Microsoft Access connection is not open.');
        }
        return this._session;
    }

    private tryExecuteCompatibilityCommand(sql: string): ExecutionResult | undefined {
        const identityMatch = sql.match(LAST_IDENTITY_QUERY);
        if (identityMatch) {
            const alias = identityMatch[1]
                ? unquoteAccessIdentifier(identityMatch[1])
                : '@@IDENTITY';
            return result([alias], [[this._lastInsertedIdentity ?? null]]);
        }
        if (CURRENT_CATALOG_AND_SCHEMA_QUERY.test(sql)) {
            return result(['CURRENT_CATALOG', 'CURRENT_SCHEMA'], [[this.getCurrentCatalog(), this.getCurrentSchema()]]);
        }
        if (CURRENT_CATALOG_QUERY.test(sql)) {
            return result(['CURRENT_CATALOG'], [[this.getCurrentCatalog()]]);
        }
        if (CURRENT_SCHEMA_QUERY.test(sql)) {
            return result(['CURRENT_SCHEMA'], [[this.getCurrentSchema()]]);
        }
        if (CURRENT_SID_QUERY.test(sql)) {
            return result(['CURRENT_SID'], [[this.getSessionId()]]);
        }
        if (SET_CATALOG_QUERY.test(sql) || SET_SCHEMA_QUERY.test(sql)) {
            return { columns: [], rows: [], recordsAffected: 0 };
        }
        return undefined;
    }
}

class AccessCommand implements DatabaseCommand {
    public commandTimeout = 0;
    public _recordsAffected = -1;
    private _cancelled = false;

    public constructor(
        private readonly _connection: AccessConnection,
        private readonly _sql: string,
        private readonly _queryId: number,
    ) {}

    public async executeReader(): Promise<DatabaseDataReader> {
        if (this._cancelled) {
            throw new Error('Query cancelled.');
        }
        const execution = await this._connection.executeRaw(this._sql, this._queryId);
        this._recordsAffected = execution.recordsAffected;
        return new AccessDataReader(execution.columns, execution);
    }

    public async cancel(): Promise<void> {
        this._cancelled = true;
        await this._connection.cancelQuery(this._queryId);
    }

    public async execute(): Promise<void> {
        const reader = await this.executeReader();
        await reader.close();
    }
}

export type { AccessValue };
