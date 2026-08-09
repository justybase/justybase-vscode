/**
 * Explore filter model shared between the webview (state + client-side
 * sample filtering) and the host (server-side SQL composition).
 */

import type { ColumnDefinition } from '../../types';

export type ExploreDateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ExploreDimensionFilter {
    columnIndex: number;
    values: string[];
}

export interface ExploreDateFilter {
    columnIndex: number;
    grain: ExploreDateGrain;
    from?: string;
    to?: string;
}

export interface ExploreMeasureFilter {
    columnIndex: number;
    min?: number;
    max?: number;
}

export interface ExploreFilterModel {
    dimensions: ExploreDimensionFilter[];
    dates: ExploreDateFilter[];
    measures: ExploreMeasureFilter[];
}

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

export function formatNumberLiteral(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }
    return String(value);
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
        if (!column || !column.name) {
            continue;
        }
        if (dimension.values.length === 0) {
            continue;
        }
        const quoted = quoteIdentifier(column.name, databaseKind);
        if (dimension.values.length === 1) {
            parts.push(`t.${quoted} = ${escapeSqlLiteral(dimension.values[0])}`);
        } else {
            const list = dimension.values.map(value => escapeSqlLiteral(value)).join(', ');
            parts.push(`t.${quoted} IN (${list})`);
        }
    }

    for (const date of filters.dates) {
        const column = columns[date.columnIndex];
        if (!column || !column.name) {
            continue;
        }
        const quoted = quoteIdentifier(column.name, databaseKind);
        if (date.from) {
            parts.push(`t.${quoted} >= ${escapeSqlLiteral(date.from)}`);
        }
        if (date.to) {
            parts.push(`t.${quoted} <= ${escapeSqlLiteral(date.to)}`);
        }
    }

    for (const measure of filters.measures) {
        const column = columns[measure.columnIndex];
        if (!column || !column.name) {
            continue;
        }
        const quoted = quoteIdentifier(column.name, databaseKind);
        if (measure.min !== undefined && Number.isFinite(measure.min)) {
            parts.push(`t.${quoted} >= ${formatNumberLiteral(measure.min)}`);
        }
        if (measure.max !== undefined && Number.isFinite(measure.max)) {
            parts.push(`t.${quoted} <= ${formatNumberLiteral(measure.max)}`);
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
