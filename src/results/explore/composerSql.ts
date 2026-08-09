/**
 * SQL builder for the Explore time composer:
 *   Plot <aggregate> of <measure> by <dimension> over <date grain> [split by <dim>] [vs previous period]
 */

import type { ColumnDefinition } from '../../types';
import { buildExploreWhereSql, escapeSqlLiteral, quoteIdentifier, type ExploreFilterModel } from './exploreFilters';
import { bucketDateExpression, EXPLORE_COMPOSER_MAX_ROWS } from './timeBucketingSql';
import { removeTrailingLimitClause } from '../refreshSqlLimit';

export type ExploreComposerAggregate = 'sum' | 'avg' | 'count' | 'min' | 'max';

export interface ExploreComposerConfig {
    dateColumnIndex: number;
    grain: 'day' | 'week' | 'month' | 'quarter' | 'year';
    dimensionColumnIndex?: number;
    measureColumnIndex: number;
    aggFn: ExploreComposerAggregate;
    splitByColumnIndex?: number;
    splitValues?: string[];
    includeOther?: boolean;
    comparePrevious: boolean;
    filters?: ExploreFilterModel;
    limit?: number;
}

export interface ExploreComposerBuildResult {
    sql: string;
    columnIndexes: {
        bucket: number;
        dimension: number | undefined;
        split: number | undefined;
        measure: number;
        previous: number | undefined;
    };
    /** CASE expression aliases for split columns. */
    splitColumnNames: string[];
}

export function buildComposerSql(
    refreshSql: string,
    columns: readonly ColumnDefinition[],
    config: ExploreComposerConfig,
    databaseKind?: string,
): ExploreComposerBuildResult {
    if (!columns[config.dateColumnIndex]?.name?.trim()) {
        throw new Error('Composer requires a stable date column.');
    }
    if (!columns[config.measureColumnIndex]?.name?.trim()) {
        throw new Error('Composer requires a stable measure column.');
    }
    if (!['sum', 'avg', 'count', 'min', 'max'].includes(config.aggFn)) {
        throw new Error('Unsupported composer aggregate.');
    }

    const withoutLimit = removeTrailingLimitClause(refreshSql).trim().replace(/;\s*$/, '').trim();
    if (!withoutLimit) {
        throw new Error('This result set does not have SQL that can be composed.');
    }

    const dateColumn = columns[config.dateColumnIndex];
    const measureColumn = columns[config.measureColumnIndex];
    const dimensionColumn = config.dimensionColumnIndex !== undefined ? columns[config.dimensionColumnIndex] : undefined;
    const splitColumn = config.splitByColumnIndex !== undefined ? columns[config.splitByColumnIndex] : undefined;

    const quote = (name: string) => quoteIdentifier(name, databaseKind);
    const bucketSql = bucketDateExpression(databaseKind, `t.${quote(dateColumn.name)}`, config.grain);
    const measureSql = `t.${quote(measureColumn.name)}`;

    const agg = (): string => {
        switch (config.aggFn) {
            case 'sum': return `SUM(${measureSql})`;
            case 'avg': return `AVG(${measureSql})`;
            case 'count': return 'COUNT(*)';
            case 'min': return `MIN(${measureSql})`;
            case 'max': return `MAX(${measureSql})`;
        }
    };

    const selectParts: string[] = [];
    const groupExpressions: string[] = [];
    let dimensionIndex: number | undefined;
    let splitIndex: number | undefined;
    let previousIndex: number | undefined;
    const splitColumnNames: string[] = [];

    selectParts.push(`${bucketSql} AS ${quote('BUCKET')}`);
    groupExpressions.push(bucketSql);

    if (dimensionColumn) {
        const quoted = `t.${quote(dimensionColumn.name)}`;
        selectParts.push(`${quoted} AS ${quote('DIM')}`);
        groupExpressions.push(quoted);
        dimensionIndex = 1;
    }

    if (splitColumn) {
        const values = config.splitValues ?? [];
        const hasSplitValues = values.length > 0;
        const splitSql = hasSplitValues
            ? `CASE WHEN t.${quote(splitColumn.name)} IN (${values.map(value => escapeSqlLiteral(value)).join(', ')}) THEN t.${quote(splitColumn.name)} ELSE 'Other' END`
            : `t.${quote(splitColumn.name)}`;
        selectParts.push(`${splitSql} AS ${quote('SPLIT')}`);
        groupExpressions.push(splitSql);
        splitIndex = (dimensionIndex ?? 0) + 1;
        if (hasSplitValues) {
            splitColumnNames.push(...values, config.includeOther !== false ? 'Other' : '');
        }
    }

    selectParts.push(`${agg()} AS ${quote('MEASURE')}`);
    const measureIndex = (splitIndex ?? dimensionIndex ?? 0) + 1;

    if (config.comparePrevious) {
        const partitionBy = groupExpressions.length > 1 ? `PARTITION BY ${groupExpressions.slice(1).join(', ')}` : '';
        selectParts.push(`LAG(${agg()}) OVER (${partitionBy} ORDER BY ${bucketSql}) AS ${quote('PREV')}`);
        previousIndex = measureIndex + 1;
    }

    const where = buildExploreWhereSql(config.filters, columns, databaseKind);
    const limit = config.limit ?? EXPLORE_COMPOSER_MAX_ROWS;
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
        columnIndexes: {
            bucket: 0,
            dimension: dimensionIndex,
            split: splitIndex,
            measure: measureIndex,
            previous: previousIndex,
        },
        splitColumnNames,
    };
}
