import { asHtml } from '../dom.js';
import { canCreateRangeChart } from '../rangeChart.js';
import { callPanelMethod, getResultPanelWindow } from '../types.js';
import type { TanStackColumn, TanStackTable } from '../types.js';
import { formatCellValue } from '../utils.js';
import { postHostMessage } from '../protocol.js';
import { showColumnFilterDropdown } from '../filter.js';
import { setActiveResultViewMode } from '../analysis.js';
import { focusExploreColumn } from '../explore/focusColumn.js';
import { createChartRangeSubmenuItem, createContextMenuItem, createSubmenuItem, removeOpenSubmenus } from './contextMenu.js';
import { panelGetIsEditMode, parseDatasetIndex } from './interaction.js';
import type { SelectionModel } from './model.js';
import { getCellDescriptorFromTd, triggerRender } from './render.js';
import { promptForMenuValue } from './valuePrompt.js';

export interface SelectionMenuDeps {
    table: TanStackTable;
    wrapper: HTMLElement;
    model: SelectionModel;
}

interface ResultEditSource {
    db?: string;
    schema?: string;
    table: string;
}

function asEditSource(value: unknown): ResultEditSource | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.table !== 'string' || !record.table.trim()) return undefined;
    return {
        db: typeof record.db === 'string' ? record.db : undefined,
        schema: typeof record.schema === 'string' ? record.schema : undefined,
        table: record.table,
    };
}

function createMenuSeparator(): HTMLElement {
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
    separator.style.margin = '2px 0';
    return separator;
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
    menu.style.minWidth = '180px';
    menu.style.padding = '2px 0';

    // ─── Column Actions (from clicked cell) ───
    let colId: string | null = null;
    let column: TanStackColumn | null = null;
    let cellValue: string | null = null;
    let cellRawValue: unknown = null;
    let relatedRowIndex: number | null = null;
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
                    const row = allRows[rowIndex];
                    cellRawValue = row.getValue(colId);
                    const rowDetails = row as typeof row & {
                        getIsGrouped?: () => boolean;
                        subRows?: unknown[];
                    };
                    if (!rowDetails.getIsGrouped?.() && !rowDetails.subRows?.length) {
                        relatedRowIndex = row.index ?? rowIndex;
                    }
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
        const resultPanel = getResultPanelWindow();
        const activeResultIndex = resultPanel.getActiveGridIndex?.() ?? 0;
        const activeResult = resultPanel.resultSets?.[activeResultIndex];
        const activeSource = resultPanel.activeSource;
        const columnIndex = Number.parseInt(menuColId, 10);
        const columnName = (Number.isInteger(columnIndex) ? activeResult?.columns?.[columnIndex]?.name : undefined)
            ?? (typeof menuColumn.columnDef.header === 'string' ? menuColumn.columnDef.header : menuColId);
        const editSource = asEditSource(activeResult?.editSource);
        const canUseCatalogActions = Boolean(activeSource && editSource);

        const postColumnAction = (
            action: 'copyQualifiedName' | 'addToSelect' | 'commentOnColumn' | 'findReferences' | 'toggleFavorite',
        ): void => {
            if (!activeSource) return;
            postHostMessage({
                command: 'columnAction',
                sourceUri: activeSource,
                resultSetIndex: activeResultIndex,
                action,
                columnName,
                editSource,
            });
        };

        // Copy Name
        const copyNameItem = createContextMenuItem('Copy Name', function () {
            postHostMessage({ command: 'copyToClipboard', text: columnName });
            menu.remove();
        }, 'copy');
        menu.appendChild(copyNameItem);

        // Copy Qualified Name (only when the result is bound to one table)
        if (canUseCatalogActions) {
            const copyQualifiedItem = createContextMenuItem('Copy Qualified Name', function () {
                postColumnAction('copyQualifiedName');
                menu.remove();
            }, 'clipboard-copy');
            menu.appendChild(copyQualifiedItem);
        }

        // Add to SELECT
        const addToSelectItem = createContextMenuItem('Add to SELECT', function () {
            postColumnAction('addToSelect');
            menu.remove();
        }, 'plus');
        menu.appendChild(addToSelectItem);

        // Filter by Value (prompts instead of reusing the clicked cell)
        const filterByValueItem = createContextMenuItem('Filter by Value...', function () {
            menu.remove();
            void promptForMenuValue(`Filter ${columnName} by value`).then(function (value) {
                if (value === undefined) return;
                const trimmed = value.trim();
                const currentFilters = table.getState().columnFilters || [];
                const withoutCurrent = currentFilters.filter(function (f) { return f.id !== menuColId; });
                table.setColumnFilters(withoutCurrent.concat([{
                    id: menuColId,
                    value: {
                        _isConditionFilter: true,
                        conditions: [{
                            type: trimmed.length === 0 || trimmed.toUpperCase() === 'NULL' ? 'isEmpty' : 'equals',
                            value: trimmed,
                        }],
                        logic: 'and',
                    },
                }]));
                triggerRender(deps.wrapper);
            });
        }, 'search');
        menu.appendChild(filterByValueItem);

        // Sort Ascending
        const sortAscItem = createContextMenuItem('Sort Ascending', function () {
            table.setSorting([{ id: menuColId, desc: false }]);
            menu.remove();
            triggerRender(deps.wrapper);
        }, 'arrow-up');
        menu.appendChild(sortAscItem);

        // Sort Descending
        const sortDescItem = createContextMenuItem('Sort Descending', function () {
            table.setSorting([{ id: menuColId, desc: true }]);
            menu.remove();
            triggerRender(deps.wrapper);
        }, 'arrow-down');
        menu.appendChild(sortDescItem);

        // Select Distinct (the column filter dropdown lists every distinct value)
        const selectDistinctItem = createContextMenuItem('Select Distinct', function () {
            menu.remove();
            showColumnFilterDropdown(menuColumn, table, clickedCell ?? deps.wrapper, activeResultIndex);
        }, 'check-square');
        menu.appendChild(selectDistinctItem);

        // Profile Column (switch to Explore and highlight the matching card)
        const profileColumnItem = createContextMenuItem('Profile Column', function () {
            menu.remove();
            setActiveResultViewMode('explore');
            if (Number.isInteger(columnIndex)) {
                focusExploreColumn(columnIndex);
            }
        }, 'bar-chart');
        menu.appendChild(profileColumnItem);

        if (canUseCatalogActions) {
            const commentItem = createContextMenuItem('Comment on Column...', function () {
                postColumnAction('commentOnColumn');
                menu.remove();
            }, 'message-square');
            menu.appendChild(commentItem);

            const referencesItem = createContextMenuItem('Find References', function () {
                postColumnAction('findReferences');
                menu.remove();
            }, 'git-branch');
            menu.appendChild(referencesItem);

            const favoriteItem = createContextMenuItem('Add to favorites', function () {
                postColumnAction('toggleFavorite');
                menu.remove();
            }, 'star');
            menu.appendChild(favoriteItem);
        }

        // Separator
        menu.appendChild(createMenuSeparator());

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
            }, 'filter');
            menu.appendChild(filterValueItem);
        }

        // Clear filter on this column
        const clearFilterItem = createContextMenuItem('Clear Filter', function () {
            const currentFilters = table.getState().columnFilters || [];
            table.setColumnFilters(currentFilters.filter(function (f) { return f.id !== menuColId; }));
            menu.remove();
            triggerRender(deps.wrapper);
        }, 'filter-x');
        menu.appendChild(clearFilterItem);

        const canFindRelatedRows = Boolean(
            activeSource
            && activeResult?.isEditable
            && activeResult.storageMode !== 'sqlite'
            && activeResult.editSource
            && relatedRowIndex !== null
            && Number.isInteger(Number(menuColId))
            && cellRawValue !== null
            && cellRawValue !== undefined,
        );
        if (canFindRelatedRows && relatedRowIndex !== null) {
            const relatedRowsItem = createContextMenuItem('Find Related Rows', function () {
                callPanelMethod('openRelatedRows', relatedRowIndex, Number(menuColId));
                menu.remove();
            }, 'link');
            menu.appendChild(relatedRowsItem);
        }

        // Separator
        menu.appendChild(createMenuSeparator());

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
        }, 'layers');
        menu.appendChild(groupItem);

        // Hide Column
        const hideItem = createContextMenuItem('Hide Column', function () {
            menuColumn.toggleVisibility(false);
            menu.remove();
            triggerRender(deps.wrapper);
        }, 'eye-off');
        menu.appendChild(hideItem);

        // Separator before copy/export
        menu.appendChild(createMenuSeparator());
    }

    // ─── Row Actions (when right-click on row number) ───
    if (isRowMenu && selectedCells.size > 0) {
        const copyRowItem = createContextMenuItem('Copy Row', function () {
            if (typeof getResultPanelWindow().copySelection === 'function') {
                getResultPanelWindow().copySelection!(false, 'tabbed');
            }
            menu.remove();
        }, 'rows');
        menu.appendChild(copyRowItem);

        const copyRowMdItem = createContextMenuItem('Copy Row as MD', function () {
            if (typeof getResultPanelWindow().copySelectionAsMd === 'function') {
                getResultPanelWindow().copySelectionAsMd!(true);
            }
            menu.remove();
        }, 'file-text');
        menu.appendChild(copyRowMdItem);

        const rowViewItem = createContextMenuItem('Open in Row View', function () {
            callPanelMethod('toggleRowView');
            menu.remove();
        }, 'panel-right');
        menu.appendChild(rowViewItem);

        // Delete Row(s) — only in edit mode
        let inEditMode = false;
        try { inEditMode = panelGetIsEditMode(); } catch { /* panel may be unavailable during teardown */ }
        if (inEditMode) {
            const sepRow = document.createElement('div');
            sepRow.style.height = '1px';
            sepRow.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
            sepRow.style.margin = '2px 0';
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
            }, 'trash');
            deleteRowItem.style.color = 'var(--vscode-errorForeground)';
            menu.appendChild(deleteRowItem);
        }

        const rowSep = document.createElement('div');
        rowSep.style.height = '1px';
        rowSep.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        rowSep.style.margin = '2px 0';
        menu.appendChild(rowSep);
    }

    // Copy (tabbed without headers) stays one click; every other format lives in "Copy as".
    const copyItem = createContextMenuItem('Copy', function () {
        callPanelMethod('copySelection', false, 'tabbed');
        menu.remove();
    }, 'copy');
    menu.appendChild(copyItem);

    menu.appendChild(createSubmenuItem('Copy as', [
        { label: 'Tabbed with headers', icon: 'file-spreadsheet', onClick: () => callPanelMethod('copySelection', true, 'tabbed') },
        { label: 'Markdown table', icon: 'file-text', onClick: () => callPanelMethod('copySelectionAsMd', true) },
        { label: 'CSV', icon: 'table', onClick: () => callPanelMethod('copySelection', true, 'csv') },
        { label: 'JSON', icon: 'braces', onClick: () => callPanelMethod('copySelection', true, 'json') },
        { label: 'SQL INSERT statements', icon: 'database', onClick: () => callPanelMethod('copySelection', true, 'insert') },
        { label: 'SQL IN list', icon: 'list', onClick: () => callPanelMethod('copySelection', false, 'inList') },
        { label: 'HTML table', icon: 'code', onClick: () => callPanelMethod('copySelectionAsHtml') },
    ], menu, 'copy'));

    const cellDescriptor = clickedCell ? getCellDescriptorFromTd(table, clickedCell) : null;
    if (cellDescriptor) {
        const descriptor = cellDescriptor;
        const viewValueItem = createContextMenuItem('View Cell Value', function () {
            callPanelMethod('openValueViewer', descriptor);
            menu.remove();
        }, 'eye');
        menu.appendChild(viewValueItem);
    }

    const formattingItem = createContextMenuItem('Result Formatting...', function () {
        callPanelMethod('openResultFormattingPanel', { scope: 'result' });
        menu.remove();
    }, 'wrench');
    menu.appendChild(formattingItem);

    const hasSelection = selectedCells.size > 0;

    if (hasSelection && canCreateRangeChart(table, selectedCells)) {
        const chartRangeItem = createChartRangeSubmenuItem(table, selectedCells, menu);
        menu.appendChild(chartRangeItem);

        const chartSeparator = document.createElement('div');
        chartSeparator.style.height = '1px';
        chartSeparator.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
        chartSeparator.style.margin = '2px 0';
        menu.appendChild(chartSeparator);
    }

    // Separator
    const separator1 = document.createElement('div');
    separator1.style.height = '1px';
    separator1.style.backgroundColor = 'var(--vscode-menu-separatorBackground)';
    separator1.style.margin = '2px 0';
    menu.appendChild(separator1);

    if (hasSelection) {
        menu.appendChild(createSubmenuItem('Export Selection', [
            { label: 'Excel', icon: 'file-spreadsheet', onClick: () => callPanelMethod('exportSelectionToExcel') },
            { label: 'CSV', icon: 'file-text', onClick: () => callPanelMethod('exportSelectionToCsv') },
            { label: 'JSON', icon: 'braces', onClick: () => callPanelMethod('exportSelectionToJson') },
        ], menu, 'download'));
    }

    menu.appendChild(createSubmenuItem('Export All Visible', [
        { label: 'Excel', icon: 'file-spreadsheet', onClick: () => callPanelMethod('exportAllVisibleToExcel') },
        { label: 'CSV', icon: 'file-text', onClick: () => callPanelMethod('exportAllVisibleToCsv') },
        { label: 'JSON', icon: 'braces', onClick: () => callPanelMethod('exportAllVisibleToJson') },
    ], menu, 'download'));

    document.body.appendChild(menu);

    // Keep the menu inside the viewport. A menu taller than a small results panel scrolls
    // instead of being clipped at both edges.
    menu.style.maxHeight = Math.max(120, window.innerHeight - 16) + 'px';
    menu.style.overflowY = 'auto';
    const menuRect = menu.getBoundingClientRect();
    const fittedLeft = Math.min(x, window.innerWidth - menuRect.width - 8);
    const fittedTop = Math.min(y, window.innerHeight - menuRect.height - 8);
    menu.style.left = Math.max(8, fittedLeft) + 'px';
    menu.style.top = Math.max(8, fittedTop) + 'px';

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
