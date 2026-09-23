import type { DatabaseKind } from '../contracts/database';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../utils/identifierUtils';
import { escapeSqlLiteral } from '../utils/sqlUtils';
import { getRelatedColumnRole, normalizeRelatedColumnName } from '../utils/relatedColumnNames';

export interface RelatedRowColumn {
    name: string;
    type?: string;
    isPk?: boolean;
    isFk?: boolean;
}

export interface RelatedRowTable {
    database: string;
    schema?: string;
    table: string;
    columns: RelatedRowColumn[];
}

export interface RelatedRowCandidate {
    database: string;
    schema?: string;
    table: string;
    sourceColumn: RelatedRowColumn;
    targetColumn: RelatedRowColumn;
    direction: 'referenced' | 'referencing' | 'matching';
    confidence: 'key' | 'name';
}

function objectKey(database: string, schema: string | undefined, table: string): string {
    return `${database.toUpperCase()}|${(schema ?? '').toUpperCase()}|${table.toUpperCase()}`;
}

/** Resolve exact normalized column names and prefer declared PK/FK roles. */
export function findRelatedRowCandidates(
    source: RelatedRowTable,
    sourceColumn: RelatedRowColumn,
    tables: RelatedRowTable[],
): RelatedRowCandidate[] {
    const normalizedName = normalizeRelatedColumnName(sourceColumn.name);
    if (!normalizedName) return [];
    const sourceRole = getRelatedColumnRole(sourceColumn);
    const matching: RelatedRowCandidate[] = [];

    for (const table of tables) {
        if (objectKey(table.database, table.schema, table.table) === objectKey(source.database, source.schema, source.table)) {
            continue;
        }
        for (const targetColumn of table.columns) {
            if (normalizeRelatedColumnName(targetColumn.name) !== normalizedName) continue;
            const targetRole = getRelatedColumnRole(targetColumn);
            if ((sourceRole === 'foreign' && targetRole === 'foreign')
                || (sourceRole === 'key' && targetRole === 'key')) {
                continue;
            }

            const oppositeRoles = (sourceRole === 'foreign' && targetRole === 'key')
                || (sourceRole === 'key' && targetRole === 'foreign');
            matching.push({
                database: table.database,
                schema: table.schema,
                table: table.table,
                sourceColumn,
                targetColumn,
                direction: sourceRole === 'foreign' ? 'referenced' : sourceRole === 'key' ? 'referencing' : 'matching',
                confidence: oppositeRoles ? 'key' : 'name',
            });
        }
    }

    const countsByName = new Map<string, number>();
    for (const candidate of matching) {
        const key = normalizeRelatedColumnName(candidate.targetColumn.name);
        countsByName.set(key, (countsByName.get(key) ?? 0) + 1);
    }
    const keyMatches = matching.filter((candidate) => candidate.confidence === 'key');
    const heuristicMatches = matching.filter((candidate) =>
        candidate.confidence === 'name' && (countsByName.get(normalizeRelatedColumnName(candidate.targetColumn.name)) ?? 0) === 1,
    );
    return [...keyMatches, ...heuristicMatches];
}

function numericType(dataType: string | undefined): boolean {
    return /int|numeric|decimal|number|float|double|real|serial/i.test(dataType ?? '');
}

function booleanType(dataType: string | undefined): boolean {
    return /bool|bit/i.test(dataType ?? '');
}

function dateLiteral(value: Date, dataType: string | undefined): string {
    const pad = (part: number, size = 2) => String(part).padStart(size, '0');
    const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const isDateOnly = /date/i.test(dataType ?? '') && !/time|timestamp/i.test(dataType ?? '');
    if (isDateOnly) return escapeSqlLiteral(date);
    return escapeSqlLiteral(`${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`);
}

function valueLiteral(value: unknown, dataType?: string): string {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Date) return dateLiteral(value, dataType);
    if (booleanType(dataType)) {
        if (value === true || value === 1 || String(value).toLowerCase() === 'true') return 'TRUE';
        if (value === false || value === 0 || String(value).toLowerCase() === 'false') return 'FALSE';
        throw new Error('The selected value is not a valid boolean.');
    }
    if (numericType(dataType)) {
        const text = typeof value === 'number' ? String(value) : String(value);
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error('The selected numeric value is not finite.');
        }
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
            throw new Error('The selected numeric value could not be safely represented.');
        }
        return text;
    }
    if (typeof value === 'string') return escapeSqlLiteral(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    throw new Error('This cell value type cannot be used for related-row navigation.');
}

export function buildRelatedRowsSql(options: {
    database: string;
    schema?: string;
    table: string;
    column: string;
    dataType?: string;
    value: unknown;
    databaseKind?: DatabaseKind;
    limit?: number;
}): string {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error('Related-row query limit must be between 1 and 1000.');
    }
    const tableName = formatQualifiedObjectName(
        options.database,
        options.schema,
        options.table,
        options.databaseKind,
    );
    const columnName = formatIdentifierForSql(options.column, options.databaseKind);
    const value = valueLiteral(options.value, options.dataType);
    const predicate = value === 'NULL' ? `${columnName} IS NULL` : `${columnName} = ${value}`;
    const kind = options.databaseKind;
    if (kind === 'mssql') {
        return `SELECT TOP (${limit}) * FROM ${tableName} WHERE ${predicate}`;
    }
    if (kind === 'access') {
        return `SELECT TOP ${limit} * FROM ${tableName} WHERE ${predicate}`;
    }
    if (kind === 'oracle' || kind === 'db2') {
        return `SELECT * FROM ${tableName} WHERE ${predicate} FETCH FIRST ${limit} ROWS ONLY`;
    }
    return `SELECT * FROM ${tableName} WHERE ${predicate} LIMIT ${limit}`;
}
