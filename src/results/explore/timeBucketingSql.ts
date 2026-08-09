/**
 * Dialect-aware date bucketing expressions for the Explore composer.
 * Returns the SQL expression that truncates/buckets a column to a grain.
 */

import type { ExploreDateGrain } from './exploreFilters';

export type { ExploreDateGrain };

export const EXPLORE_COMPOSER_MAX_ROWS = 5000;

export function bucketDateExpression(
    databaseKind: string | undefined,
    columnSql: string,
    grain: ExploreDateGrain,
): string {
    switch (grain) {
        case 'day':
            return dayExpression(databaseKind, columnSql);
        case 'week':
            return weekExpression(databaseKind, columnSql);
        case 'month':
            return monthExpression(databaseKind, columnSql);
        case 'quarter':
            return quarterExpression(databaseKind, columnSql);
        case 'year':
            return yearExpression(databaseKind, columnSql);
    }
}

function dayExpression(databaseKind: string | undefined, columnSql: string): string {
    if (databaseKind === 'sqlite') {
        return `DATE(${columnSql})`;
    }
    if (databaseKind === 'mysql') {
        return `DATE_FORMAT(${columnSql}, '%Y-%m-%d')`;
    }
    if (databaseKind === 'mssql') {
        return `CAST(${columnSql} AS DATE)`;
    }
    return `CAST(${columnSql} AS DATE)`;
}

function weekExpression(databaseKind: string | undefined, columnSql: string): string {
    if (databaseKind === 'sqlite') {
        return `DATE(${columnSql}, 'weekday 0', '-6 days')`;
    }
    if (databaseKind === 'mysql') {
        return `DATE_FORMAT(DATE_SUB(${columnSql}, INTERVAL WEEKDAY(${columnSql}) DAY), '%Y-%m-%d')`;
    }
    if (databaseKind === 'mssql') {
        return `CAST(DATEADD(day, 1 - DATEPART(weekday, ${columnSql}), CAST(${columnSql} AS DATE)) AS DATE)`;
    }
    if (databaseKind === 'netezza') {
        return `TRUNC(${columnSql}, 'WW')`;
    }
    // postgresql / duckdb / snowflake / vertica
    return `DATE_TRUNC('week', ${columnSql})`;
}

function monthExpression(databaseKind: string | undefined, columnSql: string): string {
    if (databaseKind === 'sqlite') {
        return `DATE(${columnSql}, 'start of month')`;
    }
    if (databaseKind === 'mysql') {
        return `DATE_FORMAT(${columnSql}, '%Y-%m-01')`;
    }
    if (databaseKind === 'mssql') {
        return `DATEFROMPARTS(YEAR(${columnSql}), MONTH(${columnSql}), 1)`;
    }
    if (databaseKind === 'netezza') {
        return `TRUNC(${columnSql}, 'MM')`;
    }
    if (databaseKind === 'oracle') {
        return `TRUNC(${columnSql}, 'MM')`;
    }
    return `DATE_TRUNC('month', ${columnSql})`;
}

function quarterExpression(databaseKind: string | undefined, columnSql: string): string {
    if (databaseKind === 'sqlite') {
        return `DATE(${columnSql}, 'start of month', printf('-%d months', (CAST(strftime('%m', ${columnSql}) AS INTEGER) - 1) % 3))`;
    }
    if (databaseKind === 'mysql') {
        return `DATE_FORMAT(DATE_SUB(${columnSql}, INTERVAL (MONTH(${columnSql}) - 1) % 3 MONTH), '%Y-%m-01')`;
    }
    if (databaseKind === 'mssql') {
        return `DATEFROMPARTS(YEAR(${columnSql}), ((MONTH(${columnSql}) - 1) / 3) * 3 + 1, 1)`;
    }
    if (databaseKind === 'netezza') {
        return `TRUNC(${columnSql}, 'Q')`;
    }
    if (databaseKind === 'oracle') {
        return `TRUNC(${columnSql}, 'Q')`;
    }
    return `DATE_TRUNC('quarter', ${columnSql})`;
}

function yearExpression(databaseKind: string | undefined, columnSql: string): string {
    if (databaseKind === 'sqlite') {
        return `DATE(${columnSql}, 'start of year')`;
    }
    if (databaseKind === 'mysql') {
        return `DATE_FORMAT(${columnSql}, '%Y-01-01')`;
    }
    if (databaseKind === 'mssql') {
        return `DATEFROMPARTS(YEAR(${columnSql}), 1, 1)`;
    }
    if (databaseKind === 'netezza') {
        return `TRUNC(${columnSql}, 'YYYY')`;
    }
    if (databaseKind === 'oracle') {
        return `TRUNC(${columnSql}, 'YYYY')`;
    }
    return `DATE_TRUNC('year', ${columnSql})`;
}
