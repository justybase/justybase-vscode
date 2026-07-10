import { formatCellValue, getNumericTypeInfo } from '../utils.js';
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

function calculateMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
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
    if (typeof agg === 'object' && agg !== null && agg.precision !== null && agg.precision !== undefined) {
        return agg.precision;
    }
    return null; // use default from typeInfo
}

function calculateAggregation(
    agg: ColumnAggregationValue,
    rows: GroupableTanStackRow[],
    col: TanStackColumn,
    typeInfo: AggTypeInfo = { isNumeric: true, hasDecimal: true },
): string {
    const fn = getAggFn(agg);
    const precision = getAggPrecision(agg, typeInfo);
    const values: number[] = [];
    rows.forEach((r: GroupableTanStackRow) => {
        const v = r.getValue(col.id);
        if (v !== null && v !== undefined && v !== '') {
            const n = parseFloat(String(v).replace(/,/g, ''));
            if (!isNaN(n)) values.push(n);
        }
    });

    switch (fn) {
        case 'count':
            return formatAggregationNumber(rows.filter((r: GroupableTanStackRow) => {
                const v = r.getValue(col.id);
                return v !== null && v !== undefined;
            }).length, false, precision); // count is always integer
        case 'countDistinct':
            const s = new Set();
            rows.forEach((r: GroupableTanStackRow) => {
                const v = r.getValue(col.id);
                if (v !== null && v !== undefined) {
                    s.add(formatCellValue(v, col.columnDef.dataType, col.columnDef.scale, {
                        columnId: col.id,
                        inferredNumericKind: col.columnDef.inferredNumericKind,
                        inferredDateInteger: col.columnDef.inferredDateInteger
                    }));
                }
            });
            return formatAggregationNumber(s.size, false, precision); // count is always integer
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'stdev':
        case 'median':
            if (values.length === 0) return '';
            break;
        default:
            return '';
    }

    switch (fn) {
        case 'sum':
            return formatAggregationNumber(values.reduce((a, b) => a + b, 0), typeInfo.hasDecimal, precision);
        case 'avg':
            return formatAggregationNumber(values.reduce((a, b) => a + b, 0) / values.length, typeInfo.hasDecimal, precision);
        case 'min':
            return formatAggregationNumber(reduceNumericMin(values), typeInfo.hasDecimal, precision);
        case 'max':
            return formatAggregationNumber(reduceNumericMax(values), typeInfo.hasDecimal, precision);
        case 'stdev':
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            return formatAggregationNumber(Math.sqrt(variance), typeInfo.hasDecimal, precision);
        case 'median':
            return formatAggregationNumber(calculateMedian(values), typeInfo.hasDecimal, precision);
        default:
            return '';
    }
}

export function calculateAggregationForRows(
    agg: ColumnAggregationValue,
    rows: GroupableTanStackRow[],
    col: TanStackColumn,
): string {
    const typeInfo = getAggregationColumnTypeInfo(col);
    const fn = getAggFn(agg);
    const precision = getAggPrecision(agg, typeInfo);
    
    const values: number[] = [];
    rows.forEach((r: GroupableTanStackRow) => {
        const v = r.getValue(col.id);
        if (v !== null && v !== undefined && v !== '') {
            const n = parseFloat(String(v).replace(/,/g, ''));
            if (!isNaN(n)) values.push(n);
        }
    });

    switch (fn) {
        case 'count':
            return formatAggregationNumber(rows.filter((r: GroupableTanStackRow) => {
                const v = r.getValue(col.id);
                return v !== null && v !== undefined;
            }).length, false, precision); // count is always integer
        case 'countDistinct':
            const s = new Set();
            rows.forEach((r: GroupableTanStackRow) => {
                const v = r.getValue(col.id);
                if (v !== null && v !== undefined) {
                    s.add(formatCellValue(v, col.columnDef.dataType, col.columnDef.scale, {
                        columnId: col.id,
                        inferredNumericKind: col.columnDef.inferredNumericKind,
                        inferredDateInteger: col.columnDef.inferredDateInteger
                    }));
                }
            });
            return formatAggregationNumber(s.size, false, precision); // count is always integer
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'stdev':
        case 'median':
            if (values.length === 0) return '';
            break;
        default:
            return '';
    }

    switch (fn) {
        case 'sum':
            return formatAggregationNumber(values.reduce((a, b) => a + b, 0), typeInfo.hasDecimal, precision);
        case 'avg':
            return formatAggregationNumber(values.reduce((a, b) => a + b, 0) / values.length, typeInfo.hasDecimal, precision);
        case 'min':
            return formatAggregationNumber(reduceNumericMin(values), typeInfo.hasDecimal, precision);
        case 'max':
            return formatAggregationNumber(reduceNumericMax(values), typeInfo.hasDecimal, precision);
        case 'stdev':
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            return formatAggregationNumber(Math.sqrt(variance), typeInfo.hasDecimal, precision);
        case 'median':
            return formatAggregationNumber(calculateMedian(values), typeInfo.hasDecimal, precision);
        default:
            return '';
    }
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
            return formatAggregationNumber(0, false, precision);
        }
        return '';
    }

    if (fn === 'count' || fn === 'countDistinct') {
        const countValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
        return formatAggregationNumber(Number.isFinite(countValue) ? countValue : 0, false, precision);
    }

    const numericValue = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue));
    if (!Number.isFinite(numericValue)) {
        return '';
    }
    return formatAggregationNumber(numericValue, typeInfo.hasDecimal, precision);
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
