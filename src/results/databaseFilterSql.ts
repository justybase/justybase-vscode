import {
    buildLowerLikePattern,
    COLUMN_FILTER_COMPARISON_OPERATORS,
    combineFilterClauses,
    escapeSqlLikeLiteral,
    formatFilterNumericLiteral,
} from '../core/resultDataProvider/columnFilterShared';
import type { DiskColumnFilterSpec, DiskQuerySpec } from '../core/resultDataProvider/types';
import type { ColumnDefinition } from '../types';
import { isNumericSqlColumnType, isTemporalSqlColumnType } from './sqlColumnTypeUtils';
import { findTrailingLimitClause, removeTrailingLimitClause } from './refreshSqlLimit';

export interface DatabaseDistinctValue {
    raw: unknown;
    count: number;
}

export interface DatabaseFilterBuildOptions {
    excludeColumnIndex?: number;
}

const DISTINCT_LIMIT = 10_001;

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizeSqlForSubquery(sql: string): string {
    return removeTrailingLimitClause(sql).trim().replace(/;\s*$/, '');
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

function isNumericType(dataType: string | undefined): boolean {
    return isNumericSqlColumnType(dataType);
}

function isTemporalType(dataType: string | undefined): boolean {
    return isTemporalSqlColumnType(dataType);
}

function literalForColumn(value: unknown, column: ColumnDefinition): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    if (isNumericType(column.type) && !isTemporalType(column.type)) {
        const numeric = formatFilterNumericLiteral(value);
        if (numeric !== undefined) {
            return numeric;
        }
    }
    return quoteStringLiteral(String(value));
}

function columnSql(columns: readonly ColumnDefinition[], columnIndex: number): string {
    const names = columns.map(column => column.name);
    const column = columns[columnIndex];
    if (!column || !isStableColumnName(column.name, names)) {
        throw new Error('Database filtering requires stable, unique column names in this result set.');
    }
    return `t.${quoteIdentifier(column.name)}`;
}

function textColumnSql(columns: readonly ColumnDefinition[], columnIndex: number): string {
    return `LOWER(CAST(${columnSql(columns, columnIndex)} AS VARCHAR(64000)))`;
}

function buildValuesFilterClause(
    filter: DiskColumnFilterSpec,
    columns: readonly ColumnDefinition[],
): string {
    const column = columns[filter.columnIndex];
    const col = columnSql(columns, filter.columnIndex);
    const values = filter.values ?? [];
    const nullValues = values.filter(value => value === null || value === undefined);
    const nonNullValues = values.filter(value => value !== null && value !== undefined);
    const parts: string[] = [];
    if (nonNullValues.length > 0) {
        parts.push(`${col} IN (${nonNullValues.map(value => literalForColumn(value, column)).join(', ')})`);
    }
    if (nullValues.length > 0) {
        parts.push(`${col} IS NULL`);
    }
    if (parts.length === 0) {
        return '';
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

function buildSingleConditionClause(
    filter: DiskColumnFilterSpec,
    condition: { type: string; value: string; value2?: string },
    columns: readonly ColumnDefinition[],
): string {
    const col = columnSql(columns, filter.columnIndex);
    const textCol = textColumnSql(columns, filter.columnIndex);
    const column = columns[filter.columnIndex];
    const value = condition.value ?? '';
    const value2 = condition.value2 ?? '';

    const comparisonLiteral = (raw: string) => literalForColumn(raw, column);
    const textLiteral = (raw: string) => quoteStringLiteral(raw.toLowerCase());

    switch (condition.type) {
        case 'isEmpty':
            return `(${col} IS NULL OR CAST(${col} AS VARCHAR(64000)) = '')`;
        case 'isNotEmpty':
            return `(${col} IS NOT NULL AND CAST(${col} AS VARCHAR(64000)) != '')`;
        case 'contains':
        case 'notContains':
        case 'startsWith':
        case 'endsWith': {
            const pattern = buildLowerLikePattern(condition.type, value);
            const likeSql = `${textCol} LIKE ${quoteStringLiteral(pattern)} ESCAPE '\\'`;
            return condition.type === 'notContains'
                ? `(${col} IS NULL OR ${textCol} NOT LIKE ${quoteStringLiteral(pattern)} ESCAPE '\\')`
                : likeSql;
        }
        case 'like':
            return `${textCol} LIKE ${quoteStringLiteral(escapeSqlLikeLiteral(value).toLowerCase())} ESCAPE '\\'`;
        case 'equals':
            return isNumericType(column.type) && !isTemporalType(column.type)
                ? `${col} = ${comparisonLiteral(value)}`
                : `${textCol} = ${textLiteral(value)}`;
        case 'notEquals':
            return isNumericType(column.type) && !isTemporalType(column.type)
                ? `(${col} IS NULL OR ${col} != ${comparisonLiteral(value)})`
                : `(${col} IS NULL OR ${textCol} != ${textLiteral(value)})`;
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual': {
            const op = COLUMN_FILTER_COMPARISON_OPERATORS[condition.type];
            return isNumericType(column.type) && !isTemporalType(column.type)
                ? `${col} ${op} ${comparisonLiteral(value)}`
                : `${textCol} ${op} ${textLiteral(value)}`;
        }
        case 'between':
            return isNumericType(column.type) && !isTemporalType(column.type)
                ? `(${col} >= ${comparisonLiteral(value)} AND ${col} <= ${comparisonLiteral(value2)})`
                : `(${textCol} >= ${textLiteral(value)} AND ${textCol} <= ${textLiteral(value2)})`;
        default:
            return '';
    }
}

function buildConditionFilterClause(
    filter: DiskColumnFilterSpec,
    columns: readonly ColumnDefinition[],
): string {
    const parts = (filter.conditions ?? [])
        .map(condition => buildSingleConditionClause(filter, condition, columns))
        .filter(Boolean);
    if (parts.length === 0) {
        return '';
    }
    return combineFilterClauses(parts, filter.conditionLogic);
}

export function buildDatabaseWhereSql(
    spec: DiskQuerySpec | undefined,
    columns: readonly ColumnDefinition[],
    options: DatabaseFilterBuildOptions = {},
): string {
    const parts: string[] = [];
    if (spec?.globalSearch?.trim()) {
        const term = `%${escapeSqlLikeLiteral(spec.globalSearch.trim()).toLowerCase()}%`;
        const globalParts = columns.map((_, index) =>
            `${textColumnSql(columns, index)} LIKE ${quoteStringLiteral(term)} ESCAPE '\\'`);
        if (globalParts.length > 0) {
            parts.push(`(${globalParts.join(' OR ')})`);
        }
    }
    for (const filter of spec?.columnFilters ?? []) {
        if (filter.columnIndex === options.excludeColumnIndex) {
            continue;
        }
        const clause = (filter.conditions?.length ?? 0) > 0
            ? buildConditionFilterClause(filter, columns)
            : buildValuesFilterClause(filter, columns);
        if (clause) {
            parts.push(clause);
        }
    }
    return parts.join(' AND ');
}

export function buildDatabaseFilteredSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    spec: DiskQuerySpec | undefined,
): string {
    const limit = findTrailingLimitClause(refreshSql);
    if (!limit) {
        throw new Error('Database filtering is available only for result SQL with a trailing LIMIT.');
    }
    const baseSql = normalizeSqlForSubquery(refreshSql);
    const whereSql = buildDatabaseWhereSql(spec, columns);
    return [
        `SELECT *`,
        `FROM (`,
        baseSql,
        `) t`,
        whereSql ? `WHERE ${whereSql}` : '',
        `LIMIT ${limit.value}`,
    ].filter(Boolean).join('\n');
}

export function buildDatabaseDistinctValuesSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    columnIndex: number,
    spec: DiskQuerySpec | undefined,
): string {
    const baseSql = normalizeSqlForSubquery(refreshSql);
    const col = columnSql(columns, columnIndex);
    const whereSql = buildDatabaseWhereSql(spec, columns, { excludeColumnIndex: columnIndex });
    return [
        `SELECT value, COUNT(*) AS cnt`,
        `FROM (`,
        `  SELECT ${col} AS value`,
        `  FROM (`,
        baseSql,
        `  ) t`,
        whereSql ? `  WHERE ${whereSql}` : '',
        `) v`,
        `GROUP BY value`,
        `ORDER BY cnt DESC`,
        `LIMIT ${DISTINCT_LIMIT}`,
    ].filter(Boolean).join('\n');
}
