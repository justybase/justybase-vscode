/**
 * Server-side full-dataset statistics for a single measure column.
 * Reuses the derived-table pattern and composes optional explore filters.
 * Percentiles use PERCENTILE_CONT where the dialect supports it.
 */

import type { ColumnDefinition } from '../../types';
import { buildExploreWhereSql, quoteIdentifier, type ExploreFilterModel } from './exploreFilters';
import { removeTrailingLimitClause } from '../refreshSqlLimit';

export interface FullStatisticsRequest {
    columnIndex: number;
}

export type FullStatisticName = 'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max' | 'stddev' | 'p25' | 'p50' | 'p75';

export interface FullStatisticsResult {
    columnIndex: number;
    values: Partial<Record<FullStatisticName, number | null>>;
    /** True when the dialect cannot compute percentile columns. */
    percentilesUnavailable: boolean;
    /** True when the dialect lacks a STDDEV aggregate (e.g. SQLite). */
    stddevUnavailable: boolean;
}

export interface FullStatisticsBuildResult {
    sql: string;
    aliases: Array<{ alias: string; stat: FullStatisticName }>;
    percentilesUnavailable: boolean;
    stddevUnavailable: boolean;
}

/** Dialects with PERCENTILE_CONT(x) WITHIN GROUP (ORDER BY …). */
const PERCENTILE_DIALECTS = new Set([
    'netezza', 'postgresql', 'oracle', 'db2', 'mssql', 'snowflake', 'vertica',
]);

/** DuckDB uses quantile_cont(x, p). */
function percentileExpression(columnSql: string, p: number, databaseKind: string | undefined): string | undefined {
    if (databaseKind === 'duckdb') {
        return `QUANTILE_CONT(${columnSql}, ${p})`;
    }
    if (PERCENTILE_DIALECTS.has(databaseKind ?? '')) {
        return `PERCENTILE_CONT(${p}) WITHIN GROUP (ORDER BY ${columnSql})`;
    }
    return undefined;
}

function baseAggregateExpression(stat: 'count' | 'distinct' | 'sum' | 'avg' | 'min' | 'max' | 'stddev', columnSql: string): string {
    switch (stat) {
        case 'count': return `COUNT(${columnSql})`;
        case 'distinct': return `COUNT(DISTINCT ${columnSql})`;
        case 'sum': return `SUM(${columnSql})`;
        case 'avg': return `AVG(${columnSql})`;
        case 'min': return `MIN(${columnSql})`;
        case 'max': return `MAX(${columnSql})`;
        case 'stddev': return `STDDEV(${columnSql})`;
    }
}

function quoteName(identifier: string, databaseKind?: string): string {
    return quoteIdentifier(identifier, databaseKind);
}

export function buildFullStatisticsSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    request: FullStatisticsRequest,
    filters: ExploreFilterModel | undefined,
    databaseKind?: string,
): FullStatisticsBuildResult {
    const column = columns[request.columnIndex];
    if (!column || !column.name?.trim()) {
        throw new Error('Full statistics require a stable column name.');
    }
    if (columns.filter(candidate => candidate.name === column.name).length !== 1) {
        throw new Error('Full statistics require a unique output column name.');
    }

    const withoutLimit = removeTrailingLimitClause(refreshSql).trim().replace(/;\s*$/, '').trim();
    if (!withoutLimit) {
        throw new Error('This result set does not have SQL that can be analyzed.');
    }

    const columnSql = `t.${quoteName(column.name, databaseKind)}`;
    const selectParts: string[] = [];
    const aliases: Array<{ alias: string; stat: FullStatisticName }> = [];

    const stddevUnavailable = databaseKind === 'sqlite';
    const baseStats: Array<[FullStatisticName, string]> = [
        ['count', baseAggregateExpression('count', columnSql)],
        ['distinct', baseAggregateExpression('distinct', columnSql)],
        ['sum', baseAggregateExpression('sum', columnSql)],
        ['avg', baseAggregateExpression('avg', columnSql)],
        ['min', baseAggregateExpression('min', columnSql)],
        ['max', baseAggregateExpression('max', columnSql)],
        ...(stddevUnavailable ? [] : [['stddev', baseAggregateExpression('stddev', columnSql)] as [FullStatisticName, string]]),
    ];
    for (const [stat, expression] of baseStats) {
        const alias = `stat_${stat}`;
        selectParts.push(`${expression} AS ${quoteName(alias, databaseKind)}`);
        aliases.push({ alias, stat });
    }

    const percentilePairs: Array<[FullStatisticName, number]> = [
        ['p25', 0.25],
        ['p50', 0.5],
        ['p75', 0.75],
    ];
    const percentileExpressions = percentilePairs.map(([stat, p]) => {
        const expression = percentileExpression(columnSql, p, databaseKind);
        if (!expression) {
            return undefined;
        }
        const alias = `stat_${stat}`;
        selectParts.push(`${expression} AS ${quoteName(alias, databaseKind)}`);
        aliases.push({ alias, stat });
        return alias;
    });
    const percentilesUnavailable = percentileExpressions.some(alias => alias === undefined);

    const where = buildExploreWhereSql(filters, columns, databaseKind);
    return {
        sql: [
            `SELECT ${selectParts.join(', ')}`,
            'FROM (',
            withoutLimit,
            ') t',
            where ? `WHERE ${where}` : '',
        ].filter(Boolean).join('\n'),
        aliases,
        percentilesUnavailable,
        stddevUnavailable,
    };
}

/** Map query result row values back to named statistics. */
export function mapFullStatisticsRow(
    row: unknown[] | undefined,
    aliases: Array<{ alias: string; stat: FullStatisticName }>,
): Partial<Record<FullStatisticName, number | null>> {
    const values: Partial<Record<FullStatisticName, number | null>> = {};
    if (!row) {
        return values;
    }
    aliases.forEach((entry, columnIndex) => {
        const raw = row[columnIndex];
        if (raw === null || raw === undefined) {
            values[entry.stat] = null;
        } else if (typeof raw === 'number') {
            values[entry.stat] = Number.isFinite(raw) ? raw : null;
        } else {
            const parsed = Number(String(raw));
            values[entry.stat] = Number.isFinite(parsed) ? parsed : null;
        }
    });
    return values;
}
