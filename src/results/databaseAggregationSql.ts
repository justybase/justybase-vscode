import type { ColumnDefinition } from '../types';
import type { DiskQuerySpec } from '../core/resultDataProvider/types';
import { buildDatabaseWhereSql } from './databaseFilterSql';
import { removeTrailingLimitClause } from './refreshSqlLimit';

export interface DatabaseAggregationRequest {
    columnIndex: number;
    fn: string;
}

export interface DatabaseAggregationResult {
    columnIndex: number;
    fn: string;
    value: unknown;
}

export interface DatabaseAggregationBuildResult {
    sql: string;
    aliases: Array<{ alias: string; columnIndex: number; fn: string }>;
}

const VALID_AGGREGATION_FUNCTIONS = new Set([
    'sum',
    'avg',
    'min',
    'max',
    'count',
    'countDistinct',
    'stdev',
    'median',
]);

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function normalizeSqlForSubquery(sql: string): string {
    const withoutLimit = removeTrailingLimitClause(sql).trim();
    return withoutLimit.replace(/;\s*$/, '');
}

function isStableColumnName(name: string | undefined, allNames: readonly string[]): name is string {
    if (!name || !name.trim()) {
        return false;
    }
    if (name.trim().toUpperCase() === '?COLUMN?') {
        return false;
    }
    return allNames.filter(candidate => candidate === name).length === 1;
}

function aggregationExpression(fn: string, columnSql: string): string | undefined {
    switch (fn) {
        case 'sum':
            return `SUM(${columnSql})`;
        case 'avg':
            return `AVG(${columnSql})`;
        case 'min':
            return `MIN(${columnSql})`;
        case 'max':
            return `MAX(${columnSql})`;
        case 'count':
            return `COUNT(${columnSql})`;
        case 'countDistinct':
            return `COUNT(DISTINCT ${columnSql})`;
        case 'stdev':
            return `STDDEV(${columnSql})`;
        case 'median':
            return `MEDIAN(${columnSql})`;
        default:
            return undefined;
    }
}

export function buildDatabaseAggregationSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    requests: readonly DatabaseAggregationRequest[],
    filterSpec?: DiskQuerySpec,
): DatabaseAggregationBuildResult {
    const sqlWithoutLimit = normalizeSqlForSubquery(refreshSql);
    if (!sqlWithoutLimit) {
        throw new Error('This result set does not have SQL that can be aggregated.');
    }

    const columnNames = columns.map(column => column.name);
    const selectParts: string[] = [];
    const aliases: Array<{ alias: string; columnIndex: number; fn: string }> = [];

    for (const request of requests) {
        if (!Number.isInteger(request.columnIndex) || request.columnIndex < 0 || request.columnIndex >= columns.length) {
            continue;
        }
        if (!VALID_AGGREGATION_FUNCTIONS.has(request.fn)) {
            continue;
        }

        const column = columns[request.columnIndex];
        if (!isStableColumnName(column.name, columnNames)) {
            continue;
        }

        const expression = aggregationExpression(request.fn, `t.${quoteIdentifier(column.name)}`);
        if (!expression) {
            continue;
        }

        const alias = `agg_${request.columnIndex}_${request.fn}`;
        selectParts.push(`${expression} AS ${quoteIdentifier(alias)}`);
        aliases.push({ alias, columnIndex: request.columnIndex, fn: request.fn });
    }

    if (selectParts.length === 0) {
        throw new Error('All rows aggregation requires stable, unique column names in this result set.');
    }

    const whereSql = buildDatabaseWhereSql(filterSpec, columns);
    return {
        sql: [
            `SELECT ${selectParts.join(', ')}`,
            `FROM (`,
            sqlWithoutLimit,
            `) t`,
            whereSql ? `WHERE ${whereSql}` : '',
        ].filter(Boolean).join('\n'),
        aliases,
    };
}
