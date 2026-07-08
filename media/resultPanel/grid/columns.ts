import {
    formatCellValue,
    getNumericTypeInfo,
    inferNumericTypeFromRows,
    inferYyyymmddIntegerDateFromValues,
    isDeclaredIntegerType,
    isTemporalType,
    parseTemporalSortKey,
} from '../utils.js';
import type {
    ColumnFilterValue,
    ConditionColumnFilter,
    FilterCondition,
    ResultSet,
    ResultSetColumn,
    TanStackRow,
} from '../types.js';
import { getResultPanelWindow } from '../types.js';
import type { GridColumnDef, SortingFnValue } from './types.js';

function getResultCellValue(row: unknown, column: ResultSetColumn, index: number): unknown {
    if (!row) {
        return null;
    }

    if (Array.isArray(row)) {
        return row[index];
    }

    if (column.accessorKey !== undefined) {
        return (row as Record<string | number, unknown>)[column.accessorKey];
    }

    return (row as Record<string, unknown>)[String(index)];
}

export function prepareColumns(rs: ResultSet, _rsIndex: number): GridColumnDef[] {
    return rs.columns.map((col: ResultSetColumn, index: number) => {
        const inferred = (!col.type
            ? inferNumericTypeFromRows(rs.data, index)
            : { numericKind: 'none', scale: col.scale, dataType: col.type }) as {
            numericKind?: string;
            scale?: number;
            dataType?: string;
        };
        const resolvedType = col.type || inferred.dataType || '';
        const resolvedScale = typeof col.scale === 'number'
            ? col.scale
            : inferred.scale;
        const inferredDateInteger = isDeclaredIntegerType(resolvedType) && inferYyyymmddIntegerDateFromValues(
            rs.data.slice(0, 100).map((row: unknown) => getResultCellValue(row, col, index))
        );

        const accessorFn = (row: unknown) => {
            return getResultCellValue(row, col, index);
        };

        return {
            id: String(index),
            accessorFn: accessorFn,
            header: col.name || `Col ${index}`,
            dataType: resolvedType,
            scale: resolvedScale,
            inferredNumericKind: inferred.numericKind === 'decimal' || inferred.numericKind === 'integer'
                ? inferred.numericKind
                : undefined,
            inferredDateInteger: Boolean(inferredDateInteger),
            filterFn: createFilterFn(
                accessorFn,
                resolvedType,
                resolvedScale,
                inferred.numericKind === 'decimal' || inferred.numericKind === 'integer'
                    ? inferred.numericKind
                    : undefined,
                Boolean(inferredDateInteger),
            ),
            sortingFn: createSortingFn(resolvedType, inferred.numericKind, Boolean(inferredDateInteger))
        };
    });
}

function compareTemporalSortKeys(
    valA: unknown,
    valB: unknown,
    dataType: string | undefined,
    inferredDateInteger?: boolean,
): number {
    const sortOptions = inferredDateInteger ? { inferredDateInteger: true as const } : undefined;
    const timeA = parseTemporalSortKey(valA, dataType, sortOptions);
    const timeB = parseTemporalSortKey(valB, dataType, sortOptions);

    if (Number.isNaN(timeA) && Number.isNaN(timeB)) {
        return String(valA).localeCompare(String(valB));
    }
    if (Number.isNaN(timeA)) {
        return -1;
    }
    if (Number.isNaN(timeB)) {
        return 1;
    }

    return timeA < timeB ? -1 : (timeA > timeB ? 1 : 0);
}

export function createSortingFn(
    dataType: string | undefined,
    inferredNumericKind: string | undefined,
    inferredDateInteger: boolean | undefined,
): SortingFnValue {
    const isDateColumn = isTemporalType(dataType) || inferredDateInteger;

    const { isNumeric } = getNumericTypeInfo(dataType);

    if (isDateColumn) {
        return (rowA: TanStackRow, rowB: TanStackRow, columnId: string) => {
            const valA = rowA.getValue(columnId);
            const valB = rowB.getValue(columnId);

            if (valA === null || valA === undefined) return -1;
            if (valB === null || valB === undefined) return 1;

            return compareTemporalSortKeys(valA, valB, dataType, inferredDateInteger);
        };
    }

    if (isNumeric || inferredNumericKind === 'integer' || inferredNumericKind === 'decimal') {
        return (rowA: TanStackRow, rowB: TanStackRow, columnId: string) => {
            const valA = rowA.getValue(columnId);
            const valB = rowB.getValue(columnId);

            if (valA === null || valA === undefined) return -1;
            if (valB === null || valB === undefined) return 1;

            const numA = typeof valA === 'number' ? valA : parseFloat(String(valA).replace(/[\s\u00A0]/g, '').replace(',', '.'));
            const numB = typeof valB === 'number' ? valB : parseFloat(String(valB).replace(/[\s\u00A0]/g, '').replace(',', '.'));

            if (isNaN(numA) && isNaN(numB)) {
                return String(valA).localeCompare(String(valB));
            }
            if (isNaN(numA)) return -1;
            if (isNaN(numB)) return 1;

            return numA < numB ? -1 : (numA > numB ? 1 : 0);
        };
    }

    return 'alphanumeric';
}

export function createFilterFn(
    accessorFn: (row: unknown) => unknown,
    dataType: string | undefined,
    scale: number | undefined,
    inferredNumericKind: 'decimal' | 'integer' | undefined,
    inferredDateInteger: boolean,
): (row: TanStackRow, columnId: string, filterValue: ColumnFilterValue) => boolean {
    const isDateColumn = isTemporalType(dataType);

    const parseDateValue = (value: unknown): number | null => {
        if (value === null || value === undefined) return null;
        if (value instanceof Date) return value.getTime();
        const str = String(value);
        const parsed = Date.parse(str);
        return isNaN(parsed) ? null : parsed;
    };

    const parseFilterDate = (filterValue: string): number | null => {
        if (!filterValue || filterValue === '') return null;
        const parsed = Date.parse(filterValue);
        if (isNaN(parsed)) return null;
        return parsed;
    };

    return (row: TanStackRow, columnId: string, filterValue: ColumnFilterValue) => {
        if (!filterValue) return true;

        const cellValue = accessorFn(row.original);
        const stringValue = cellValue === null || cellValue === undefined
            ? 'NULL'
            : (formatCellValue(cellValue, dataType, scale, {
                columnId,
                inferredNumericKind,
                inferredDateInteger
            }) ?? 'NULL');
        const numericValue = parseFloat(String(cellValue).replace(/,/g, ''));

        if (filterValue && typeof filterValue === 'object' && '_isConditionFilter' in filterValue) {
            const conditionFilter = filterValue as ConditionColumnFilter;
            const { conditions, logic } = conditionFilter;
            return evaluateConditions(conditions, logic, stringValue, numericValue, isDateColumn, parseDateValue, parseFilterDate);
        }

        if (Array.isArray(filterValue)) {
            if (filterValue.length === 0) return true;
            return filterValue.includes(stringValue);
        }

        return true;
    };
}

export function evaluateConditions(
    conditions: FilterCondition[],
    logic: 'and' | 'or',
    stringValue: string,
    numericValue: number,
    isDateColumn: boolean,
    parseDateValue: (value: unknown) => number | null,
    parseFilterDate: (filterValue: string) => number | null,
): boolean {
    const evaluateCondition = (cond: FilterCondition) => {
        const condValue = cond.value;
        const condValue2 = cond.value2;
        const isNull = stringValue === 'NULL';

        if (isDateColumn) {
            const cellDateValue = parseDateValue(stringValue);
            const filterDateValue = parseFilterDate(condValue);
            const filterDateValue2 = parseFilterDate(condValue2 ?? '');

            switch (cond.type) {
                case 'equals':
                    if (filterDateValue === null) return cellDateValue === null;
                    return cellDateValue !== null && cellDateValue === filterDateValue;
                case 'notEquals':
                    if (filterDateValue === null) return cellDateValue !== null;
                    return cellDateValue === null || cellDateValue !== filterDateValue;
                case 'greaterThan':
                    return cellDateValue !== null && filterDateValue !== null && cellDateValue > filterDateValue;
                case 'greaterThanOrEqual':
                    return cellDateValue !== null && filterDateValue !== null && cellDateValue >= filterDateValue;
                case 'lessThan':
                    return cellDateValue !== null && filterDateValue !== null && cellDateValue < filterDateValue;
                case 'lessThanOrEqual':
                    return cellDateValue !== null && filterDateValue !== null && cellDateValue <= filterDateValue;
                case 'between':
                    return cellDateValue !== null && filterDateValue !== null && filterDateValue2 !== null &&
                        cellDateValue >= filterDateValue && cellDateValue <= filterDateValue2;
                case 'isEmpty':
                    return cellDateValue === null;
                case 'isNotEmpty':
                    return cellDateValue !== null;
                case 'contains':
                    return !isNull && stringValue.toLowerCase().includes(condValue.toLowerCase());
                case 'notContains':
                    return isNull || !stringValue.toLowerCase().includes(condValue.toLowerCase());
                case 'startsWith':
                    return !isNull && stringValue.toLowerCase().startsWith(condValue.toLowerCase());
                case 'endsWith':
                    return !isNull && stringValue.toLowerCase().endsWith(condValue.toLowerCase());
                case 'like':
                    if (isNull || !condValue) return false;
                    try {
                        const regexStr1 = '^' + condValue.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$';
                        return new RegExp(regexStr1, 'i').test(stringValue);
                    } catch(e) {
                        return false;
                    }
                default:
                    return true;
            }
        }

        switch (cond.type) {
            case 'contains':
                return !isNull && stringValue.toLowerCase().includes(condValue.toLowerCase());
            case 'notContains':
                return isNull || !stringValue.toLowerCase().includes(condValue.toLowerCase());
            case 'equals':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return numericValue === parseFloat(condValue);
                }
                return stringValue.toLowerCase() === condValue.toLowerCase();
            case 'notEquals':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return numericValue !== parseFloat(condValue);
                }
                return stringValue.toLowerCase() !== condValue.toLowerCase();
            case 'startsWith':
                return !isNull && stringValue.toLowerCase().startsWith(condValue.toLowerCase());
            case 'endsWith':
                return !isNull && stringValue.toLowerCase().endsWith(condValue.toLowerCase());
            case 'like':
                if (isNull || !condValue) return false;
                try {
                    const regexStr = '^' + condValue.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$';
                    return new RegExp(regexStr, 'i').test(stringValue);
                } catch(e) {
                    return false;
                }
            case 'isEmpty':
                return isNull;
            case 'isNotEmpty':
                return !isNull;
            case 'greaterThan':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return !isNull && numericValue > parseFloat(condValue);
                }
                return !isNull && stringValue.toLowerCase() > condValue.toLowerCase();
            case 'greaterThanOrEqual':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return !isNull && numericValue >= parseFloat(condValue);
                }
                return !isNull && stringValue.toLowerCase() >= condValue.toLowerCase();
            case 'lessThan':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return !isNull && numericValue < parseFloat(condValue);
                }
                return !isNull && stringValue.toLowerCase() < condValue.toLowerCase();
            case 'lessThanOrEqual':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue))) {
                    return !isNull && numericValue <= parseFloat(condValue);
                }
                return !isNull && stringValue.toLowerCase() <= condValue.toLowerCase();
            case 'between':
                if (!isNaN(numericValue) && !isNaN(parseFloat(condValue)) && !isNaN(parseFloat(condValue2 ?? ''))) {
                    const min = parseFloat(condValue);
                    const max = parseFloat(condValue2 ?? '');
                    return !isNull && numericValue >= min && numericValue <= max;
                }
                return !isNull && stringValue.toLowerCase() >= condValue.toLowerCase() && stringValue.toLowerCase() <= (condValue2 ?? '').toLowerCase();
            default:
                return true;
        }
    };

    if (logic === 'and') {
        return conditions.every(evaluateCondition);
    } else {
        return conditions.some(evaluateCondition);
    }
}

export function populateColumnSearchList(rsIndex: number, rs: ResultSet, columns: GridColumnDef[]): void {
    if (!rs || !columns) return;

    if (!getResultPanelWindow().columnSearchMap) {
        getResultPanelWindow().columnSearchMap = {};
    }
    const mapping = columns.map((col: GridColumnDef) => ({ id: col.id, name: col.header }));

    getResultPanelWindow().columnSearchMap![rsIndex] = mapping;
}
