import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { buildLimitedSelectQuery } from '@justybase/dialect-utils';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../utils/identifierUtils';

/** Pseudo-column used by row-editing dialects to address a row for UPDATE/DELETE. */
export const EDIT_DATA_ROW_LOCATOR = 'ROWID';

/** How the Edit Data grid addresses a loaded row for UPDATE/DELETE. */
export type EditDataRowLocator =
    | { kind: 'rowid' }
    | { kind: 'primary-key'; columns: readonly string[] };

export interface EditDataQueryFilters {
    whereClause?: string;
    columns?: string;
    orderBy?: string;
}

export interface EditDataQueryPlan {
    /** Dialect-ready table reference shared by the SELECT and save DML. */
    qualifiedTableName: string;
    /** Complete SELECT statement for the Data tab. */
    sql: string;
}

/**
 * Builds the table reference used by the Edit Data panel.
 *
 * Netezza keeps its historical raw `DB.SCHEMA.TABLE` form (including
 * `DB..TABLE` for a missing schema) because its catalog labels are already in
 * canonical case. Every other dialect follows its qualification rules, so
 * PostgreSQL drops the database part and SQLite uses the catalog container.
 */
export function buildEditDataQualifiedTableName(
    database: string,
    schema: string,
    table: string,
    databaseKind?: string | DatabaseKind,
): string {
    const normalizedKind = databaseKind ? tryNormalizeDatabaseKind(databaseKind) : undefined;
    if (!normalizedKind || normalizedKind === 'netezza') {
        return `${database}.${schema}.${table}`;
    }
    if (!schema) {
        if (normalizedKind === 'sqlite' || normalizedKind === 'access') {
            return formatQualifiedObjectName(database, undefined, table, normalizedKind);
        }
        return formatIdentifierForSql(table, normalizedKind);
    }
    return formatQualifiedObjectName(database, schema, table, normalizedKind);
}

/**
 * Encodes the primary-key values of a row as a JSON text scalar. PostgreSQL has
 * no `ROWID`, so a table with a declared primary key uses that key as the
 * stable locator. Key values are cast to `text` before encoding so numeric
 * precision survives the JSON round trip and the save predicate can compare the
 * literal against the column's own type.
 */
export function buildPrimaryKeyLocatorExpression(
    columns: readonly string[],
    databaseKind?: string | DatabaseKind,
): string {
    const normalizedKind = databaseKind ? tryNormalizeDatabaseKind(databaseKind) : undefined;
    if (normalizedKind !== 'postgresql') {
        throw new Error('Primary-key row locators are only implemented for PostgreSQL.');
    }
    if (columns.length === 0) {
        throw new Error('A primary-key row locator needs at least one column.');
    }
    const args = columns
        .map(column => `${formatIdentifierForSql(column, normalizedKind)}::text`)
        .join(', ');
    return `pg_catalog.jsonb_build_array(${args})::text`;
}

/**
 * Parses the JSON locator emitted by {@link buildPrimaryKeyLocatorExpression}
 * and turns it into a `WHERE` predicate. The webview round-trips the scalar
 * unchanged, so validation stays here, next to the SQL that consumes it.
 */
export function buildPrimaryKeyLocatorPredicate(
    rowLocator: unknown,
    columns: readonly string[],
    databaseKind?: string | DatabaseKind,
): string {
    const values = parsePrimaryKeyLocatorValues(rowLocator, columns);
    return columns
        .map((column, index) => {
            const identifier = formatIdentifierForSql(column, databaseKind);
            const value = values[index];
            return value === null ? `${identifier} IS NULL` : `${identifier} = ${formatLocatorValue(value)}`;
        })
        .join(' AND ');
}

function parsePrimaryKeyLocatorValues(rowLocator: unknown, columns: readonly string[]): unknown[] {
    const text = typeof rowLocator === 'string'
        ? rowLocator
        : typeof rowLocator === 'number'
            ? String(rowLocator)
            : '';
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Invalid primary-key row locator: "${String(rowLocator)}".`);
    }
    if (!Array.isArray(parsed) || parsed.length !== columns.length) {
        throw new Error(`Invalid primary-key row locator for ${columns.length} column(s): "${String(rowLocator)}".`);
    }
    return parsed.map(value => {
        if (
            value === null
            || typeof value === 'string'
            || typeof value === 'boolean'
            || (typeof value === 'number' && Number.isFinite(value))
        ) {
            return value;
        }
        throw new Error(`Unsupported primary-key value in row locator: "${String(value)}".`);
    });
}

/** Locator values are already decoded JSON, so an empty string stays an empty string. */
function formatLocatorValue(value: unknown): string {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    const escaped = String(value).replace(/'/g, "''");
    // An escape string keeps backslashes literal regardless of the server's
    // standard_conforming_strings setting.
    return escaped.includes('\\')
        ? `E'${escaped.replace(/\\/g, '\\\\')}'`
        : `'${escaped}'`;
}

/**
 * Builds the Data-tab SELECT. Dialects with a native row locator receive
 * `ROWID`; PostgreSQL tables with a primary key receive the encoded key instead.
 * Everything else uses a plain bounded projection so View Data still works
 * read-only.
 */
export function buildEditDataQueryPlan(params: {
    database: string;
    schema: string;
    table: string;
    databaseKind?: string | DatabaseKind;
    editable: boolean;
    /** Primary-key columns to use instead of a native `ROWID` locator. */
    primaryKeyColumns?: readonly string[];
    filters?: EditDataQueryFilters;
    rowLimit: number;
}): EditDataQueryPlan {
    const normalizedKind = params.databaseKind ? tryNormalizeDatabaseKind(params.databaseKind) : undefined;
    const qualifiedTableName = buildEditDataQualifiedTableName(
        params.database,
        params.schema,
        params.table,
        params.databaseKind,
    );

    const where = stripLeadingKeyword(params.filters?.whereClause, /^WHERE\s+/i);
    const orderBy = stripLeadingKeyword(params.filters?.orderBy, /^ORDER\s+BY\s+/i);
    const primaryKeyColumns = (params.primaryKeyColumns ?? [])
        .map(column => column.trim())
        .filter(column => column.length > 0);
    const usePrimaryKeyLocator = params.editable && primaryKeyColumns.length > 0;

    // Alias the locator explicitly: SQLite/duckdb report the bare `rowid`
    // column in lower case, while the webview tracks rows by `ROWID`.
    let locatorProjection = `${EDIT_DATA_ROW_LOCATOR} AS ${EDIT_DATA_ROW_LOCATOR}`;
    let defaultOrderBy = EDIT_DATA_ROW_LOCATOR;
    if (usePrimaryKeyLocator) {
        locatorProjection = `${buildPrimaryKeyLocatorExpression(primaryKeyColumns, normalizedKind)} AS "${EDIT_DATA_ROW_LOCATOR}"`;
        defaultOrderBy = primaryKeyColumns
            .map(column => formatIdentifierForSql(column, normalizedKind))
            .join(', ');
    }

    let selectList = params.editable ? `${locatorProjection}, *` : '*';
    const explicitColumns = params.filters?.columns?.trim();
    if (explicitColumns) {
        selectList = params.editable && !/\bROWID\b/i.test(explicitColumns)
            ? `${locatorProjection}, ${explicitColumns}`
            : explicitColumns;
    }

    const sql = buildLimitedSelectQuery({
        selectList,
        from: qualifiedTableName,
        where,
        orderBy: params.editable ? orderBy || defaultOrderBy : orderBy,
        limit: params.rowLimit,
        kind: normalizedKind,
    });

    return { qualifiedTableName, sql };
}

function stripLeadingKeyword(clause: string | undefined, keyword: RegExp): string {
    return (clause || '').trim().replace(keyword, '').trim();
}
