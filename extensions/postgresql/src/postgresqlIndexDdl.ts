import type {
    PostgresqlIndexDesign,
    PostgresqlIndexMethod,
} from '../../../src/contracts/webviews/postgresqlIndexDesignerContracts';
import {
    formatIdentifierForSql,
    formatQualifiedObjectName,
} from '../../../src/utils/identifierUtils';

export const POSTGRESQL_INDEX_METHODS: readonly PostgresqlIndexMethod[] = ['btree', 'hash', 'gist', 'spgist', 'gin', 'brin'];

function requireValue(value: string | undefined, label: string): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        throw new Error(`${label} is required.`);
    }
    return trimmed;
}

function requireMethod(value: string): PostgresqlIndexMethod {
    const method = value.trim().toLowerCase() as PostgresqlIndexMethod;
    if (!POSTGRESQL_INDEX_METHODS.includes(method)) {
        throw new Error(`Index method "${value}" is not supported. Use btree, hash, gist, spgist, gin, or brin.`);
    }
    return method;
}

function requirePredicate(value: string): string {
    const predicate = value.trim();
    if (!predicate) {
        return '';
    }
    if (/[;]|--|\/\*|\*\//.test(predicate)) {
        throw new Error('The index predicate cannot contain SQL statement separators or comments.');
    }
    if (/^WHERE\b/i.test(predicate)) {
        return predicate;
    }
    return `WHERE ${predicate}`;
}

function requireTableOptionName(value: string, label: string): string {
    const name = requireValue(value, label);
    if (!/^[A-Za-z0-9_$]+$/.test(name)) {
        throw new Error(`${label} can only contain letters, digits, underscores, and dollar signs.`);
    }
    return name;
}

function formatIndexColumn(column: { name: string; order: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST' }): string {
    const name = formatIdentifierForSql(requireValue(column.name, 'Index column'), 'postgresql');
    const order = column.order === 'DESC' ? ' DESC' : '';
    const nulls = column.nulls === 'FIRST' ? ' NULLS FIRST' : ' NULLS LAST';
    return `${name}${order}${nulls}`;
}

function validateUniqueColumns(
    columns: ReadonlyArray<{ name: string; order: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST' }>,
    label: string,
): void {
    const seen = new Set<string>();
    for (const column of columns) {
        const key = column.name.trim().toLowerCase();
        if (seen.has(key)) {
            throw new Error(`Column "${column.name}" can only be selected once in ${label}.`);
        }
        seen.add(key);
    }
}

export function buildPostgresqlCreateIndexSql(options: {
    schema: string;
    tableName: string;
    design: PostgresqlIndexDesign;
}): string {
    const schema = requireValue(options.schema, 'Schema');
    const tableName = requireValue(options.tableName, 'Table name');
    const indexName = requireValue(options.design.indexName, 'Index name');
    if (!Array.isArray(options.design.keyColumns) || options.design.keyColumns.length === 0) {
        throw new Error('Select at least one key column.');
    }
    const method = requireMethod(options.design.method);

    validateUniqueColumns(options.design.keyColumns, 'the key columns');
    validateUniqueColumns(options.design.includeColumns.map(name => ({ name, order: 'ASC' as const, nulls: 'LAST' as const })), 'the INCLUDE columns');

    const keyColumns = options.design.keyColumns.map(formatIndexColumn).join(', ');
    const includeColumns = options.design.includeColumns
        .map(name => formatIdentifierForSql(requireValue(name, 'INCLUDE column'), 'postgresql'))
        .join(', ');

    const qualifiedTable = formatQualifiedObjectName(undefined, schema, tableName, 'postgresql');
    const uniqueClause = options.design.unique ? 'UNIQUE ' : '';
    const includeClause = includeColumns ? ` INCLUDE (${includeColumns})` : '';
    const tablespaceClause = options.design.tablespace.trim()
        ? ` TABLESPACE ${formatIdentifierForSql(requireTableOptionName(options.design.tablespace, 'Tablespace'), 'postgresql')}`
        : '';
    const predicateClause = requirePredicate(options.design.predicate);

    return `CREATE ${uniqueClause}INDEX ${formatIdentifierForSql(indexName, 'postgresql')} ON ${qualifiedTable} USING ${method} (${keyColumns})${includeClause}${tablespaceClause}${predicateClause ? ` ${predicateClause}` : ''};`;
}

export function buildPostgresqlDropIndexSql(schema: string, indexName: string): string {
    return `DROP INDEX IF EXISTS ${formatQualifiedObjectName(undefined, requireValue(schema, 'Schema'), requireValue(indexName, 'Index name'), 'postgresql')};`;
}