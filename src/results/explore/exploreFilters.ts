/**
 * Explore filter model shared between the webview (state + client-side
 * sample filtering) and the host (server-side SQL composition).
 */

import type { ColumnDefinition } from '../../types';

export type { ExploreDateGrain, ExploreDimensionFilter, ExploreDateFilter, ExploreMeasureFilter, ExploreFilterModel } from '@justybase/contracts';
import type { ExploreFilterModel, ExploreValue } from '@justybase/contracts';
import { compareExploreNumbers } from '@justybase/result-core';

export const EMPTY_EXPLORE_FILTERS: ExploreFilterModel = {
    dimensions: [],
    dates: [],
    measures: [],
};

export function exploreFiltersAreEmpty(filters: ExploreFilterModel | undefined): boolean {
    if (!filters) {
        return true;
    }
    return filters.dimensions.length === 0 && filters.dates.length === 0 && filters.measures.length === 0;
}

export function quoteIdentifier(identifier: string, databaseKind?: string): string {
    if (databaseKind === 'mysql') {
        return `\`${identifier.replace(/`/g, '``')}\``;
    }
    if (databaseKind === 'mssql') {
        return `[${identifier.replace(/]/g, ']]')}]`;
    }
    return `"${identifier.replace(/"/g, '""')}"`;
}

export function escapeSqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function formatNumberLiteral(value: number | string): string {
    if (compareExploreNumbers(value, value) === undefined) throw new Error('Invalid numeric filter value.');
    return String(value);
}

const NUMERIC_TYPE = /^(?:bigint|smallint|integer|int\d*|tinyint|number|numeric|decimal|float|double|real)\b/i;
/** Types whose values never equal an empty string; `col = ''` is a type error on most engines. */
const NON_TEXT_TYPE = /^(?:bigint|smallint|integer|int\d*|tinyint|byteint|number|numeric|decimal|float|double|real|money|smallmoney|bool|boolean|bit|date|time|timestamp|datetime|interval|uuid|uniqueidentifier)\b/i;

function columnAcceptsEmptyString(type?: string): boolean {
    return !NON_TEXT_TYPE.test(type?.trim() ?? '');
}

/** Preserve numeric identifiers without passing them through Number. */
export function exploreValueSql(value: ExploreValue, type?: string, databaseKind?: string): string {
    if (typeof value === 'boolean') return databaseKind === 'mssql' || databaseKind === 'oracle' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number' || NUMERIC_TYPE.test(type?.trim() ?? '')) {
        return formatNumberLiteral(String(value));
    }
    return escapeSqlLiteral(String(value));
}

/**
 * Build a WHERE clause for the explore filter model against the columns of
 * the derived source table (`t`). Column indexes are validated against the
 * result columns; invalid references are skipped.
 */
export function buildExploreWhereSql(
    filters: ExploreFilterModel | undefined,
    columns: readonly ColumnDefinition[],
    databaseKind?: string,
): string {
    if (!filters || exploreFiltersAreEmpty(filters)) {
        return '';
    }

    const parts: string[] = [];

    for (const dimension of filters.dimensions) {
        const column = columns[dimension.columnIndex];
        if (!column?.name) continue;
        const quoted = `t.${quoteIdentifier(column.name, databaseKind)}`;
        if (!dimension.values.length && !dimension.includeNull && !dimension.includeEmpty) continue;
        // An empty string only matches a text column; on numeric/date/boolean
        // columns it matches no row (and `col = ''` would be a type error).
        const includeEmpty = (!!dimension.includeEmpty || dimension.values.includes('')) && columnAcceptsEmptyString(column.type);
        const values = dimension.values.filter(value => value !== '');
        const selected: string[] = [];
        if (values.length) {
            const literals = values.map(value => exploreValueSql(value, column.type, databaseKind));
            selected.push(literals.length === 1 ? `${quoted} = ${literals[0]}` : `${quoted} IN (${literals.join(', ')})`);
        }
        if (dimension.includeNull) selected.push(`${quoted} IS NULL`);
        if (includeEmpty && databaseKind !== 'oracle') selected.push(`${quoted} = ''`);
        if (includeEmpty && databaseKind === 'oracle') selected.push(`${quoted} IS NULL`);
        if (!selected.length) {
            // Every selected value is unmatchable: include keeps no row, exclude removes none.
            if (dimension.mode !== 'exclude') parts.push('1 = 0');
            continue;
        }
        const expression = selected.length === 1 ? selected[0] : `(${selected.join(' OR ')})`;
        parts.push(dimension.mode === 'exclude'
            ? dimension.includeNull || (includeEmpty && databaseKind === 'oracle')
                ? `(${quoted} IS NOT NULL AND NOT (${expression}))`
                : `(${quoted} IS NULL OR NOT (${expression}))`
            : expression);
    }

    for (const date of filters.dates) {
        const column = columns[date.columnIndex];
        if (!column || !column.name) {
            continue;
        }
        const quoted = quoteIdentifier(column.name, databaseKind);
        const dateSql = databaseKind === 'sqlite' ? `REPLACE(CAST(t.${quoted} AS TEXT), 'T', ' ')` : `t.${quoted}`;
        if (date.from) {
            parts.push(`${dateSql} >= ${escapeSqlLiteral(date.from.replace('T', ' '))}`);
        }
        if (date.to) {
            parts.push(`${dateSql} ${date.toExclusive ? '<' : '<='} ${escapeSqlLiteral(date.to.replace('T', ' '))}`);
        }
    }

    for (const measure of filters.measures) {
        const column = columns[measure.columnIndex];
        if (!column || !column.name) {
            continue;
        }
        const quoted = quoteIdentifier(column.name, databaseKind);
        if (measure.min !== undefined) {
            parts.push(`t.${quoted} >= ${formatNumberLiteral(measure.min)}`);
        }
        if (measure.max !== undefined) {
            parts.push(`t.${quoted} ${measure.maxExclusive ? '<' : '<='} ${formatNumberLiteral(measure.max)}`);
        }
    }

    return parts.join('\nAND ');
}

/**
 * Wrap the source SQL with an outer SELECT and an optional WHERE clause.
 * Used by pivot / composer / full-stats builders.
 */
export function wrapSourceSqlWithFilters(
    refreshSql: string,
    filters: ExploreFilterModel | undefined,
    columns: readonly ColumnDefinition[],
    databaseKind?: string,
): { sql: string } {
    const withoutLimit = refreshSql.trim().replace(/;\s*$/, '').trim();
    if (!withoutLimit) {
        throw new Error('This result set does not have SQL that can be analyzed.');
    }
    const where = buildExploreWhereSql(filters, columns, databaseKind);
    return {
        sql: [
            'FROM (',
            withoutLimit,
            ') t',
            where ? `WHERE ${where}` : '',
        ].filter(Boolean).join('\n'),
    };
}
