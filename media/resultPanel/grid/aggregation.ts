import { getNumericTypeInfo } from '../utils.js';
import { aggregateResultRows, formatExactAggregationValue, type AggregationFunction } from '@justybase/result-core';
import {
    getAggregationState,
    setGlobalDragState,
    getGlobalDragState,
} from '../state.js';
import type {
    ColumnAggregationValue,
    ResultSet,
    TanStackColumn,
} from '../types.js';
import { getActiveSourceUri, getResultPanelWindow } from '../types.js';
import type {
    AggTypeInfo,
    GridTanStackTable,
    GroupableTanStackRow,
} from './types.js';
import { applyRightAlignmentClass } from './alternateViews.js';

export function createGroupChip(colId: string, index: number, rs: ResultSet, tanTable: GridTanStackTable): HTMLDivElement {
    const chip = document.createElement('div');
    chip.className = 'group-chip';
    chip.draggable = true;
    chip.dataset.colId = colId;
    chip.dataset.groupIndex = String(index);

    chip.ondragstart = (e) => {
        const dataTransfer = e.dataTransfer;
        if (!dataTransfer) return;
        dataTransfer.setData('text/plain', colId);
        dataTransfer.setData('type', 'groupChip');
        dataTransfer.effectAllowed = 'move';
        chip.classList.add('dragging');
        setGlobalDragState({ isDragging: true, dragType: 'groupChip', draggedItem: colId });
    };

    chip.ondragover = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dataTransfer = e.dataTransfer;
        if (!dataTransfer) return;
        const dragState = getGlobalDragState();
        if (dragState.dragType === 'groupChip' && dragState.draggedItem !== colId) {
            dataTransfer.dropEffect = 'move';
            chip.classList.add('drag-over');
        } else if (dragState.dragType === 'column') {
            dataTransfer.dropEffect = 'copy';
        } else {
            dataTransfer.dropEffect = 'none';
        }
    };

    chip.ondragleave = (e) => {
        if (!chip.contains(e.relatedTarget as Node)) {
            chip.classList.remove('drag-over');
        }
    };

    chip.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('drag-over');
        handleGroupChipDrop(colId, tanTable);
    };

    chip.ondragend = () => {
        chip.classList.remove('dragging');
        chip.classList.remove('drag-over');
        setGlobalDragState({ isDragging: false, dragType: null, draggedItem: null });
        if (typeof getResultPanelWindow().clearGroupDropTargets === 'function') {
            getResultPanelWindow().clearGroupDropTargets!();
        }
    };

    const chipContent = document.createElement('span');
    chipContent.textContent = rs.columns[parseInt(colId)].name;
    chip.appendChild(chipContent);

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-group';
    removeBtn.textContent = '×';
    removeBtn.onclick = (e) => {
        e.stopPropagation();
        const currentGrouping = tanTable.getState().grouping ?? [];
        const newGrouping = currentGrouping.filter((id: string) => id !== colId);
        tanTable.setGrouping(newGrouping);
    };
    chip.appendChild(removeBtn);

    return chip;
}

function handleGroupChipDrop(targetColId: string, tanTable: GridTanStackTable): void {
    const dragState = getGlobalDragState();
    if (dragState.dragType === 'groupChip') {
        const draggedColId = dragState.draggedItem;
        if (draggedColId && draggedColId !== targetColId) {
            const currentGrouping = tanTable.getState().grouping ?? [];
            const newGrouping = [...currentGrouping];
            const fromIndex = newGrouping.indexOf(draggedColId);
            const toIndex = newGrouping.indexOf(targetColId);

            if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
                newGrouping.splice(fromIndex, 1);
                newGrouping.splice(toIndex, 0, draggedColId);
                tanTable.setGrouping(newGrouping);
            }
        }
    }
}

// Helper function to get symbol for aggregation type
function getAggregationSymbol(agg: ColumnAggregationValue): string {
    const symbols: Record<string, string> = {
        sum: 'Σ',
        count: '#',
        countDistinct: '◊',
        avg: 'μ',
        min: '↓',
        max: '↑',
        stdev: 'σ',
        median: 'M'
    };
    const fn = (typeof agg === 'string' ? agg : agg?.fn) || String(agg);
    return symbols[fn] || fn;
}

export function createGroupFooterRow(
    groupRow: GroupableTanStackRow,
    resultSet: ResultSet,
    rsIndex: number,
    tanTable: GridTanStackTable,
    rowNumberColumnWidth: number,
): HTMLTableRowElement | null {
    const tr = document.createElement('tr');
    tr.className = 'group-footer';
    tr.dataset.groupFooter = 'true';

    const depth = groupRow.depth || 0;
    const subRows = groupRow.subRows || [];
    const currentAggs = getAggregationState(rsIndex, resultSet.executionTimestamp, getActiveSourceUri()) || {};

    // Filter to only bottom-positioned aggregations for group footers
    const groupAggs: Record<string, ColumnAggregationValue[]> = {};
    const visibleColumns = tanTable.getVisibleLeafColumns();
    let hasAnyAggregation = false;
    visibleColumns.forEach((col: TanStackColumn) => {
        const aggs = currentAggs[col.id];
        if (aggs && Array.isArray(aggs) && aggs.length > 0) {
            const bottomOnly = aggs.filter(a => (typeof a === 'string' ? true : (a.position !== 'top' && a.scope !== 'database')));
            if (bottomOnly.length > 0) {
                groupAggs[col.id] = bottomOnly;
                hasAnyAggregation = true;
            }
        }
    });

    if (!hasAnyAggregation) return null;

    // Find max number of aggregations
    let maxAggCount = 0;
    visibleColumns.forEach((col: TanStackColumn) => {
        const aggs = groupAggs[col.id];
        if (aggs && Array.isArray(aggs)) {
            maxAggCount = Math.max(maxAggCount, aggs.length);
        }
    });

    // Add empty row number cell for group footer
    const rowNumTd = document.createElement('td');
    rowNumTd.className = 'row-number-cell';
    rowNumTd.style.position = 'sticky';
    rowNumTd.style.left = '0';
    rowNumTd.style.zIndex = '10';
    rowNumTd.style.width = rowNumberColumnWidth + 'px';
    rowNumTd.style.minWidth = rowNumberColumnWidth + 'px';
    rowNumTd.style.maxWidth = rowNumberColumnWidth + 'px';
    rowNumTd.style.backgroundColor = 'rgba(128, 128, 128, 0.1)';
    tr.appendChild(rowNumTd);

    visibleColumns.forEach((col, colIndex) => {
        const td = document.createElement('td');

        if (colIndex === 0 && depth > 0) {
            const indent = document.createElement('span');
            indent.className = 'group-indent';
            indent.style.width = (depth * 20) + 'px';
            td.appendChild(indent);
        }

        const aggs = groupAggs[col.id];
        if (!aggs || !Array.isArray(aggs) || aggs.length === 0) {
            td.textContent = '';
            tr.appendChild(td);
            return;
        }

        // Show all aggregations in group footers (previously limited to 2)
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '2px';
        const shouldAlignRight = applyRightAlignmentClass(td, col.columnDef?.dataType, col.columnDef?.inferredNumericKind);

        aggs.forEach(agg => {
            const result = calculateAggregationForRows(agg, subRows, col);
            if (result) {
                const rowDiv = document.createElement('div');
                rowDiv.className = 'group-footer-agg-row';
                rowDiv.style.display = 'flex';
                rowDiv.style.alignItems = 'center';
                rowDiv.style.gap = '4px';
                if (shouldAlignRight) {
                    rowDiv.classList.add('cell-align-right');
                }

                const labelSpan = document.createElement('span');
                labelSpan.className = 'agg-label';
                labelSpan.textContent = getAggregationSymbol(agg);
                labelSpan.style.fontSize = '10px';
                labelSpan.style.opacity = '0.7';

                const valueSpan = document.createElement('span');
                valueSpan.className = 'group-footer-agg-value';
                valueSpan.textContent = result;
                valueSpan.style.fontSize = '11px';
                if (shouldAlignRight) {
                    valueSpan.classList.add('cell-align-right');
                }

                rowDiv.appendChild(labelSpan);
                rowDiv.appendChild(valueSpan);
                container.appendChild(rowDiv);
            }
        });

        td.appendChild(container);
        tr.appendChild(td);
    });

    return tr;
}

/**
 * Get column type information for aggregation
 * @param {Object} col - Column object
 * @returns {{ isNumeric: boolean; hasDecimal: boolean }}
 */
function getAggregationColumnTypeInfo(col: TanStackColumn): AggTypeInfo {
    return getNumericTypeInfo((col.columnDef?.dataType || '').toLowerCase());
}

function roundHalfUp(value: number, precision: number): number {
    if (precision <= 0) {
        return Math.round(value);
    }

    const factor = Math.pow(10, precision);
    const nudge = value >= 0 ? 5e-10 : -5e-10;
    return Math.round((value + nudge) * factor) / factor;
}

function reduceNumericMin(values: number[]): number {
    let min = values[0];
    for (let i = 1; i < values.length; i++) {
        if (values[i] < min) {
            min = values[i];
        }
    }
    return min;
}

function reduceNumericMax(values: number[]): number {
    let max = values[0];
    for (let i = 1; i < values.length; i++) {
        if (values[i] > max) {
            max = values[i];
        }
    }
    return max;
}

/**
 * Format number with thousand separators and appropriate decimal places
 * Format: ### ###.XXXX (space as thousand separator, dot as decimal)
 * For integers: ### ### (space as thousand separator, no decimal)
 * @param {number|string} value - The numeric value to format
 * @param {boolean} hasDecimal - Whether to include decimal places
 * @returns {string} Formatted number string
 */
function formatAggregationNumber(
    value: number | string,
    hasDecimal = true,
    precision: number | null = null,
): string {
    if (value === null || value === undefined || value === '') return '';

    const num = parseFloat(String(value));
    if (isNaN(num)) return String(value);

    // Use provided precision, or fall back to column default (4), or 0 for integers
    const resolvedPrecision = precision !== null ? precision : (hasDecimal ? 4 : 0);
    const rounded = roundHalfUp(num, resolvedPrecision);

    // Format with space as thousand separator and dot as decimal
    const parts = rounded.toString().split('.');
    const integerPart = parts[0];
    let decimalPart = parts[1] || '';

    // Pad with trailing zeros if precision requires it
    if (resolvedPrecision > 0 && decimalPart.length < resolvedPrecision) {
        decimalPart = decimalPart.padEnd(resolvedPrecision, '0');
    }

    // Add thousand separators (spaces)
    const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

    // Add decimal part only if hasDecimal is true
    const formattedDecimal = (hasDecimal || resolvedPrecision > 0) && decimalPart.length > 0
        ? '.' + decimalPart
        : '';

    return formattedInteger + formattedDecimal;
}

// Count total leaf rows in a group (recursive, used by renderTableRows for row numbering)
function countLeafRows(row: GroupableTanStackRow): number {
    if (!row.getIsGrouped?.()) return 1;
    let n = 0;
    const subs = row.subRows ?? [];
    for (let i = 0; i < subs.length; i++) {
        n += countLeafRows(subs[i]);
    }
    return n;
}

function getAggFn(agg: ColumnAggregationValue): string {
    return typeof agg === 'string' ? agg : (agg?.fn || '');
}

function getAggPrecision(agg: ColumnAggregationValue, _typeInfo: AggTypeInfo): number | null {
    void _typeInfo;
    if (typeof agg === 'object' && agg !== null && agg.precision !== null && agg.precision !== undefined) {
        return agg.precision;
    }
    return null; // use default from typeInfo
}

function isSharedAggregationFunction(value: string): value is AggregationFunction {
    return ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'stdev', 'median'].includes(value);
}

function calculateSharedAggregation(
    agg: ColumnAggregationValue,
    rows: GroupableTanStackRow[],
    col: TanStackColumn,
    typeInfo: AggTypeInfo,
): string {
    const fn = getAggFn(agg);
    if (!isSharedAggregationFunction(fn)) return '';
    const precision = getAggPrecision(agg, typeInfo);
    const values = rows.map(row => row.getValue(col.id));
    const isCount = fn === 'count' || fn === 'countDistinct';
    const result = aggregateResultRows(
        values.map(value => [value]),
        [{
            columnIndex: 0,
            function: fn,
            precision: isCount ? undefined : precision ?? undefined,
            dataType: col.columnDef?.dataType,
            scale: col.columnDef?.scale,
            numeric: typeInfo.isNumeric || col.columnDef?.inferredNumericKind === 'integer' || col.columnDef?.inferredNumericKind === 'decimal',
        }],
    )[0];
    if (!result || result.value === null) return '';
    return formatExactAggregationValue(result.value, isCount ? false : typeInfo.hasDecimal, isCount ? null : precision);
}

function calculateAggregation(
    agg: ColumnAggregationValue,
    rows: GroupableTanStackRow[],
    col: TanStackColumn,
    typeInfo: AggTypeInfo = { isNumeric: true, hasDecimal: true },
): string {
    return calculateSharedAggregation(agg, rows, col, typeInfo);
}

export function calculateAggregationForRows(
    agg: ColumnAggregationValue,
    rows: GroupableTanStackRow[],
    col: TanStackColumn,
): string {
    return calculateSharedAggregation(agg, rows, col, getAggregationColumnTypeInfo(col));
}

export function formatDiskAggregationResult(
    agg: ColumnAggregationValue,
    rawValue: unknown,
    col: TanStackColumn,
): string {
    const fn = getAggFn(agg);
    const typeInfo = getAggregationColumnTypeInfo(col);
    const precision = getAggPrecision(agg, typeInfo);

    if (rawValue === null || rawValue === undefined) {
        if (fn === 'count' || fn === 'countDistinct') {
            return formatExactAggregationValue(0, false, null);
        }
        return '';
    }

    if (fn === 'count' || fn === 'countDistinct') {
        const countValue = typeof rawValue === 'number' ? rawValue : String(rawValue);
        if (typeof countValue === 'number' && !Number.isFinite(countValue)) {
            return formatExactAggregationValue(0, false, null);
        }
        return formatExactAggregationValue(countValue, false, null);
    }

    const numericValue = typeof rawValue === 'number' ? rawValue : String(rawValue);
    if (typeof numericValue === 'number' && !Number.isFinite(numericValue)) {
        return '';
    }
    return formatExactAggregationValue(numericValue, typeInfo.hasDecimal, precision);
}

export {
    formatAggregationNumber,
    roundHalfUp,
    reduceNumericMin,
    reduceNumericMax,
    getAggregationSymbol,
    getAggFn,
    getAggPrecision,
    getAggregationColumnTypeInfo,
    calculateAggregation,
    countLeafRows,
};
