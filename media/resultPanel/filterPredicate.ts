// In-memory twin of the disk-backed filter compiler: the same operators, the same shared helpers,
// so "rows after filters" means the same thing whether the analysis runs in the webview over loaded
// rows or in SQLite over spilled rows (`src/core/resultDataProvider/diskQueryBuilder.ts`).
//
// Used by the Analysis Document filter workbench and by the Analytical view when its scope is
// "filtered rows".

import {
    buildLowerLikePattern,
    parseFilterNumericParam,
} from '../../src/core/resultDataProvider/columnFilterShared.js';
import { mapColumnTypeToSqlite } from '../../src/core/resultDataProvider/netezzaToSqliteType.js';
import type {
    DiskColumnConditionSpec,
    DiskColumnFilterSpec,
    DiskQuerySpec,
} from './types.js';

/** Column metadata the predicate needs to pick numeric vs text semantics, like the SQL builder. */
export interface FilterColumn {
    name: string;
    type?: string;
}

export function isNumericFilterColumn(type: string | undefined): boolean {
    const mapped = mapColumnTypeToSqlite(type);
    return mapped === 'INTEGER' || mapped === 'REAL';
}

export function filterValueToText(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function toNumeric(value: unknown): number | bigint | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'string') {
        return parseFilterNumericParam(value);
    }
    return null;
}

function numericEquals(left: number | bigint, right: number | bigint): boolean {
    if (typeof left === 'bigint' || typeof right === 'bigint') {
        try {
            return BigInt(left) === BigInt(right);
        } catch {
            return Number(left) === Number(right);
        }
    }
    return left === right;
}

function valuesEqual(rowValue: unknown, operand: unknown, numeric: boolean): boolean {
    if (rowValue === null || rowValue === undefined) {
        return operand === null || operand === undefined;
    }
    if (operand === null || operand === undefined) {
        return false;
    }
    if (numeric) {
        const left = toNumeric(rowValue);
        const right = toNumeric(operand);
        if (left !== null && right !== null) {
            return numericEquals(left, right);
        }
    }
    return filterValueToText(rowValue).toLowerCase() === filterValueToText(operand).toLowerCase();
}

function compareOrdered(
    rowValue: unknown,
    operand: string,
    numeric: boolean,
    operator: '>' | '>=' | '<' | '<=',
): boolean {
    if (rowValue === null || rowValue === undefined) {
        return false;
    }
    if (numeric) {
        const left = toNumeric(rowValue);
        const right = toNumeric(operand);
        if (left !== null && right !== null) {
            const a = Number(left);
            const b = Number(right);
            if (operator === '>') return a > b;
            if (operator === '>=') return a >= b;
            if (operator === '<') return a < b;
            return a <= b;
        }
    }
    const leftText = filterValueToText(rowValue).toLowerCase();
    const rightText = operand.toLowerCase();
    if (operator === '>') return leftText > rightText;
    if (operator === '>=') return leftText >= rightText;
    if (operator === '<') return leftText < rightText;
    return leftText <= rightText;
}

/** `contains` as the SQL builder writes it: LIKE '%value%' with escaped wildcards. */
function containsOperand(value: string): string {
    return buildLowerLikePattern('contains', value).replace(/%/g, '');
}

function matchesCondition(
    rowValue: unknown,
    condition: DiskColumnConditionSpec,
    numericColumn: boolean,
): boolean {
    const operand = condition.value ?? '';
    const operand2 = condition.value2 ?? '';
    const text = filterValueToText(rowValue).toLowerCase();
    const isNull = rowValue === null || rowValue === undefined;

    switch (condition.type) {
        case 'isEmpty':
            return isNull || text === '';
        case 'isNotEmpty':
            return !isNull && text !== '';
        case 'contains':
            return text.includes(containsOperand(operand));
        case 'notContains':
            return isNull || !text.includes(containsOperand(operand));
        case 'startsWith':
            return text.startsWith(operand.toLowerCase());
        case 'endsWith':
            return text.endsWith(operand.toLowerCase());
        case 'like':
            // The SQL builder escapes LIKE wildcards, so this operator is an exact, case-insensitive match.
            return text === operand.toLowerCase();
        case 'equals':
            return valuesEqual(rowValue, operand, numericColumn);
        case 'notEquals':
            return isNull || !valuesEqual(rowValue, operand, numericColumn);
        case 'greaterThan':
            return compareOrdered(rowValue, operand, numericColumn, '>');
        case 'greaterThanOrEqual':
            return compareOrdered(rowValue, operand, numericColumn, '>=');
        case 'lessThan':
            return compareOrdered(rowValue, operand, numericColumn, '<');
        case 'lessThanOrEqual':
            return compareOrdered(rowValue, operand, numericColumn, '<=');
        case 'between':
            return compareOrdered(rowValue, operand, numericColumn, '>=')
                && compareOrdered(rowValue, operand2, numericColumn, '<=');
        default:
            return true;
    }
}

function matchesColumnFilter(
    rowValue: unknown,
    filter: DiskColumnFilterSpec,
    numericColumn: boolean,
): boolean {
    const conditions = filter.conditions ?? [];
    if (conditions.length > 0) {
        const results = conditions.map(condition => matchesCondition(rowValue, condition, numericColumn));
        return filter.conditionLogic === 'or' ? results.some(Boolean) : results.every(Boolean);
    }
    const values = filter.values ?? [];
    if (values.length === 0) {
        return true;
    }
    return values.some(candidate => valuesEqual(rowValue, candidate, numericColumn));
}

export function hasActiveFilters(spec: DiskQuerySpec | undefined): boolean {
    if (!spec) {
        return false;
    }
    if (spec.globalSearch?.trim()) {
        return true;
    }
    return (spec.columnFilters ?? []).some(filter =>
        (filter.conditions?.length ?? 0) > 0 || (filter.values?.length ?? 0) > 0);
}

export function countActiveFilters(spec: DiskQuerySpec | undefined): number {
    if (!spec) {
        return 0;
    }
    const columnCount = (spec.columnFilters ?? []).filter(filter =>
        (filter.conditions?.length ?? 0) > 0 || (filter.values?.length ?? 0) > 0).length;
    return columnCount + (spec.globalSearch?.trim() ? 1 : 0);
}

/** Does the row survive the spec? Mirrors the SQLite WHERE clause used for spilled results. */
export function rowMatchesSpec(
    row: readonly unknown[],
    spec: DiskQuerySpec | undefined,
    columns: readonly FilterColumn[],
): boolean {
    if (!spec) {
        return true;
    }
    const term = spec.globalSearch?.trim().toLowerCase();
    if (term) {
        let matched = false;
        for (const cell of row) {
            if (filterValueToText(cell).toLowerCase().includes(term)) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            return false;
        }
    }
    for (const filter of spec.columnFilters ?? []) {
        const column = columns[filter.columnIndex];
        if (!matchesColumnFilter(row[filter.columnIndex], filter, isNumericFilterColumn(column?.type))) {
            return false;
        }
    }
    return true;
}

export function filterRowsBySpec(
    rows: ReadonlyArray<readonly unknown[]>,
    spec: DiskQuerySpec | undefined,
    columns: readonly FilterColumn[],
): unknown[][] {
    if (!hasActiveFilters(spec)) {
        return rows as unknown[][];
    }
    return rows.filter(row => rowMatchesSpec(row, spec, columns)) as unknown[][];
}

/** Rows that survive the spec; used for headers and the report summary. */
export function countMatchingRows(
    rows: ReadonlyArray<readonly unknown[]>,
    spec: DiskQuerySpec | undefined,
    columns: readonly FilterColumn[],
): number {
    if (!hasActiveFilters(spec)) {
        return rows.length;
    }
    let count = 0;
    for (const row of rows) {
        if (rowMatchesSpec(row, spec, columns)) {
            count++;
        }
    }
    return count;
}

/** Stable key for caches keyed by the filter scope. */
export function filterSpecKey(spec: DiskQuerySpec | undefined): string {
    if (!hasActiveFilters(spec)) {
        return 'full';
    }
    return JSON.stringify({
        globalSearch: spec?.globalSearch ?? '',
        columnFilters: (spec?.columnFilters ?? []).map(filter => ({
            columnIndex: filter.columnIndex,
            values: filter.values ?? [],
            conditions: filter.conditions ?? [],
            conditionLogic: filter.conditionLogic ?? 'and',
        })),
        sorting: spec?.sorting ?? [],
    });
}

/** Short label such as `REGION = "EU", AMOUNT > 100`; used by the scope chip and the report. */
export function describeFilterValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '(null)';
    }
    const text = filterValueToText(value);
    return text === '' ? '(empty)' : text;
}
