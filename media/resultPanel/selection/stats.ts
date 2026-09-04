import { postHostMessage } from '../protocol.js';
import { getNumericTypeInfo, isTemporalType } from '../utils.js';
import type { SelectionStats, TanStackColumn, TanStackTable } from '../types.js';
import type { ClipboardRowResolver } from './clipboard.js';
import type { SelectionModel } from './model.js';
import { getVisibleColumns, queryCell } from './render.js';
import { createSelectionStatsProcessor } from './statsWorker.js';

export interface DiskAggregationValue {
    fn: string;
    value: unknown;
}

/** Pure cell-value classification shared by memory selection stats. No DOM access. */
export function calculateSelectionStats(values: unknown[]): SelectionStats {
    const numericValues: number[] = [];
    const dateValues: string[] = [];
    const textValues: string[] = [];

    values.forEach(value => {
        if (value === null || value === undefined) {
            return;
        }

        const text = String(value).trim();
        if (text === '' || text === 'NULL' || text === 'null') {
            return;
        }

        const cleanText = text.replace(/[\s\u00A0]/g, '');
        const standardText = cleanText.replace(',', '.');
        const num = typeof value === 'number' ? value : parseFloat(standardText);
        if (Number.isFinite(num) && /^-?\d*\.?\d+$/.test(standardText)) {
            numericValues.push(num);
        }

        if (text.match(/^\d{4}-\d{2}-\d{2}/) || text.match(/^\d{2}\/\d{2}\/\d{4}/)) {
            dateValues.push(text);
        } else if (!/^-?\d*\.?\d+$/.test(standardText)) {
            textValues.push(text);
        }
    });

    const allValues = [...numericValues, ...dateValues, ...textValues];
    const distinctValues = new Set(allValues);
    if (numericValues.length > 0 && dateValues.length === 0 && textValues.length === 0) {
        return {
            cellCount: allValues.length,
            type: 'numeric',
            count: numericValues.length,
            distinctCount: distinctValues.size,
            sum: numericValues.reduce((a, b) => a + b, 0),
            min: Math.min(...numericValues),
            max: Math.max(...numericValues)
        };
    }
    if (dateValues.length > 0 && numericValues.length === 0 && textValues.length === 0) {
        const sortedDates = [...dateValues].sort();
        return {
            cellCount: allValues.length,
            type: 'date',
            count: dateValues.length,
            distinctCount: distinctValues.size,
            min: sortedDates[0],
            max: sortedDates[sortedDates.length - 1]
        };
    }
    if (textValues.length > 0 && numericValues.length === 0 && dateValues.length === 0) {
        return {
            cellCount: allValues.length,
            type: 'text',
            count: textValues.length,
            distinctCount: distinctValues.size
        };
    }
    return {
        cellCount: allValues.length,
        type: 'mixed',
        count: allValues.length,
        distinctCount: distinctValues.size
    };
}

/** Map host aggregation results for a disk-backed column to SelectionStats. Pure. */
export function getDiskColumnStats(column: TanStackColumn, values: DiskAggregationValue[]): SelectionStats {
    const aggregate = (fn: string): unknown => values.find(value => value.fn === fn)?.value;
    const count = Number(aggregate('count') ?? 0);
    const distinctCount = Number(aggregate('countDistinct') ?? 0);
    const columnDef = column.columnDef;
    const isInferredDate = columnDef.inferredDateInteger === true;
    const isInferredNumeric = columnDef.inferredNumericKind === 'decimal'
        || columnDef.inferredNumericKind === 'integer'
        || columnDef.dataType === '__inferred_decimal__'
        || columnDef.dataType === '__inferred_integer__';
    const { isNumeric } = getNumericTypeInfo(columnDef.dataType);
    if (!isInferredDate && (isNumeric || isInferredNumeric)) {
        return { cellCount: count, type: 'numeric', count, distinctCount, sum: Number(aggregate('sum') ?? 0), min: Number(aggregate('min') ?? 0), max: Number(aggregate('max') ?? 0) };
    }
    if (isInferredDate || isTemporalType(columnDef.dataType)) {
        return { cellCount: count, type: 'date', count, distinctCount, min: String(aggregate('min') ?? ''), max: String(aggregate('max') ?? '') };
    }
    return { cellCount: count, type: 'text', count, distinctCount };
}

/** Filter fingerprint used to detect stale column stats after re-render. Pure. */
export function getSelectedColumnFilterKey(table: TanStackTable): string {
    const state = table.getState?.() ?? {};
    return JSON.stringify({
        columnFilters: state.columnFilters ?? [],
        globalFilter: state.globalFilter ?? '',
    });
}

/** Bump the stats request version and drop any in-flight processor. DOM-free. */
export function invalidateSelectionStats(model: SelectionModel): void {
    model.selectionStatsRequestVersion++;
    model.selectionStatsProcessor?.dispose();
    model.selectionStatsProcessor = null;
}

export interface SelectionStatsDeps {
    table: TanStackTable;
    wrapper: HTMLElement;
    model: SelectionModel;
    clipboardResolver?: ClipboardRowResolver;
}

export interface SelectionStatsSender {
    sendSelectionStats: () => void;
    refreshColumnStatsIfFilterChanged: () => void;
}

function postSelectionStats(model: SelectionModel, stats: SelectionStats | null, requestVersion: number): void {
    if (requestVersion !== model.selectionStatsRequestVersion) {
        return;
    }
    postHostMessage({
        command: 'selectionStatsChanged',
        stats
    });
}

function postSelectionStatsCalculating(model: SelectionModel, requestVersion: number): void {
    if (requestVersion !== model.selectionStatsRequestVersion) {
        return;
    }
    postHostMessage({ command: 'selectionStatsChanged', stats: { state: 'calculating' } });
}

function sendMemoryColumnStats(deps: SelectionStatsDeps, column: TanStackColumn, requestVersion: number): void {
    const { table, model } = deps;
    const rows = table.getFilteredRowModel().rows;
    const chunkSize = 2_000;
    let offset = 0;
    model.selectionStatsProcessor?.dispose();
    model.selectionStatsProcessor = createSelectionStatsProcessor(
        stats => {
            model.selectionStatsProcessor = null;
            postSelectionStats(model, stats, requestVersion);
        },
        () => {
            model.selectionStatsProcessor = null;
            postSelectionStats(model, null, requestVersion);
        },
    );
    const processNextChunk = (): void => {
        if (requestVersion !== model.selectionStatsRequestVersion || !model.selectionStatsProcessor) {
            return;
        }
        const chunk = rows.slice(offset, offset + chunkSize).map(row => row.getValue(column.id));
        offset += chunk.length;
        model.selectionStatsProcessor.add(chunk);
        if (offset < rows.length) {
            setTimeout(processNextChunk, 0);
        } else {
            model.selectionStatsProcessor.complete();
        }
    };
    setTimeout(processNextChunk, 0);
}

function sendSelectedColumnStats(deps: SelectionStatsDeps, columnIndex: number, requestVersion: number): void {
    const { table, model, clipboardResolver } = deps;
    const column = getVisibleColumns(table)[columnIndex];
    if (!column) {
        postSelectionStats(model, null, requestVersion);
        return;
    }

    model.selectedColumnFilterKey = getSelectedColumnFilterKey(table);

    postSelectionStatsCalculating(model, requestVersion);
    if (clipboardResolver?.isDiskBacked) {
        const columnIndexForAggregate = Number.parseInt(column.id, 10);
        if (!Number.isInteger(columnIndexForAggregate) || !clipboardResolver.queryAggregations) {
            postSelectionStats(model, null, requestVersion);
            return;
        }
        void clipboardResolver.queryAggregations([
            { columnIndex: columnIndexForAggregate, fn: 'count' },
            { columnIndex: columnIndexForAggregate, fn: 'countDistinct' },
            { columnIndex: columnIndexForAggregate, fn: 'sum' },
            { columnIndex: columnIndexForAggregate, fn: 'min' },
            { columnIndex: columnIndexForAggregate, fn: 'max' },
        ]).then(results => {
            postSelectionStats(model, getDiskColumnStats(column, results), requestVersion);
        }, () => postSelectionStats(model, null, requestVersion));
        return;
    }
    sendMemoryColumnStats(deps, column, requestVersion);
}

/** Stateful selection-stats delivery bound to one grid instance. */
export function createSelectionStatsSender(deps: SelectionStatsDeps): SelectionStatsSender {
    const { wrapper, model } = deps;

    function sendSelectionStats(): void {
        const requestVersion = ++model.selectionStatsRequestVersion;
        if (model.selectedColumnIndex !== null) {
            sendSelectedColumnStats(deps, model.selectedColumnIndex, requestVersion);
            return;
        }
        if (model.selectedCells.size === 0) {
            postSelectionStats(model, null, requestVersion);
            return;
        }

        if (model.selectedCells.size > 100) {
            postSelectionStats(model, null, requestVersion);
            return;
        }

        const cellArray = Array.from(model.selectedCells).map(cellId => {
            const [row, col] = cellId.split('-').map(Number);
            return { row, col, cellId };
        }).sort((a, b) => a.row - b.row || a.col - b.col);

        if (cellArray.length === 0) {
            postSelectionStats(model, null, requestVersion);
            return;
        }
        const values = cellArray.map(cell => queryCell(wrapper, cell.cellId)?.textContent ?? null);
        postSelectionStats(model, calculateSelectionStats(values), requestVersion);
    }

    function refreshColumnStatsIfFilterChanged(): void {
        if (model.selectedColumnIndex !== null) {
            const currentFilterKey = getSelectedColumnFilterKey(deps.table);
            if (currentFilterKey !== model.selectedColumnFilterKey) {
                sendSelectionStats();
            }
        }
    }

    return { sendSelectionStats, refreshColumnStatsIfFilterChanged };
}
