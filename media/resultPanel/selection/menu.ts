import { asHtml } from '../dom.js';
import { canCreateRangeChart } from '../rangeChart.js';
import { callPanelMethod, getResultPanelWindow } from '../types.js';
import type { TanStackColumn, TanStackTable } from '../types.js';
import { formatCellValue } from '../utils.js';
import { createChartRangeSubmenuItem, createContextMenuItem, removeOpenSubmenus } from './contextMenu.js';
import { panelGetIsEditMode, parseDatasetIndex } from './interaction.js';
import type { SelectionModel } from './model.js';
import { getCellDescriptorFromTd, triggerRender } from './render.js';

export interface SelectionMenuDeps {
    table: TanStackTable;
    wrapper: HTMLElement;
    model: SelectionModel;
}

export function showContextMenu(deps: SelectionMenuDeps, x: number, y: number, clickedCell: HTMLElement | null, isRowMenu = false): void {
    const { table, model } = deps;
    const selectedCells = model.selectedCells;
    // Close any existing context menu
    const existingMenu = document.querySelector('.grid-context-menu');
    if (existingMenu) {
        existingMenu.remove();
    }

    const menu = document.createElement('div');
    menu.className = 'grid-context-menu';
    menu.style.position = 'fixed';
    menu.style.top = y + 'px';
    menu.style.left = x + 'px';
    menu.style.backgroundColor = 'var(--vscode-menu-background)';
    menu.style.border = '1px solid var(--vscode-menu-border)';
    menu.style.borderRadius = '4px';
    menu.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
    menu.style.zIndex = '10000';
    menu.style.minWidth = '200px';
    menu.style.padding = '4px 0';

    // ─── Column Actions (from clicked cell) ───
    let colId: string | null = null;
    let column: TanStackColumn | null = null;
    let cellValue: string | null = null;
    let cellRawValue: unknown = null;
    if (clickedCell) {
        const td = clickedCell;
        const tr = td.closest('tr');
        if (tr) {
            const cellIdx = Array.from(tr.children).indexOf(td) - 1; // minus row-number col
            const visibleCols = table.getVisibleLeafColumns();
            if (cellIdx >= 0 && visibleCols[cellIdx]) {
                column = visibleCols[cellIdx];
                colId = column.id;
                // Get raw value from row data (bypass formatted DOM text)
                const rowIndex = parseDatasetIndex(tr);
                const allRows = table.getRowModel().rows;
                if (rowIndex !== null && allRows[rowIndex]) {
                    cellRawValue = allRows[rowIndex].getValue(colId);
                    // Format for display in the menu label
                    const colDef = column.columnDef;
                    cellValue = formatCellValue(cellRawValue, colDef.dataType, colDef.scale, {
                        columnId: colId,
                        inferredNumericKind: colDef.inferredNumericKind,
                        inferredDateInteger: colDef.inferredDateInteger
                    });
                } else {
                    cellValue = td.textContent;
                }
            }
        }
    }

    if (colId && column) {
        const menuColId = colId;
        const menuColumn = column;
        // Sort Ascending
        const sortAscItem = createContextMenuItem('Sort Ascending', function () {
            table.setSorting([{ id: menuColId, desc: false }]);
            menu.remove();
            triggerRender(deps.wrapper);
        });
        menu.appendChild(sortAscItem);

        // Sort Descending
        const sortDescItem = createContextMenuItem('Sort Descending', function () {
            table.setSorting([{ id: menuColId, desc: true }]);
            menu.remove();
            triggerRender(deps.wrapper);
        });
        menu.appendChild(sortDescItem);

        // Separator
        const colSep1 = document.createElement('div');
        colSep1.style.height = '1px';
        colSep1.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        colSep1.style.margin = '4px 0';
        menu.appendChild(colSep1);

        // Filter by this value (uses raw value, condition filter format)
        if (cellValue && cellValue !== '' && cellValue !== 'NULL') {
            const filterLabel = 'Filter by "' + cellValue.substring(0, 40) + '"';
            const filterValueItem = createContextMenuItem(filterLabel, function () {
                const currentFilters = table.getState().columnFilters || [];
                const withoutCurrent = currentFilters.filter(function (f) { return f.id !== menuColId; });
                // Use raw value for the condition (avoids formatting issues like thousand separators)
                const filterCondValue = (cellRawValue !== null && cellRawValue !== undefined) ? cellRawValue : cellValue;
                table.setColumnFilters(withoutCurrent.concat([{
                    id: menuColId,
                    value: { _isConditionFilter: true, conditions: [{ type: 'equals', value: String(filterCondValue) }], logic: 'and' }
                }]));
                menu.remove();
                triggerRender(deps.wrapper);
            });
            menu.appendChild(filterValueItem);
        }

        // Clear filter on this column
        const clearFilterItem = createContextMenuItem('Clear Filter', function () {
            const currentFilters = table.getState().columnFilters || [];
            table.setColumnFilters(currentFilters.filter(function (f) { return f.id !== menuColId; }));
            menu.remove();
            triggerRender(deps.wrapper);
        });
        menu.appendChild(clearFilterItem);

        // Separator
        const colSep2 = document.createElement('div');
        colSep2.style.height = '1px';
        colSep2.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        colSep2.style.margin = '4px 0';
        menu.appendChild(colSep2);

        // Group by This Column
        const groupItem = createContextMenuItem('Group by This Column', function () {
            const currentGrouping = table.getState().grouping || [];
            if (currentGrouping.indexOf(menuColId) !== -1) {
                table.setGrouping(currentGrouping.filter(function (g) { return g !== menuColId; }));
            } else {
                table.setGrouping(currentGrouping.concat([menuColId]));
            }
            menu.remove();
            triggerRender(deps.wrapper);
        });
        menu.appendChild(groupItem);

        // Hide Column
        const hideItem = createContextMenuItem('Hide Column', function () {
            menuColumn.toggleVisibility(false);
            menu.remove();
            triggerRender(deps.wrapper);
        });
        menu.appendChild(hideItem);

        // Separator before copy/export
        const colSep3 = document.createElement('div');
        colSep3.style.height = '1px';
        colSep3.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        colSep3.style.margin = '4px 0';
        menu.appendChild(colSep3);
    }

    // ─── Row Actions (when right-click on row number) ───
    if (isRowMenu && selectedCells.size > 0) {
        const copyRowItem = createContextMenuItem('Copy Row', function () {
            if (typeof getResultPanelWindow().copySelection === 'function') {
                getResultPanelWindow().copySelection!(false, 'tabbed');
            }
            menu.remove();
        });
        menu.appendChild(copyRowItem);

        const copyRowMdItem = createContextMenuItem('Copy Row as MD', function () {
            if (typeof getResultPanelWindow().copySelectionAsMd === 'function') {
                getResultPanelWindow().copySelectionAsMd!(true);
            }
            menu.remove();
        });
        menu.appendChild(copyRowMdItem);

        // Delete Row(s) — only in edit mode
        let inEditMode = false;
        try { inEditMode = panelGetIsEditMode(); } catch { /* panel may be unavailable during teardown */ }
        if (inEditMode) {
            const sepRow = document.createElement('div');
            sepRow.style.height = '1px';
            sepRow.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            sepRow.style.margin = '4px 0';
            menu.appendChild(sepRow);

            const rowCount = selectedCells.size > 0 ? new Set(Array.from(selectedCells).map(function (c) { return c.split('-')[0]; })).size : 0;
            const delLabel = rowCount > 1 ? 'Delete ' + rowCount + ' Rows' : 'Delete Row';
            const deleteRowItem = createContextMenuItem(delLabel, function () {
                // Collect unique row indices from selected cells
                const rowIndices = new Set<number>();
                selectedCells.forEach(function (cid) { rowIndices.add(parseInt(cid.split('-')[0])); });
                rowIndices.forEach(function (ri) {
                    callPanelMethod('markRowForDelete', ri);
                });
                menu.remove();
            });
            deleteRowItem.style.color = 'var(--vscode-errorForeground)';
            menu.appendChild(deleteRowItem);
        }

        const rowSep = document.createElement('div');
        rowSep.style.height = '1px';
        rowSep.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        rowSep.style.margin = '4px 0';
        menu.appendChild(rowSep);
    }

    // Copy as MD option (default format)
    const copyAsMdItem = createContextMenuItem('Copy as MD', function () {
        callPanelMethod('copySelectionAsMd', true);
        menu.remove();
    });
    menu.appendChild(copyAsMdItem);

    // Copy as tabbed with headers option
    const copyTabbedItem = createContextMenuItem('Copy as tabbed with headers', function () {
        callPanelMethod('copySelection', true, 'tabbed');
        menu.remove();
    });
    menu.appendChild(copyTabbedItem);

    // Copy option (tabbed without headers)
    const copyItem = createContextMenuItem('Copy', function () {
        callPanelMethod('copySelection', false, 'tabbed');
        menu.remove();
    });
    menu.appendChild(copyItem);

    const cellDescriptor = clickedCell ? getCellDescriptorFromTd(table, clickedCell) : null;
    if (cellDescriptor) {
        const descriptor = cellDescriptor;
        const viewValueItem = createContextMenuItem('View Cell Value', function () {
            callPanelMethod('openValueViewer', descriptor);
            menu.remove();
        });
        menu.appendChild(viewValueItem);
    }

    const formattingItem = createContextMenuItem('Result Formatting...', function () {
        callPanelMethod('openResultFormattingPanel', { scope: 'result' });
        menu.remove();
    });
    menu.appendChild(formattingItem);

    const hasSelection = selectedCells.size > 0;

    if (hasSelection && canCreateRangeChart(table, selectedCells)) {
        const chartRangeItem = createChartRangeSubmenuItem(table, selectedCells, menu);
        menu.appendChild(chartRangeItem);

        const chartSeparator = document.createElement('div');
        chartSeparator.style.height = '1px';
        chartSeparator.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        chartSeparator.style.margin = '4px 0';
        menu.appendChild(chartSeparator);
    }

    // Separator
    const separator1 = document.createElement('div');
    separator1.style.height = '1px';
    separator1.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
    separator1.style.margin = '4px 0';
    menu.appendChild(separator1);

    // Export Selection submenu
    if (hasSelection) {
        const exportSelectionItem = createContextMenuItem('Export Selection to CSV', function () {
            callPanelMethod('exportSelectionToCsv');
            menu.remove();
        });
        menu.appendChild(exportSelectionItem);

        const exportSelectionJsonItem = createContextMenuItem('Export Selection to JSON', function () {
            callPanelMethod('exportSelectionToJson');
            menu.remove();
        });
        menu.appendChild(exportSelectionJsonItem);

        const exportSelectionExcelItem = createContextMenuItem('Export Selection to Excel', function () {
            callPanelMethod('exportSelectionToExcel');
            menu.remove();
        });
        menu.appendChild(exportSelectionExcelItem);

        // Separator
        const separator2 = document.createElement('div');
        separator2.style.height = '1px';
        separator2.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        separator2.style.margin = '4px 0';
        menu.appendChild(separator2);
    }

    // Export All Visible options
    const exportAllCsvItem = createContextMenuItem('Export All Visible to CSV', function () {
        callPanelMethod('exportAllVisibleToCsv');
        menu.remove();
    });
    menu.appendChild(exportAllCsvItem);

    const exportAllJsonItem = createContextMenuItem('Export All Visible to JSON', function () {
        callPanelMethod('exportAllVisibleToJson');
        menu.remove();
    });
    menu.appendChild(exportAllJsonItem);

    const exportAllExcelItem = createContextMenuItem('Export All Visible to Excel', function () {
        callPanelMethod('exportAllVisibleToExcel');
        menu.remove();
    });
    menu.appendChild(exportAllExcelItem);

    document.body.appendChild(menu);

    // Position menu to stay within viewport
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - menuRect.width - 10) + 'px';
    }
    if (menuRect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - menuRect.height - 10) + 'px';
    }

    // Close menu on click outside
    const closeMenu = function (e: MouseEvent) {
        const target = e.target instanceof Node ? e.target : null;
        if (!menu.contains(target) && !asHtml(target)?.closest('.grid-context-submenu')) {
            menu.remove();
            removeOpenSubmenus();
            document.removeEventListener('click', closeMenu);
            document.removeEventListener('contextmenu', closeMenu);
        }
    };

    setTimeout(function () {
        document.addEventListener('click', closeMenu);
        document.addEventListener('contextmenu', closeMenu);
    }, 0);
}
