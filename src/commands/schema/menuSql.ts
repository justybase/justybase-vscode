/**
 * Schema Commands - Menu SQL Generators
 *
 * Pure SQL builders for schema-tree context actions (count rows, duplicate
 * search, CTAS, routine calls, index DDL, storage options, value search).
 * Ported from the Tauri SchemaBrowser helpers so both shells generate the
 * same dialect-specific statements; all builders are unit-testable without
 * a connection.
 */

import type { DatabaseKind } from '../../contracts/database';
import { formatIdentifierForSql } from '../../utils/identifierUtils';

export function countRowsSql(qualifiedName: string): string {
    return `SELECT COUNT(*) AS row_count FROM ${qualifiedName};`;
}

export function duplicateRowsSql(qualifiedName: string, quotedColumns: string): string {
    const columns = quotedColumns.trim();
    if (!columns) throw new Error('Choose at least one column to find duplicate values.');
    return `SELECT ${columns}, COUNT(*) AS duplicate_count\nFROM ${qualifiedName}\nGROUP BY ${columns}\nHAVING COUNT(*) > 1\nORDER BY duplicate_count DESC;`;
}

export interface IndexDesignOptions {
    unique?: boolean;
    method?: string;
    includeColumns?: string;
    predicate?: string;
    concurrently?: boolean;
    clustered?: boolean;
    compress?: boolean;
    pctFree?: number;
}

export type AlterColumnChange =
    | { operation: 'setType'; dataType: string; using?: string }
    | { operation: 'setNotNull' }
    | { operation: 'dropNotNull' }
    | { operation: 'setDefault'; expression: string }
    | { operation: 'dropDefault' };

export type PostgresTableStorageChange =
    | { operation: 'setFillfactor'; value: number }
    | { operation: 'resetFillfactor' }
    | { operation: 'setTablespace'; name: string };

export function postgresTableStorageSql(qualifiedTableName: string, change: PostgresTableStorageChange): string {
    if (change.operation === 'setFillfactor') {
        if (!Number.isInteger(change.value) || change.value < 10 || change.value > 100) {
            throw new Error('PostgreSQL table fillfactor must be a whole number from 10 to 100.');
        }
        return `ALTER TABLE ${qualifiedTableName} SET (fillfactor = ${change.value});`;
    }
    if (change.operation === 'resetFillfactor') return `ALTER TABLE ${qualifiedTableName} RESET (fillfactor);`;
    const tablespace = change.name.trim();
    if (!/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(tablespace)) throw new Error('Enter a valid PostgreSQL tablespace name.');
    return `ALTER TABLE ${qualifiedTableName} SET TABLESPACE "${tablespace.replace(/"/g, '""')}";`;
}

export function isSafeSqlDataType(dataType: string): boolean {
    const tokens = dataType.trim().split(/\s+/);
    return tokens.length > 0 && tokens.every(token =>
        /^(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$#]*)(?:\.(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$#]*))?(?:\(\d+(?:,\d+)*\))?(?:\[\])*$/u.test(token),
    );
}

export function isSafeSqliteAddColumnDefault(expression: string): boolean {
    return /^(?:NULL|TRUE|FALSE|-?\d+(?:\.\d+)?|'(?:[^']|'')*'|X'[\da-f]*')$/i.test(expression.trim());
}

export interface SchemaValueSearchTarget {
    location: string;
    qualifiedTableName: string;
    quotedColumnName: string;
    dataType: string;
}

const SCHEMA_VALUE_SEARCH_KINDS: ReadonlySet<string> = new Set(['netezza', 'postgresql', 'db2', 'sqlite', 'duckdb']);
export type SchemaValueSearchKind = 'netezza' | 'postgresql' | 'db2' | 'sqlite' | 'duckdb';
const NUMERIC_COLUMN_TYPE = /\b(?:BYTEINT|TINYINT|SMALLINT|INTEGER|INT[248]?|BIGINT|HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|DECIMAL|NUMERIC|NUMBER|REAL|DOUBLE|FLOAT[48]?|DECFLOAT|MONEY)\b/i;
const TEXT_COLUMN_TYPE = /\b(?:CHAR|CHARACTER|NCHAR|NVARCHAR|VARCHAR|VARYING|TEXT|GRAPHIC|VARGRAPHIC)\b/i;
const NUMERIC_LITERAL = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

export function supportsSchemaValueSearch(kind: string | undefined): kind is SchemaValueSearchKind {
    return kind != null && SCHEMA_VALUE_SEARCH_KINDS.has(kind);
}

function sqlStringLiteral(value: string, kind: SchemaValueSearchKind): string {
    const escaped = kind === 'netezza' ? value.replace(/\\/g, '\\\\') : value;
    return `'${escaped.replace(/'/g, "''")}'`;
}

function schemaSearchCastType(kind: SchemaValueSearchKind): string {
    switch (kind) {
        case 'netezza': return 'VARCHAR(64000)';
        case 'db2': return 'VARCHAR(32672)';
        case 'postgresql': case 'sqlite': return 'TEXT';
        case 'duckdb': return 'VARCHAR';
        default: throw new Error('Value search is supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB.');
    }
}

function isSchemaTextType(kind: SchemaValueSearchKind, dataType: string): boolean {
    if (/FOR BIT DATA|\b(?:CLOB|DBCLOB|NCLOB|XML)\b/i.test(dataType)) return false;
    if (kind === 'netezza' && /\b(?:NCHAR|NVARCHAR|NATIONAL\s+CHAR(?:ACTER)?(?:\s+VARYING)?)\b/i.test(dataType)) return false;
    if (TEXT_COLUMN_TYPE.test(dataType)) return true;
    return (kind === 'postgresql' || kind === 'sqlite' || kind === 'duckdb') && /\bJSONB?\b/i.test(dataType);
}

export function schemaValueSearchSql(kind: string | undefined, value: string, targets: SchemaValueSearchTarget[]): string {
    if (!supportsSchemaValueSearch(kind)) throw new Error('Value search is supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB.');
    if (!value.trim()) throw new Error('Enter text or a number to search for.');
    if (value.length > 8000) throw new Error('Search text must be 8,000 characters or fewer.');
    const searchable = targets.filter(target => NUMERIC_COLUMN_TYPE.test(target.dataType) || isSchemaTextType(kind, target.dataType));
    if (!searchable.length) throw new Error('No text or numeric columns were found in the selected tables.');
    const numericValue = value.trim();
    const isNumeric = NUMERIC_LITERAL.test(numericValue);
    const textCastType = schemaSearchCastType(kind);
    const textTargets = searchable.filter(target => isSchemaTextType(kind, target.dataType));
    const escapedPattern = `%${value.replace(/[!%_]/g, character => `!${character}`)}%`;
    const withClause = textTargets.length
        ? `WITH search_input(search_text) AS (VALUES (LOWER(CAST(${sqlStringLiteral(escapedPattern, kind)} AS ${textCastType}))))\n`
        : '';
    const selects = searchable.map(target => {
        const numericColumn = NUMERIC_COLUMN_TYPE.test(target.dataType);
        const predicate = numericColumn && isNumeric
            ? `${target.quotedColumnName} = ${numericValue}`
            : isSchemaTextType(kind, target.dataType)
                ? `LOWER(CAST(${target.quotedColumnName} AS ${textCastType})) LIKE search_input.search_text ESCAPE '!'`
                : undefined;
        if (!predicate) return undefined;
        const from = isSchemaTextType(kind, target.dataType)
            ? `${target.qualifiedTableName}\nCROSS JOIN search_input`
            : target.qualifiedTableName;
        return `SELECT ${sqlStringLiteral(target.location, kind)} AS match_location, SUBSTR(CAST(${target.quotedColumnName} AS ${textCastType}), 1, 16000) AS match_value\nFROM ${from}\nWHERE ${predicate}`;
    }).filter((select): select is string => select !== undefined);
    if (!selects.length) throw new Error(isNumeric ? 'No searchable text or numeric columns were found.' : 'No text columns were found for this value.');
    return `-- Each match_value contains at most the first 16,000 characters.\n${withClause}${selects.join('\nUNION ALL\n')};`;
}

function requiredSqlExpression(value: string, label: string): string {
    const expression = value.trim();
    if (!expression || expression.includes(';')) throw new Error(`Enter one ${label} expression without a statement terminator.`);
    return expression;
}

export function alterColumnSql(
    kind: string | undefined,
    qualifiedTableName: string,
    quotedColumnName: string,
    change: AlterColumnChange,
): string {
    if (kind !== 'postgresql' && kind !== 'db2' && kind !== 'duckdb') {
        throw new Error('Column type, nullability, and default changes are available here for PostgreSQL, Db2, and DuckDB.');
    }
    const prefix = `ALTER TABLE ${qualifiedTableName} ALTER COLUMN ${quotedColumnName} `;
    if (change.operation === 'setType') {
        const dataType = change.dataType.trim();
        if (!isSafeSqlDataType(dataType)) throw new Error('Enter a SQL type made of type names and optional numeric parameters.');
        const using = change.using?.trim() ? ` USING ${requiredSqlExpression(change.using, 'conversion')}` : '';
        if (kind === 'db2' && using) throw new Error('Db2 converts compatible column types directly and does not use a PostgreSQL USING clause.');
        return `${prefix}${kind === 'db2' || kind === 'duckdb' ? 'SET DATA TYPE' : 'TYPE'} ${dataType}${using};`;
    }
    if (change.operation === 'setNotNull') return `${prefix}SET NOT NULL;`;
    if (change.operation === 'dropNotNull') return `${prefix}DROP NOT NULL;`;
    if (change.operation === 'setDefault') return `${prefix}SET DEFAULT ${requiredSqlExpression(change.expression, 'default')};`;
    return `${prefix}DROP DEFAULT;`;
}

export function createIndexSql(
    kind: string | undefined,
    qualifiedIndexName: string,
    qualifiedTableName: string,
    quotedColumns: string,
    options: IndexDesignOptions = {},
): string {
    const columns = quotedColumns.trim();
    if (!columns) throw new Error('Choose at least one index key column.');
    const include = options.includeColumns?.trim();
    const unique = options.unique ? 'UNIQUE ' : '';
    if (kind === 'postgresql') {
        const method = (options.method ?? 'btree').toLowerCase();
        if (!['btree', 'hash', 'gist', 'spgist', 'gin', 'brin'].includes(method)) {
            throw new Error('Choose a supported PostgreSQL index method.');
        }
        if (options.unique && method !== 'btree') {
            throw new Error('PostgreSQL unique indexes currently require the btree method.');
        }
        if (include && !['btree', 'gist', 'spgist'].includes(method)) {
            throw new Error(`PostgreSQL ${method} indexes do not support INCLUDE columns.`);
        }
        const concurrently = options.concurrently ? ' CONCURRENTLY' : '';
        const included = include ? ` INCLUDE (${include})` : '';
        const predicate = options.predicate?.trim() ? ` WHERE ${options.predicate.trim().replace(/;\s*$/, '')}` : '';
        return `CREATE ${unique}INDEX${concurrently} ${qualifiedIndexName} ON ${qualifiedTableName} USING ${method} (${columns})${included}${predicate};`;
    }
    if (kind === 'db2') {
        if (options.pctFree != null && (!Number.isInteger(options.pctFree) || options.pctFree < 0 || options.pctFree > 99)) {
            throw new Error('Db2 PCTFREE must be a whole number from 0 to 99.');
        }
        const included = include ? ` INCLUDE (${include})` : '';
        const clustered = options.clustered ? ' CLUSTER' : '';
        const compress = options.compress ? ' COMPRESS YES' : '';
        const pctFree = options.pctFree == null ? '' : ` PCTFREE ${options.pctFree}`;
        return `CREATE ${unique}INDEX ${qualifiedIndexName} ON ${qualifiedTableName} (${columns})${included}${clustered}${compress}${pctFree};`;
    }
    return `CREATE ${unique}INDEX ${qualifiedIndexName} ON ${qualifiedTableName} (${columns});`;
}

export function createTableFromSql(
    kind: string | undefined,
    target: string,
    source: string,
    whereClause = '',
): string {
    const predicate = whereClause.trim().replace(/;\s*$/, '');
    const select = `SELECT * FROM ${source}${predicate ? ` WHERE ${predicate}` : ''}`;
    if (kind === 'netezza') return `CREATE TABLE ${target} AS (${select}) DISTRIBUTE ON RANDOM;`;
    if (kind === 'db2') return `CREATE TABLE ${target} AS (${select}) WITH DATA;`;
    return `CREATE TABLE ${target} AS ${select};`;
}

export function callRoutineSql(
    kind: string | undefined,
    objectType: 'FUNCTION' | 'PROCEDURE',
    qualifiedName: string,
    argumentsSql = '',
): string {
    const args = argumentsSql.trim();
    if (objectType === 'PROCEDURE') {
        if (kind === 'oracle') return `BEGIN\n  ${qualifiedName}(${args});\nEND;\n/`;
        if (kind === 'sqlite') throw new Error('SQLite does not support stored procedures.');
        return `CALL ${qualifiedName}(${args});`;
    }
    const invocation = `${qualifiedName}(${args})`;
    if (kind === 'db2') return `VALUES ${invocation};`;
    if (kind === 'oracle') return `SELECT ${invocation} AS result FROM DUAL;`;
    return `SELECT ${invocation};`;
}

export function quoteIdentifierForKind(identifier: string, kind?: string | DatabaseKind): string {
    return formatIdentifierForSql(identifier, kind);
}

export function quoteIdentifierListForKind(identifiers: string, kind?: string | DatabaseKind): string {
    return identifiers
        .split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .map(part => formatIdentifierForSql(part, kind))
        .join(', ');
}
