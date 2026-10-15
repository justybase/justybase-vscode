/**
 * SQL builder for the Explore time composer:
 *   Plot <aggregate> of <measure> by <dimension> over <date grain> [split by <dim>] [vs previous period]
 */

import type { ColumnDefinition } from '../../types';
import { buildExploreWhereSql, exploreValueSql, quoteIdentifier } from './exploreFilters';
import { bucketDateExpression, EXPLORE_COMPOSER_MAX_ROWS } from './timeBucketingSql';
import { exploreSourceSql } from './operationSql';

export type ExploreComposerAggregate = 'sum' | 'avg' | 'count' | 'min' | 'max';

export type { ExploreComposerConfig } from '@justybase/contracts';
import type { ExploreComposerConfig } from '@justybase/contracts';

export interface ExploreComposerBuildResult {
    sql: string;
    columnIndexes: {
        bucket: number;
        dimension: number | undefined;
        split: number | undefined;
        splitOther?: number;
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

    const withoutLimit = exploreSourceSql(refreshSql, databaseKind);
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
    let splitOtherIndex: number | undefined;
    let splitRestriction: string | undefined;
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
        const inList = `t.${quote(splitColumn.name)} IN (${values.map(value => exploreValueSql(value, splitColumn.type, databaseKind)).join(', ')})`;
        const splitSql = hasSplitValues
            ? `CASE WHEN ${inList} THEN t.${quote(splitColumn.name)} ELSE NULL END`
            : `t.${quote(splitColumn.name)}`;
        selectParts.push(`${splitSql} AS ${quote('SPLIT')}`);
        groupExpressions.push(splitSql);
        splitIndex = (dimensionIndex ?? 0) + 1;
        if (hasSplitValues) {
            const flag = `CASE WHEN ${inList} THEN 0 ELSE 1 END`;
            splitOtherIndex = selectParts.length;
            selectParts.push(`${flag} AS ${quote('SPLIT_IS_OTHER')}`);
            groupExpressions.push(flag);
            if (config.includeOther === false) splitRestriction = inList;
            splitColumnNames.push(...values, config.includeOther !== false ? 'Other' : '');
        }
    }

    const measureIndex = selectParts.length;
    selectParts.push(`${agg()} AS ${quote('MEASURE')}`);

    if (config.comparePrevious) {
        const partitionBy = groupExpressions.length > 1 ? `PARTITION BY ${groupExpressions.slice(1).join(', ')}` : '';
        selectParts.push(`LAG(${agg()}) OVER (${partitionBy} ORDER BY ${bucketSql}) AS ${quote('PREV')}`);
        previousIndex = measureIndex + 1;
    }

    const where = [buildExploreWhereSql(config.filters, columns, databaseKind), splitRestriction].filter(Boolean).join('\nAND ');
    const limit = config.limit ?? (EXPLORE_COMPOSER_MAX_ROWS + 1);
    const selectClause = databaseKind === 'mssql'
        ? `SELECT TOP ${limit} ${selectParts.join(', ')}`
        : `SELECT ${selectParts.join(', ')}`;
    const limitClause = databaseKind === 'mssql' ? '' : databaseKind === 'oracle' || databaseKind === 'db2' ? `FETCH FIRST ${limit} ROWS ONLY` : `LIMIT ${limit}`;

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
            splitOther: splitOtherIndex,
            measure: measureIndex,
            previous: previousIndex,
        },
        splitColumnNames,
    };
}
