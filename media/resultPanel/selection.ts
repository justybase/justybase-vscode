// Selection module - Cell selection and copy functionality for result panel (facade)
//
// Bounded-module decomposition (CQ01): state lives in `selection/model.ts`,
// DOM queries/painting in `selection/render.ts`, mutations and copy handlers in
// `selection/operations.ts`, statistics delivery in `selection/stats.ts`, event
// wiring in `selection/events.ts`, and the context menu in `selection/menu.ts`.
// This facade only composes those modules and preserves the public contract
// consumed by `grid/tableBuilder.ts` and `media/resultPanel.ts`.
import { postHostMessage } from './protocol.js';
import { requestResultsViewFocus } from './selection/interaction.js';
import { createSelectionModel } from './selection/model.js';
import {
    clearSelection as clearGridSelection,
    createCopyHandlers,
    performSelectAll,
    selectColumn as selectGridColumn,
    type SelectionOperationsScope,
} from './selection/operations.js';
import { attachSelectionEvents } from './selection/events.js';
import { showContextMenu } from './selection/menu.js';
import { addCellIds, isCurrentActiveWrapper, reapplySelectionBorders } from './selection/render.js';
import { createSelectionStatsSender, invalidateSelectionStats } from './selection/stats.js';
import { getSelectedRowIndices as getRowsFromSelection } from './selection/model.js';
import type { ClipboardRowResolver } from './selection/clipboard.js';
import type { CellSelectionHandlers, TanStackTable } from './types.js';

export { __testHooks } from './selection/clipboard.js';

const vscode = { postMessage: postHostMessage };

export function setupCellSelectionEvents(
    wrapper: HTMLElement,
    table: TanStackTable,
    columnCount: number,
    clipboardResolver?: ClipboardRowResolver,
): CellSelectionHandlers {
    void columnCount;
    const model = createSelectionModel();

    // Selection rectangle overlay matching TableV2 style
    const selRect = document.createElement('div');
    selRect.className = 'sel-rect';
    wrapper.appendChild(selRect);

    const statsSender = createSelectionStatsSender({ table, wrapper, model, clipboardResolver });
    const scope: SelectionOperationsScope = {
        wrapper,
        table,
        selRect,
        model,
        clipboardResolver,
        sendSelectionStats: () => statsSender.sendSelectionStats(),
    };

    const selectionScopeKey = (): string => {
        const state = table.getState?.() ?? {};
        return JSON.stringify({
            sorting: state.sorting ?? [],
            columnFilters: state.columnFilters ?? [],
            globalFilter: state.globalFilter ?? '',
            grouping: state.grouping ?? [],
        });
    };
    let selectedRowsScopeKey: string | null = null;
    const onSelectionChanged = (): void => {
        if (model.isDestroyed) return;
        selectedRowsScopeKey = model.selectedCells.size > 0 || model.selectedColumnIndex !== null
            ? selectionScopeKey()
            : null;
    };
    const selectionEventTarget = typeof window.addEventListener === 'function' ? window : undefined;
    selectionEventTarget?.addEventListener('result-panel-selection-changed', onSelectionChanged);

    const copyHandlers = createCopyHandlers(scope);
    const attachedEvents = attachSelectionEvents({
        ...scope,
        showMenu: (x, y, clickedCell, isRowMenu = false) =>
            showContextMenu({ table, wrapper, model }, x, y, clickedCell, isRowMenu),
    });

    function onTableRowsRendered(): void {
        // Selection cell ids are display positions. A sort/filter/group change
        // remaps those positions to different records, so drop the stale selection
        // before reapplying its borders to the new row model.
        if (selectedRowsScopeKey !== null && selectedRowsScopeKey !== selectionScopeKey()) {
            clearGridSelection(scope);
        }
        addCellIds(wrapper, model);
        reapplySelectionBorders(wrapper, selRect, model);
        statsSender.refreshColumnStatsIfFilterChanged();
    }

    // Initial setup
    addCellIds(wrapper, model);

    return {
        copySelection: copyHandlers.copySelection,

        copySelectionAsHtml: copyHandlers.copySelectionAsHtml,

        copySelectionAsMd: copyHandlers.copySelectionAsMd,

        selectAll: function () {
            requestResultsViewFocus();
            performSelectAll(scope);
        },

        clearSelection: function () {
            clearGridSelection(scope);
        },

        hasSelection: function () {
            return model.selectedColumnIndex !== null || model.selectedCells.size > 0;
        },

        getSelectedRowIndices: function (limit = Number.POSITIVE_INFINITY) {
            const rows = Array.from(getRowsFromSelection(model.selectedCells));
            rows.sort((left, right) => left - right);
            return Number.isFinite(limit) ? rows.slice(0, Math.max(0, limit)) : rows;
        },

        selectColumn: function (columnIndex: number) {
            selectGridColumn(scope, columnIndex);
        },

        onTableRowsRendered: onTableRowsRendered,

        destroy: function () {
            if (model.isDestroyed) {
                return;
            }

            const shouldClearSelectionStats = model.selectedColumnIndex !== null
                && isCurrentActiveWrapper(wrapper, model.isDestroyed);
            model.isDestroyed = true;
            invalidateSelectionStats(model);
            attachedEvents.dispose();
            selectionEventTarget?.removeEventListener('result-panel-selection-changed', onSelectionChanged);
            if (shouldClearSelectionStats) {
                vscode.postMessage({ command: 'selectionStatsChanged', stats: null });
            }
        }
    };
}
