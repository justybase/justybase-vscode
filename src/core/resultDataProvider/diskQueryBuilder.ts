import { mapColumnTypeToSqlite, sqliteColumnName } from './netezzaToSqliteType';
import { isTemporalColumnType } from './temporalColumnTypes';
import type { DiskColumnConditionSpec, DiskColumnFilterSpec, DiskQuerySpec, DiskSortSpec } from './types';

export interface BuiltDiskQuery {
    whereSql: string;
    whereParams: unknown[];
    orderBySql: string;
}

const SQLITE_MIN_INT64 = BigInt('-9223372036854775808');
const SQLITE_MAX_INT64 = BigInt('9223372036854775807');
const JS_MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const JS_MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function isIntegerSqliteType(dataType: string | undefined): boolean {
    return mapColumnTypeToSqlite(dataType) === 'INTEGER';
}

function isNumericSqliteType(dataType: string | undefined): boolean {
    const mapped = mapColumnTypeToSqlite(dataType);
    return mapped === 'INTEGER' || mapped === 'REAL';
}

function quoteColumn(columnIndex: number): string {
    return `"${sqliteColumnName(columnIndex)}"`;
}

function castColAsText(columnIndex: number): string {
    return `CAST(${quoteColumn(columnIndex)} AS TEXT)`;
}

function lowerColText(columnIndex: number): string {
    return `LOWER(${castColAsText(columnIndex)})`;
}

function escapeLikeLiteral(value: string): string {
    return value.replace(/[%_\\]/g, '\\$&');
}

function parseNumericParam(value: string, dataType: string | undefined): number | bigint | null {
    const normalized = value.replace(/,/g, '').trim();
    if (normalized === '') {
        return null;
    }

    if (isIntegerSqliteType(dataType) && /^[+-]?\d+$/.test(normalized)) {
        try {
            const parsedBigInt = BigInt(normalized);
            if (parsedBigInt < SQLITE_MIN_INT64 || parsedBigInt > SQLITE_MAX_INT64) {
                return null;
            }
            if (parsedBigInt >= JS_MIN_SAFE_BIGINT && parsedBigInt <= JS_MAX_SAFE_BIGINT) {
                return Number(parsedBigInt);
            }
            return parsedBigInt;
        } catch {
            return null;
        }
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function buildGlobalSearchClause(
    globalSearch: string,
    columnCount: number,
    params: unknown[],
): string {
    const term = globalSearch.trim();
    if (!term) {
        return '';
    }
    const likePattern = `%${escapeLikeLiteral(term)}%`;
    const parts: string[] = [];
    for (let index = 0; index < columnCount; index++) {
        parts.push(`${castColAsText(index)} LIKE ? ESCAPE '\\'`);
        params.push(likePattern);
    }
    return parts.length > 0 ? `(${parts.join(' OR ')})` : '';
}

function buildColumnValuesFilterClause(
    filter: DiskColumnFilterSpec,
    params: unknown[],
): string {
    const col = quoteColumn(filter.columnIndex);
    const values = filter.values ?? [];
    const nullValues = values.filter((value) => value === null);
    const nonNullValues = values.filter((value) => value !== null);

    const parts: string[] = [];
    if (nonNullValues.length > 0) {
        const placeholders = nonNullValues.map(() => '?').join(', ');
        parts.push(`${col} IN (${placeholders})`);
        params.push(...nonNullValues);
    }
    if (nullValues.length > 0) {
        parts.push(`${col} IS NULL`);
    }
    if (parts.length === 0) {
        return '';
    }
    if (parts.length === 1) {
        return parts[0];
    }
    return `(${parts.join(' OR ')})`;
}

function buildSingleConditionClause(
    columnIndex: number,
    condition: DiskColumnConditionSpec,
    columnTypes: Array<string | undefined>,
    params: unknown[],
): string {
    const col = quoteColumn(columnIndex);
    const dataType = columnTypes[columnIndex];
    const isNumeric = isNumericSqliteType(dataType);
    const isDate = isTemporalColumnType(dataType);
    const textCol = lowerColText(columnIndex);
    const value = condition.value ?? '';
    const value2 = condition.value2 ?? '';

    switch (condition.type) {
        case 'isEmpty':
            return `(${col} IS NULL OR ${castColAsText(columnIndex)} = '')`;
        case 'isNotEmpty':
            return `(${col} IS NOT NULL AND ${castColAsText(columnIndex)} != '')`;
        case 'contains':
            params.push(`%${escapeLikeLiteral(value).toLowerCase()}%`);
            return `${textCol} LIKE ? ESCAPE '\\'`;
        case 'notContains':
            params.push(`%${escapeLikeLiteral(value).toLowerCase()}%`);
            return `(${col} IS NULL OR ${textCol} NOT LIKE ? ESCAPE '\\')`;
        case 'startsWith':
            params.push(`${escapeLikeLiteral(value).toLowerCase()}%`);
            return `${textCol} LIKE ? ESCAPE '\\'`;
        case 'endsWith':
            params.push(`%${escapeLikeLiteral(value).toLowerCase()}%`);
            return `${textCol} LIKE ? ESCAPE '\\'`;
        case 'like': {
            const pattern = escapeLikeLiteral(value).toLowerCase();
            params.push(pattern);
            return `${textCol} LIKE ? ESCAPE '\\'`;
        }
        case 'equals':
            if (isNumeric && !isDate) {
                const numeric = parseNumericParam(value, dataType);
                if (numeric === null) {
                    params.push(value.toLowerCase());
                    return `${textCol} = ?`;
                }
                params.push(numeric);
                return `${col} = ?`;
            }
            params.push(value.toLowerCase());
            return `${textCol} = ?`;
        case 'notEquals':
            if (isNumeric && !isDate) {
                const numeric = parseNumericParam(value, dataType);
                if (numeric === null) {
                    params.push(value.toLowerCase());
                    return `(${col} IS NULL OR ${textCol} != ?)`;
                }
                params.push(numeric);
                return `(${col} IS NULL OR ${col} != ?)`;
            }
            params.push(value.toLowerCase());
            return `(${col} IS NULL OR ${textCol} != ?)`;
        case 'greaterThan':
        case 'greaterThanOrEqual':
        case 'lessThan':
        case 'lessThanOrEqual':
        case 'between': {
            const opMap: Record<string, string> = {
                greaterThan: '>',
                greaterThanOrEqual: '>=',
                lessThan: '<',
                lessThanOrEqual: '<=',
            };
            if (condition.type === 'between') {
                if (isNumeric && !isDate) {
                    const min = parseNumericParam(value, dataType);
                    const max = parseNumericParam(value2, dataType);
                    if (min === null || max === null) {
                        params.push(value.toLowerCase(), value2.toLowerCase());
                        return `(${textCol} >= ? AND ${textCol} <= ?)`;
                    }
                    params.push(min, max);
                    return `(${col} >= ? AND ${col} <= ?)`;
                }
                params.push(value.toLowerCase(), value2.toLowerCase());
                return `(${textCol} >= ? AND ${textCol} <= ?)`;
            }
            const op = opMap[condition.type];
            if (isNumeric && !isDate) {
                const numeric = parseNumericParam(value, dataType);
                if (numeric === null) {
                    params.push(value.toLowerCase());
                    return `${textCol} ${op} ?`;
                }
                params.push(numeric);
                return `${col} ${op} ?`;
            }
            params.push(value.toLowerCase());
            return `${textCol} ${op} ?`;
        }
        default:
            return '';
    }
}

function buildColumnConditionFilterClause(
    filter: DiskColumnFilterSpec,
    columnTypes: Array<string | undefined>,
    params: unknown[],
): string {
    const conditions = filter.conditions ?? [];
    const parts = conditions
        .map((condition) => buildSingleConditionClause(filter.columnIndex, condition, columnTypes, params))
        .filter((clause) => clause.length > 0);
    if (parts.length === 0) {
        return '';
    }
    if (parts.length === 1) {
        return parts[0];
    }
    const joiner = filter.conditionLogic === 'or' ? ' OR ' : ' AND ';
    return `(${parts.join(joiner)})`;
}

function buildColumnFilterClause(
    filter: DiskColumnFilterSpec,
    columnTypes: Array<string | undefined>,
    params: unknown[],
): string {
    if ((filter.conditions?.length ?? 0) > 0) {
        return buildColumnConditionFilterClause(filter, columnTypes, params);
    }
    return buildColumnValuesFilterClause(filter, params);
}

function buildOrderByEntry(
    sort: DiskSortSpec,
    columnTypes: Array<string | undefined>,
): string {
    const col = quoteColumn(sort.columnIndex);
    const direction = sort.desc ? 'DESC' : 'ASC';
    const columnType = columnTypes[sort.columnIndex];
    if (isNumericSqliteType(columnType)) {
        return `${col} ${direction}`;
    }
    if (isTemporalColumnType(columnType)) {
        // ISO-8601 text and epoch values stored in spill tables sort chronologically without NOCASE.
        return `${col} ${direction}`;
    }
    return `${col} COLLATE NOCASE ${direction}`;
}

export function buildDiskQuery(
    spec: DiskQuerySpec | undefined,
    columnCount: number,
    columnTypes: Array<string | undefined>,
): BuiltDiskQuery {
    const whereParts: string[] = [];
    const whereParams: unknown[] = [];

    if (spec?.globalSearch?.trim()) {
        const globalClause = buildGlobalSearchClause(spec.globalSearch, columnCount, whereParams);
        if (globalClause) {
            whereParts.push(globalClause);
        }
    }

    for (const filter of spec?.columnFilters ?? []) {
        const clause = buildColumnFilterClause(filter, columnTypes, whereParams);
        if (clause) {
            whereParts.push(clause);
        }
    }

    const orderParts = (spec?.sorting ?? []).map((sort) => buildOrderByEntry(sort, columnTypes));
    const orderBySql = orderParts.length > 0
        ? orderParts.join(', ')
        : '_rowid';

    return {
        whereSql: whereParts.length > 0 ? whereParts.join(' AND ') : '',
        whereParams,
        orderBySql,
    };
}
