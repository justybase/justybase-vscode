/**
 * Server-side pivot (rows GROUP BY + CASE WHEN value columns) for the
 * Explore pivot tab. Executed in two steps by the host: first the distinct
 * pivot-column values are read (capped), then the CASE columns are built.
 */

import type { ColumnDefinition } from '../../types';
import {
    buildExploreWhereSql,
    escapeSqlLiteral,
    quoteIdentifier,
    type ExploreFilterModel,
} from './exploreFilters';
import { removeTrailingLimitClause } from '../refreshSqlLimit';

export type ExplorePivotAggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'countDistinct';

export const EXPLORE_PIVOT_MAX_COLUMN_VALUES = 100;
export const EXPLORE_PIVOT_MAX_ROWS = 5000;

export interface ExplorePivotConfig {
    rowColumnIndexes: number[];
    columnColumnIndex: number;
    valueColumnIndex: number;
    aggFn: ExplorePivotAggregate;
    filters?: ExploreFilterModel;
    limit?: number;
}

export interface ExplorePivotDistinctRequest {
    columnIndex: number;
}

export function buildDistinctValuesSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    request: ExplorePivotDistinctRequest,
    filters: ExploreFilterModel | undefined,
    databaseKind?: string,
    limit = EXPLORE_PIVOT_MAX_COLUMN_VALUES,
): string {
    const column = columns[request.columnIndex];
    if (!column || !column.name?.trim()) {
        throw new Error('Pivot column requires a stable name.');
    }
    const withoutLimit = removeTrailingLimitClause(refreshSql).trim().replace(/;\s*$/, '').trim();
    if (!withoutLimit) {
        throw new Error('This result set does not have SQL that can be pivoted.');
    }
    const quoted = quoteIdentifier(column.name, databaseKind);
    const where = buildExploreWhereSql(filters, columns, databaseKind);
    const selectClause = databaseKind === 'mssql'
        ? `SELECT DISTINCT TOP ${limit} t.${quoted} AS ${quoteIdentifier('PIVOT_VALUE', databaseKind)}`
        : `SELECT DISTINCT t.${quoted} AS ${quoteIdentifier('PIVOT_VALUE', databaseKind)}`;
    const limitClause = databaseKind === 'mssql' ? '' : `LIMIT ${limit}`;
    return [
        selectClause,
        'FROM (',
        withoutLimit,
        ') t',
        where ? `WHERE ${where}` : '',
        limitClause,
    ].filter(Boolean).join('\n');
}

function aggExpression(fn: ExplorePivotAggregate, valueSql: string, pivotSql: string): string {
    switch (fn) {
        case 'sum': return `SUM(CASE WHEN ${pivotSql} THEN ${valueSql} END)`;
        case 'avg': return `AVG(CASE WHEN ${pivotSql} THEN ${valueSql} END)`;
        case 'min': return `MIN(CASE WHEN ${pivotSql} THEN ${valueSql} END)`;
        case 'max': return `MAX(CASE WHEN ${pivotSql} THEN ${valueSql} END)`;
        case 'count': return `COUNT(CASE WHEN ${pivotSql} THEN 1 END)`;
        case 'countDistinct': return `COUNT(DISTINCT CASE WHEN ${pivotSql} THEN ${valueSql} END)`;
    }
}

export interface ExplorePivotColumnSpec {
    label: string;
    sql: string;
}

export function buildExplorePivotSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    config: ExplorePivotConfig,
    pivotValues: readonly string[],
    databaseKind?: string,
): { sql: string; pivotColumnNames: string[] } {
    if (config.rowColumnIndexes.length === 0) {
        throw new Error('At least one row dimension is required.');
    }
    if (config.columnColumnIndex < 0 || config.columnColumnIndex >= columns.length) {
        throw new Error('Invalid pivot column.');
    }
    if (config.valueColumnIndex < 0 || config.valueColumnIndex >= columns.length) {
        throw new Error('Invalid value column.');
    }
    if (!['sum', 'avg', 'min', 'max', 'count', 'countDistinct'].includes(config.aggFn)) {
        throw new Error('Unsupported pivot aggregate.');
    }

    const uniqueRows = Array.from(new Set(config.rowColumnIndexes));
    if (uniqueRows.length !== config.rowColumnIndexes.length) {
        throw new Error('A row dimension can be used only once.');
    }
    if (uniqueRows.includes(config.columnColumnIndex) || uniqueRows.includes(config.valueColumnIndex)) {
        throw new Error('Row dimensions must differ from the pivot and value columns.');
    }

    const rowColumns = uniqueRows.map(index => {
        const column = columns[index];
        if (!column || !column.name?.trim()) {
            throw new Error('Pivot row dimensions require stable names.');
        }
        return column;
    });
    const columnColumn = columns[config.columnColumnIndex];
    const valueColumn = columns[config.valueColumnIndex];
    if (!columnColumn?.name?.trim() || !valueColumn?.name?.trim()) {
        throw new Error('Pivot and value columns require stable names.');
    }

    const withoutLimit = removeTrailingLimitClause(refreshSql).trim().replace(/;\s*$/, '').trim();
    if (!withoutLimit) {
        throw new Error('This result set does not have SQL that can be pivoted.');
    }

    const quote = (name: string) => quoteIdentifier(name, databaseKind);
    const selectParts: string[] = [];
    const groupExpressions: string[] = [];

    for (const column of rowColumns) {
        const quoted = `t.${quote(column.name)}`;
        selectParts.push(`${quoted} AS ${quote(column.name)}`);
        groupExpressions.push(quoted);
    }

    const pivotValueSql = `t.${quote(columnColumn.name)}`;
    const valueSql = `t.${quote(valueColumn.name)}`;
    const pivotColumnNames: string[] = [];

    for (const value of pivotValues) {
        const pivotSql = `${pivotValueSql} = ${escapeSqlLiteral(value)}`;
        const label = value.length > 80 ? `${value.slice(0, 77)}…` : value;
        const alias = quote(`V: ${label}`);
        selectParts.push(`${aggExpression(config.aggFn, valueSql, pivotSql)} AS ${alias}`);
        pivotColumnNames.push(value);
    }

    const where = buildExploreWhereSql(config.filters, columns, databaseKind);
    const limit = config.limit ?? EXPLORE_PIVOT_MAX_ROWS;
    const selectClause = databaseKind === 'mssql'
        ? `SELECT TOP ${limit} ${selectParts.join(', ')}`
        : `SELECT ${selectParts.join(', ')}`;
    const limitClause = databaseKind === 'mssql' ? '' : `LIMIT ${limit}`;

    return {
        sql: [
            selectClause,
            'FROM (',
            withoutLimit,
            ') t',
            where ? `WHERE ${where}` : '',
            `GROUP BY ${groupExpressions.join(', ')}`,
            `ORDER BY ${groupExpressions[0]}`,
            limitClause,
        ].filter(Boolean).join('\n'),
        pivotColumnNames,
    };
}
