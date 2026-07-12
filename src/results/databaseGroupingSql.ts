/**
 * SQL builder for grouping an existing result set on the database server.
 *
 * The source query is used as a derived table. Its outer row limiter is removed
 * so grouping sees the complete source result, then the requested limiter is
 * applied to the grouped query itself.
 */

import type { DatabaseKind } from '../contracts/database';
import type { ColumnDefinition } from '../types';

export interface GroupingColumn {
    columnIndex: number;
    columnName: string;
}

export type GroupingFunctionName = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'countDistinct' | 'median';

export interface GroupingFunction {
    fn: GroupingFunctionName;
    columnIndex?: number;
    alias?: string;
}

export interface DatabaseGroupingRequest {
    groupByColumns: GroupingColumn[];
    functions: GroupingFunction[];
    orderBy?: { columnIndex: number; desc: boolean }[];
    /** undefined keeps the source query's limiter; null explicitly removes it. */
    limit?: number | null;
}

export interface DatabaseGroupingResultColumn {
    name: string;
    type?: string;
    kind?: 'group' | 'count' | 'percentage' | 'aggregate';
    sourceColumnIndex?: number;
    fn?: string;
}

export interface DatabaseGroupingBuildOptions {
    databaseKind?: DatabaseKind;
}

export interface DatabaseGroupingBuildResult {
    sql: string;
    sourceLimit?: number;
    appliedLimit?: number;
    columnMetadata: Array<{
        kind: 'group' | 'count' | 'percentage' | 'aggregate';
        sourceColumnIndex?: number;
        fn?: string;
    }>;
}

interface SourceLimit {
    value: number;
    start: number;
    end: number;
}

function quoteIdentifier(identifier: string, databaseKind?: DatabaseKind): string {
    if (databaseKind === 'mysql') {
        return `\`${identifier.replace(/`/g, '``')}\``;
    }
    if (databaseKind === 'mssql') {
        return `[${identifier.replace(/]/g, ']]')}]`;
    }
    return `"${identifier.replace(/"/g, '""')}"`;
}

function makeTopLevelMask(sql: string): string {
    const chars = Array.from(sql, () => ' ');
    let depth = 0;
    let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'lineComment' | 'blockComment' = 'normal';

    for (let index = 0; index < sql.length; index += 1) {
        const ch = sql[index];
        const next = sql[index + 1];

        if (state === 'lineComment') {
            if (ch === '\n') state = 'normal';
            continue;
        }
        if (state === 'blockComment') {
            if (ch === '*' && next === '/') {
                index += 1;
                state = 'normal';
            }
            continue;
        }
        if (state === 'single') {
            if (ch === "'" && next === "'") {
                index += 1;
            } else if (ch === "'") {
                state = 'normal';
            }
            continue;
        }
        if (state === 'double') {
            if (ch === '"' && next === '"') {
                index += 1;
            } else if (ch === '"') {
                state = 'normal';
            }
            continue;
        }
        if (state === 'backtick') {
            if (ch === '`') state = 'normal';
            continue;
        }
        if (state === 'bracket') {
            if (ch === ']') state = 'normal';
            continue;
        }

        if (ch === '-' && next === '-') {
            index += 1;
            state = 'lineComment';
            continue;
        }
        if (ch === '/' && next === '*') {
            index += 1;
            state = 'blockComment';
            continue;
        }
        if (ch === "'") {
            state = 'single';
            continue;
        }
        if (ch === '"') {
            state = 'double';
            continue;
        }
        if (ch === '`') {
            state = 'backtick';
            continue;
        }
        if (ch === '[') {
            state = 'bracket';
            continue;
        }
        if (ch === '(') {
            depth += 1;
            continue;
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth === 0) chars[index] = ch;
    }

    return chars.join('');
}

/** Finds only a row limiter belonging to the outermost source SELECT. */
export function findTopLevelRowLimit(sql: string): SourceLimit | undefined {
    const mask = makeTopLevelMask(sql);
    const trailing = /\b(?:limit\s+(\d+)(?:\s+offset\s+\d+)?|(?:offset\s+\d+\s+rows?\s+)?fetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only)\s*;?\s*$/i.exec(mask);
    if (trailing?.index !== undefined) {
        const value = Number(trailing[1] ?? trailing[2]);
        if (Number.isSafeInteger(value) && value > 0) {
            return { value, start: trailing.index, end: trailing.index + trailing[0].length };
        }
    }

    const topMatches = Array.from(mask.matchAll(/\bselect\s+(?:distinct\s+)?top\b/ig));
    const top = topMatches[topMatches.length - 1];
    if (!top || top.index === undefined) return undefined;

    const matched = top[0];
    const topOffset = matched.toLowerCase().indexOf('top');
    const start = top.index + topOffset;
    // The mask intentionally blanks parentheses, so calculate the exact range
    // against the original SQL before removing TOP (...).
    const originalTop = sql.slice(start).match(/^top\s*(?:\(\s*\d+\s*\)|\d+)\s+/i);
    if (!originalTop) return undefined;
    const valueMatch = /\d+/.exec(originalTop[0]);
    const value = Number(valueMatch?.[0]);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return { value, start, end: start + originalTop[0].length };
}

function normalizeSqlForSubquery(sql: string): { sql: string; sourceLimit?: number } {
    const sourceLimit = findTopLevelRowLimit(sql);
    const withoutLimit = sourceLimit ? `${sql.slice(0, sourceLimit.start)}${sql.slice(sourceLimit.end)}` : sql;
    const normalized = withoutLimit.trim().replace(/;\s*$/, '').trim();
    return { sql: normalized, sourceLimit: sourceLimit?.value };
}

function aggregateExpression(fn: GroupingFunctionName, columnSql: string): string {
    switch (fn) {
        case 'sum': return `SUM(${columnSql})`;
        case 'avg': return `AVG(${columnSql})`;
        case 'min': return `MIN(${columnSql})`;
        case 'max': return `MAX(${columnSql})`;
        case 'count': return 'COUNT(*)';
        case 'countDistinct': return `COUNT(DISTINCT ${columnSql})`;
        case 'median': return `MEDIAN(${columnSql})`;
    }
}

function outerSelectPrefix(databaseKind: DatabaseKind | undefined, limit: number | undefined): string {
    return databaseKind === 'mssql' && limit ? `SELECT TOP (${limit})` : 'SELECT';
}

function outerLimitClause(databaseKind: DatabaseKind | undefined, limit: number | undefined): string {
    if (!limit || databaseKind === 'mssql') return '';
    if (databaseKind === 'oracle' || databaseKind === 'db2') return `FETCH FIRST ${limit} ROWS ONLY`;
    return `LIMIT ${limit}`;
}

function assertStableColumn(column: ColumnDefinition | undefined, allColumns: readonly ColumnDefinition[]): asserts column is ColumnDefinition {
    if (!column?.name?.trim() || column.name.trim().toUpperCase() === '?COLUMN?') {
        throw new Error('Database grouping requires stable output column names. Alias unnamed expressions in the source query.');
    }
    if (allColumns.filter(candidate => candidate.name === column.name).length !== 1) {
        throw new Error(`Database grouping requires unique output column names (duplicate: ${column.name}).`);
    }
}

function resolveRequestedLimit(request: DatabaseGroupingRequest, sourceLimit: number | undefined): number | undefined {
    if (request.limit === null) return undefined;
    if (request.limit === undefined) return sourceLimit;
    if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
        throw new Error('Grouping limit must be a positive whole number or Unlimited.');
    }
    return request.limit;
}

export function buildDatabaseGroupingSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    request: DatabaseGroupingRequest,
    options: DatabaseGroupingBuildOptions = {},
): DatabaseGroupingBuildResult {
    const normalized = normalizeSqlForSubquery(refreshSql);
    if (!normalized.sql) throw new Error('This result set does not have SQL that can be grouped.');

    const uniqueGroupIndexes = Array.from(new Set(request.groupByColumns.map(group => group.columnIndex)));
    if (uniqueGroupIndexes.length === 0) throw new Error('At least one GROUP BY column is required.');
    if (uniqueGroupIndexes.length !== request.groupByColumns.length) throw new Error('A column can be grouped only once.');

    const columnMetadata: DatabaseGroupingBuildResult['columnMetadata'] = [];
    const selectParts: string[] = [];
    const groupExpressions: string[] = [];
    const quote = (value: string) => quoteIdentifier(value, options.databaseKind);

    for (const columnIndex of uniqueGroupIndexes) {
        if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columns.length) {
            throw new Error('Grouping contains an invalid column.');
        }
        const column = columns[columnIndex];
        assertStableColumn(column, columns);
        const expression = `t.${quote(column.name)}`;
        selectParts.push(`${expression} AS ${quote(column.name)}`);
        groupExpressions.push(expression);
        columnMetadata.push({ kind: 'group', sourceColumnIndex: columnIndex });
    }

    for (const fn of request.functions) {
        if (!['count', 'sum', 'avg', 'min', 'max', 'countDistinct', 'median'].includes(fn.fn)) {
            throw new Error('Grouping contains an unsupported aggregate function.');
        }
        let columnSql = '*';
        let sourceColumnIndex: number | undefined;
        let sourceColumn: ColumnDefinition | undefined;
        if (fn.fn !== 'count') {
            if (!Number.isInteger(fn.columnIndex) || fn.columnIndex === undefined || fn.columnIndex < 0 || fn.columnIndex >= columns.length) {
                throw new Error(`${fn.fn.toUpperCase()} requires a valid column.`);
            }
            sourceColumnIndex = fn.columnIndex;
            sourceColumn = columns[fn.columnIndex];
            assertStableColumn(sourceColumn, columns);
            columnSql = `t.${quote(sourceColumn.name)}`;
        }
        const alias = fn.alias?.trim() || (fn.fn === 'count' ? 'COUNT' : `${fn.fn.toUpperCase()}_${sourceColumn!.name}`);
        selectParts.push(`${aggregateExpression(fn.fn, columnSql)} AS ${quote(alias)}`);
        columnMetadata.push({ kind: fn.fn === 'count' ? 'count' : 'aggregate', sourceColumnIndex, fn: fn.fn });
    }

    if (request.functions.length === 0) {
        selectParts.push(`COUNT(*) AS ${quote('COUNT')}`);
        columnMetadata.push({ kind: 'count', fn: 'count' });
    }

    // This is intentionally a row-count share, not a percentage of any
    // selected SUM/AVG aggregate. The explicit name avoids ambiguity when
    // several aggregate measures are displayed together.
    selectParts.push(`COUNT(*) * 100.0 / SUM(COUNT(*)) OVER() AS ${quote('ROW_COUNT_PERCENTAGE')}`);
    columnMetadata.push({ kind: 'percentage', fn: 'rowCountPercentage' });

    const requestedOrder = request.orderBy?.map(order => {
        if (!Number.isInteger(order.columnIndex) || order.columnIndex < 0 || order.columnIndex >= columnMetadata.length) {
            throw new Error('Grouping order contains an invalid output column.');
        }
        return `${order.columnIndex + 1} ${order.desc ? 'DESC' : 'ASC'}`;
    });
    const defaultOrderIndex = columnMetadata.findIndex(meta => meta.kind === 'count');
    const aggregateOrderIndex = columnMetadata.findIndex(meta => meta.kind === 'aggregate');
    const orderBy = requestedOrder?.length
        ? requestedOrder.join(', ')
        : `${(defaultOrderIndex >= 0 ? defaultOrderIndex : aggregateOrderIndex >= 0 ? aggregateOrderIndex : 0) + 1} DESC`;
    const appliedLimit = resolveRequestedLimit(request, normalized.sourceLimit);

    return {
        sql: [
            `${outerSelectPrefix(options.databaseKind, appliedLimit)} ${selectParts.join(', ')}`,
            'FROM (',
            normalized.sql,
            ') t',
            `GROUP BY ${groupExpressions.join(', ')}`,
            `ORDER BY ${orderBy}`,
            outerLimitClause(options.databaseKind, appliedLimit),
        ].filter(Boolean).join('\n'),
        sourceLimit: normalized.sourceLimit,
        appliedLimit,
        columnMetadata,
    };
}
