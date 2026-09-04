import { asHtml } from '../dom.js';
import { postHostMessage } from '../protocol.js';
import { getGrid } from '../state.js';
import type { TanStackTable } from '../types.js';
import {
    buildSelectedClipboardPayload,
    buildSelectedClipboardPayloadAsync,
    buildSelectedColumnClipboardPayloadAsync,
    copyAllRowsAsHtmlAsync,
    copyAllRowsAsMdAsync,
    copyAllRowsAsync,
    resolvePlainText,
    writeMultiFormatToClipboard,
    type ClipboardRowResolver,
} from './clipboard.js';
import { requestResultsViewFocus } from './interaction.js';
import type { SelectionModel } from './model.js';
import { resetSelectionModelState } from './model.js';
import { notifySelectionChanged, queryCell, scrollCellIntoView } from './render.js';

export interface SelectionOperationsScope {
    wrapper: HTMLElement;
    table: TanStackTable;
    selRect: HTMLElement;
    model: SelectionModel;
    clipboardResolver?: ClipboardRowResolver;
    sendSelectionStats: () => void;
}

const vscode = { postMessage: postHostMessage };

export function setSelectionContexts(hasSelection: boolean, primeCopy = hasSelection): void {
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsHasSelection',
        value: hasSelection
    });
    vscode.postMessage({
        command: 'setContext',
        key: 'netezza.resultsCopyPrimed',
        value: hasSelection && primeCopy
    });
}

export function internalClearSelection(scope: SelectionOperationsScope): void {
    const { wrapper, selRect, model } = scope;
    resetSelectionModelState(model);
    selRect.style.display = 'none';
    wrapper.querySelectorAll('.anchor-cell').forEach(el => el.classList.remove('anchor-cell'));
    // Clear every visible selected cell — not only selectedCells entries. After Ctrl+A,
    // virtualization re-renders rows with isAllSelected styling without updating the Set.
    wrapper.querySelectorAll('.selected-cell').forEach(el => el.classList.remove('selected-cell'));
    wrapper.querySelectorAll('tr.row-selected').forEach(r => r.classList.remove('row-selected'));
}

export function clearSelection(scope: SelectionOperationsScope): void {
    internalClearSelection(scope);
    setSelectionContexts(false, false);
    scope.sendSelectionStats();
    notifySelectionChanged(scope.wrapper, scope.selRect, scope.model);
}

export function selectSingleCell(scope: SelectionOperationsScope, row: number, col: number): void {
    const { wrapper, selRect, model } = scope;
    const cellId = `${row}-${col}`;
    const td = queryCell(wrapper, cellId);

    if (td) {
        model.startCell = cellId;
        model.endCell = cellId;
        model.selectedCells.add(cellId);
        td.classList.add('selected-cell');
        setSelectionContexts(true);
        scope.sendSelectionStats();
        notifySelectionChanged(wrapper, selRect, model);
        scrollCellIntoView(wrapper, td);
    } else {
        const activeGridIndex = asHtml(document.querySelector('.grid-wrapper.active'))?.dataset?.index;
        if (activeGridIndex !== undefined) {
            const grid = getGrid(parseInt(activeGridIndex, 10));
            if (grid && grid.scrollToIndex) {
                grid.scrollToIndex(row, 'auto');
                setTimeout(() => {
                    const newTd = queryCell(wrapper, cellId);
                    if (newTd) {
                        model.startCell = cellId;
                        model.endCell = cellId;
                        model.selectedCells.add(cellId);
                        newTd.classList.add('selected-cell');
                        setSelectionContexts(true);
                        scope.sendSelectionStats();
                        notifySelectionChanged(wrapper, selRect, model);
                        scrollCellIntoView(wrapper, newTd);
                    }
                }, 50);
            }
        }
    }
}

export function selectRange(scope: SelectionOperationsScope, start: string | null, end: string | null): void {
    const { wrapper, selRect, model } = scope;
    if (!start || !end) {
        return;
    }

    const [startRow, startCol] = start.split('-').map(Number);
    const [endRow, endCol] = end.split('-').map(Number);

    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);

    internalClearSelection(scope);

    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const cellId = `${row}-${col}`;
            model.selectedCells.add(cellId);

            const cell = queryCell(wrapper, cellId);
            if (cell) {
                cell.classList.add('selected-cell');
            }
        }
    }

    setSelectionContexts(true);

    scope.sendSelectionStats();
    notifySelectionChanged(wrapper, selRect, model);
}

export function selectEntireRow(scope: SelectionOperationsScope, rowIndex: number, tr: Element): void {
    const cells = tr.querySelectorAll('td[data-cell-id]:not(.row-number-cell)');
    cells.forEach((cell, colIndex) => {
        const cellId = `${rowIndex}-${colIndex}`;
        (cell as HTMLElement).dataset.cellId = cellId;
        scope.model.selectedCells.add(cellId);
        cell.classList.add('selected-cell');
    });
}

export function selectRowRange(scope: SelectionOperationsScope, startRowIndex: number | null, endRowIndex: number | null): void {
    const { wrapper, selRect, model } = scope;
    if (startRowIndex === null || endRowIndex === null) {
        return;
    }

    const minRow = Math.min(startRowIndex, endRowIndex);
    const maxRow = Math.max(startRowIndex, endRowIndex);

    internalClearSelection(scope);

    for (let row = minRow; row <= maxRow; row++) {
        const tr = wrapper.querySelector(`tr[data-index="${row}"]`);
        if (tr) {
            tr.classList.add('row-selected');
            selectEntireRow(scope, row, tr);
        }
    }

    setSelectionContexts(true);

    scope.sendSelectionStats();
    notifySelectionChanged(wrapper, selRect, model);
}

export function performSelectAll(scope: SelectionOperationsScope): void {
    const { wrapper, selRect, model } = scope;
    internalClearSelection(scope);
    model.isAllSelected = true;
    const rows = wrapper.querySelectorAll('tbody tr[data-index]');

    rows.forEach(tr => {
        // Note: We don't add 'row-selected' class here because 'select all' should
        // select data cells only, not the row number column. The visual selection
        // is handled by .selected-cell class on individual cells.
        // Select all data cells (skip row number cell)
        const cells = tr.querySelectorAll('td[data-cell-id]:not(.row-number-cell)');
        cells.forEach((td) => {
            const cellId = (td as HTMLElement).dataset.cellId;
            if (cellId) {
                model.selectedCells.add(cellId);
                td.classList.add('selected-cell');
            }
        });
    });

    setSelectionContexts(true);
    scope.sendSelectionStats();
    notifySelectionChanged(wrapper, selRect, model);
}

export function selectColumn(scope: SelectionOperationsScope, columnIndex: number): void {
    const { wrapper, selRect, model } = scope;
    // Clear previous selection first
    internalClearSelection(scope);
    model.selectedColumnIndex = columnIndex;

    // Select all cells in the column
    const rows = wrapper.querySelectorAll('tbody tr[data-index]');
    rows.forEach(tr => {
        const rowIndex = (tr as HTMLElement).dataset.index;
        const cellId = `${rowIndex}-${columnIndex}`;
        const cell = queryCell(wrapper, cellId);
        if (cell) {
            cell.classList.add('selected-cell');
            model.selectedCells.add(cellId);
        }
    });

    setSelectionContexts(model.selectedColumnIndex !== null || model.selectedCells.size > 0);

    scope.sendSelectionStats();
    notifySelectionChanged(wrapper, selRect, model);
}

export interface SelectionCopyHandlers {
    copySelection: (withHeaders?: boolean, plainTextFormat?: string) => void;
    copySelectionAsHtml: () => void;
    copySelectionAsMd: (withHeaders?: boolean) => void;
}

export function createCopyHandlers(scope: SelectionOperationsScope): SelectionCopyHandlers {
    const { table, model, clipboardResolver } = scope;

    return {
        copySelection: function (withHeaders = false, plainTextFormat?: string) {
            requestResultsViewFocus();

            // Auto-select all if nothing is selected
            if (!model.isAllSelected && model.selectedColumnIndex === null && model.selectedCells.size === 0) {
                performSelectAll(scope);
            }

            void (async () => {
                if (model.isAllSelected) {
                    await copyAllRowsAsync(table, withHeaders, plainTextFormat, clipboardResolver);
                    return;
                }

                if (model.selectedColumnIndex !== null) {
                    const payload = await buildSelectedColumnClipboardPayloadAsync(
                        table,
                        model.selectedColumnIndex,
                        withHeaders,
                        clipboardResolver,
                    );
                    if (!payload) {
                        return;
                    }

                    const plainText = resolvePlainText(payload, plainTextFormat);
                    writeMultiFormatToClipboard(payload.html, plainText, payload.md, `${payload.matrix.length} cells`);
                    return;
                }

                if (model.selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, model.selectedCells, withHeaders, clipboardResolver)
                    : buildSelectedClipboardPayload(table, model.selectedCells, withHeaders);
                if (!payload) {
                    return;
                }

                const plainText = resolvePlainText(payload, plainTextFormat);
                writeMultiFormatToClipboard(payload.html, plainText, payload.md, `${model.selectedCells.size} cells`);
            })();
        },

        copySelectionAsHtml: function () {
            requestResultsViewFocus();

            if (!model.isAllSelected && model.selectedColumnIndex === null && model.selectedCells.size === 0) {
                performSelectAll(scope);
            }

            void (async () => {
                if (model.isAllSelected) {
                    await copyAllRowsAsHtmlAsync(table, clipboardResolver);
                    return;
                }

                if (model.selectedColumnIndex !== null) {
                    const payload = await buildSelectedColumnClipboardPayloadAsync(
                        table,
                        model.selectedColumnIndex,
                        true,
                        clipboardResolver,
                    );
                    if (!payload) {
                        return;
                    }

                    writeMultiFormatToClipboard(payload.html, payload.text, payload.md, `${payload.matrix.length} cells`);
                    return;
                }

                if (model.selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, model.selectedCells, true, clipboardResolver)
                    : buildSelectedClipboardPayload(table, model.selectedCells, true);
                if (!payload) {
                    return;
                }

                writeMultiFormatToClipboard(payload.html, payload.text, payload.md, `${model.selectedCells.size} cells`);
            })();
        },

        copySelectionAsMd: function (withHeaders = true) {
            requestResultsViewFocus();

            if (!model.isAllSelected && model.selectedColumnIndex === null && model.selectedCells.size === 0) {
                performSelectAll(scope);
            }

            void (async () => {
                if (model.isAllSelected) {
                    await copyAllRowsAsMdAsync(table, withHeaders, clipboardResolver);
                    return;
                }

                if (model.selectedColumnIndex !== null) {
                    const payload = await buildSelectedColumnClipboardPayloadAsync(
                        table,
                        model.selectedColumnIndex,
                        withHeaders,
                        clipboardResolver,
                    );
                    if (!payload) {
                        return;
                    }

                    vscode.postMessage({
                        command: 'setContext',
                        key: 'netezza.resultsCopyPrimed',
                        value: false,
                    });

                    writeMultiFormatToClipboard(payload.html, payload.md, payload.md, `${payload.matrix.length} cells`);
                    return;
                }

                if (model.selectedCells.size === 0) {
                    return;
                }

                const payload = clipboardResolver
                    ? await buildSelectedClipboardPayloadAsync(table, model.selectedCells, withHeaders, clipboardResolver)
                    : buildSelectedClipboardPayload(table, model.selectedCells, withHeaders);
                if (!payload) {
                    return;
                }

                vscode.postMessage({
                    command: 'setContext',
                    key: 'netezza.resultsCopyPrimed',
                    value: false,
                });

                writeMultiFormatToClipboard(payload.html, payload.md, payload.md, `${model.selectedCells.size} cells`);
            })();
        },
    };
}
