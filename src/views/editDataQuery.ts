import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { buildLimitedSelectQuery } from '@justybase/dialect-utils';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../utils/identifierUtils';

/** Pseudo-column used by row-editing dialects to address a row for UPDATE/DELETE. */
export const EDIT_DATA_ROW_LOCATOR = 'ROWID';

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
 * Builds the Data-tab SELECT. Only dialects that expose a stable row locator
 * receive `ROWID`; the rest use a plain bounded projection so View Data still
 * works on PostgreSQL and other read-only-capable dialects.
 */
export function buildEditDataQueryPlan(params: {
    database: string;
    schema: string;
    table: string;
    databaseKind?: string | DatabaseKind;
    editable: boolean;
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
    // Alias the locator explicitly: SQLite/duckdb report the bare `rowid`
    // column in lower case, while the webview tracks rows by `ROWID`.
    const rowIdProjection = `${EDIT_DATA_ROW_LOCATOR} AS ${EDIT_DATA_ROW_LOCATOR}`;
    let selectList = params.editable ? `${rowIdProjection}, *` : '*';
    const explicitColumns = params.filters?.columns?.trim();
    if (explicitColumns) {
        selectList = params.editable && !/\bROWID\b/i.test(explicitColumns)
            ? `${rowIdProjection}, ${explicitColumns}`
            : explicitColumns;
    }

    const sql = buildLimitedSelectQuery({
        selectList,
        from: qualifiedTableName,
        where,
        orderBy: params.editable ? orderBy || EDIT_DATA_ROW_LOCATOR : orderBy,
        limit: params.rowLimit,
        kind: normalizedKind,
    });

    return { qualifiedTableName, sql };
}

function stripLeadingKeyword(clause: string | undefined, keyword: RegExp): string {
    return (clause || '').trim().replace(keyword, '').trim();
}
