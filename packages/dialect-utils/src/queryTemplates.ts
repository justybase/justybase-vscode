import type { DatabaseKind } from '@justybase/contracts';
import { normalizeDatabaseKind } from '@justybase/contracts';
import { getDatabaseDialectTraits } from './dialectTraits';
import { quoteIdentifierForKind, stripIdentifierQuoting } from './identifierUtils';

export interface QueryObjectNameParts {
    database?: string;
    schema?: string;
    objectName: string;
}

function optionalPart(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function quoteQueryIdentifier(value: string, kind: DatabaseKind): string {
    const normalized = stripIdentifierQuoting(value, kind);
    if (!normalized) throw new Error('SQL identifier cannot be empty.');
    if (kind === 'mssql') return `[${normalized.replace(/]/g, ']]')}]`;
    return quoteIdentifierForKind(normalized, kind);
}

/** Quotes one metadata identifier using the target dialect's native delimiter. */
export function quoteIdentifierForQuery(value: string, kind: DatabaseKind = 'netezza'): string {
    return quoteQueryIdentifier(value, normalizeDatabaseKind(kind));
}

/** Formats a metadata object reference according to the target dialect. */
export function formatQueryObjectName(parts: QueryObjectNameParts, kind: DatabaseKind = 'netezza'): string {
    const normalizedKind = normalizeDatabaseKind(kind);
    const traits = getDatabaseDialectTraits(normalizedKind).qualification;
    const database = optionalPart(parts.database);
    const schema = optionalPart(parts.schema);
    const object = quoteQueryIdentifier(parts.objectName, normalizedKind);

    if (traits.twoPartNameStyle === 'database-object') {
        const container = traits.twoPartContainerPreference === 'schema-over-database'
            ? schema ?? database
            : database ?? schema;
        return container ? `${quoteQueryIdentifier(container, normalizedKind)}.${object}` : object;
    }

    if (database && schema && traits.supportsThreePartName) {
        return [database, schema, parts.objectName]
            .map(part => quoteQueryIdentifier(part, normalizedKind))
            .join('.');
    }
    if (schema) return `${quoteQueryIdentifier(schema, normalizedKind)}.${object}`;
    if (database) {
        if (traits.databaseOnlyReferenceStyle === 'double-dot') {
            return `${quoteQueryIdentifier(database, normalizedKind)}..${object}`;
        }
        if (traits.databaseOnlyReferenceStyle === 'single-dot') {
            return `${quoteQueryIdentifier(database, normalizedKind)}.${object}`;
        }
    }
    return object;
}

/** Formats a database/schema node without inventing a third object segment. */
export function formatQuerySchemaName(databaseName: string | undefined, schemaName: string, kind: DatabaseKind = 'netezza'): string {
    const normalizedKind = normalizeDatabaseKind(kind);
    const traits = getDatabaseDialectTraits(normalizedKind).qualification;
    const database = optionalPart(databaseName);
    const schema = optionalPart(schemaName);
    if (!schema) throw new Error('SQL schema cannot be empty.');

    if (traits.twoPartNameStyle === 'database-object') {
        const container = traits.twoPartContainerPreference === 'schema-over-database' ? schema : database ?? schema;
        return quoteQueryIdentifier(container, normalizedKind);
    }
    if (database && traits.supportsThreePartName) return `${quoteQueryIdentifier(database, normalizedKind)}.${quoteQueryIdentifier(schema, normalizedKind)}`;
    return quoteQueryIdentifier(schema, normalizedKind);
}

function validatedLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Result preview limit must be a positive safe integer.');
    return limit;
}

/** Builds the read-only object preview used by both schema explorers. */
export function buildTopRowsQuery(parts: QueryObjectNameParts, kind: DatabaseKind = 'netezza', limit = 1000): string {
    const normalizedKind = normalizeDatabaseKind(kind);
    const safeLimit = validatedLimit(limit);
    const objectName = formatQueryObjectName(parts, normalizedKind);

    if (normalizedKind === 'mssql' || normalizedKind === 'access') {
        return `SELECT TOP ${safeLimit} *\nFROM ${objectName}`;
    }
    if (normalizedKind === 'oracle') {
        return `SELECT *\nFROM ${objectName}\nWHERE ROWNUM <= ${safeLimit}`;
    }
    if (normalizedKind === 'db2') {
        return `SELECT *\nFROM ${objectName}\nFETCH FIRST ${safeLimit} ROWS ONLY`;
    }
    return `SELECT *\nFROM ${objectName}\nLIMIT ${safeLimit}`;
}

/**
 * Builds an explain statement/script without pretending that every database
 * accepts PostgreSQL/Netezza's EXPLAIN prefix.
 */
export function buildExplainQuery(sql: string, kind: DatabaseKind = 'netezza'): string {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL is required for an explain plan.');
    const normalizedKind = normalizeDatabaseKind(kind);

    switch (normalizedKind) {
        case 'sqlite':
            return /^(?:SELECT|WITH)\b/i.test(trimmed) ? `EXPLAIN QUERY PLAN ${trimmed}` : `EXPLAIN ${trimmed}`;
        case 'duckdb':
        case 'file':
        case 'mysql':
        case 'vertica':
            return `EXPLAIN ${trimmed}`;
        case 'postgresql':
            return `EXPLAIN (VERBOSE, COSTS, FORMAT TEXT) ${trimmed}`;
        case 'db2':
        case 'oracle':
            return `EXPLAIN PLAN FOR ${trimmed}`;
        case 'clickhouse':
            return `EXPLAIN PLAN ${trimmed}`;
        case 'mssql':
            // SHOWPLAN must be the only statement in each batch. GO is the
            // standard SQL Server client batch separator, so this is an
            // executable script in sqlcmd/SSMS-like clients.
            return `SET SHOWPLAN_TEXT ON;\nGO\n${trimmed}${trimmed.endsWith(';') ? '' : ';'}\nGO\nSET SHOWPLAN_TEXT OFF;\nGO`;
        case 'snowflake':
            return `EXPLAIN USING TEXT ${trimmed}`;
        case 'netezza':
            return `EXPLAIN VERBOSE ${trimmed}`;
        case 'access':
            throw new Error('Explain plans are not available for Microsoft Access connections.');
        default:
            return `EXPLAIN ${trimmed}`;
    }
}
