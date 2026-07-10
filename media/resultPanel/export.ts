// Export module - Export functionality for result panel
import {
    getActiveGridIndex,
    getAllGrids,
    getGrid,
    getGlobalDragState
} from './state.js';
import { getCurrentExportFormattingMetadata } from './formatting.js';
import { postHostMessage } from './protocol.js';
import { asHtml, getElementById } from './dom.js';
import {
    getActiveSourceUri,
    getResultSetAt,
    getResultSets,
} from './types.js';
import type { ResultSetColumn, TanStackRow, TanStackTable } from './types.js';

const vscode = { postMessage: postHostMessage };

interface SelectionIndices {
    rowIndices: number[];
    columnIds: string[];
}

interface ExportFormatOption {
    id: string;
    label: string;
    description: string;
}

interface ExportDestinationOption {
    id: string;
    label: string;
    description: string;
    formats?: string[];
}

interface ResultSetExportMetadata {
    resultSetIndex: number;
    rowIndices: number[];
    columnIds: string[];
    name: string;
    isActive: boolean;
    formatting?: ReturnType<typeof getCurrentExportFormattingMetadata>;
}

interface AllGridsExportPayload {
    sourceUri: string | undefined;
    results: ResultSetExportMetadata[];
}

interface ViewExportMetadata {
    sourceUri: string | undefined;
    resultSetIndex: number;
    rowIndices: number[];
    columnIds: string[];
    formatting: ReturnType<typeof getCurrentExportFormattingMetadata>;
}

interface ExportDragState {
    isDragging: boolean;
    dragType: string | null;
    draggedItem: string | null;
}

export function clearLogs(): void {
    const activeSource = getActiveSourceUri();
    if (activeSource) {
        vscode.postMessage({
            command: 'clearLogs',
            sourceUri: activeSource
        });
    }
}

export function getSelectedIndices(
    _table: TanStackTable,
    filteredRows: TanStackRow[],
    visibleColumnIds: string[],
    rsIndex: number = getActiveGridIndex(),
): SelectionIndices {
    const selectedCells = document.querySelectorAll('.selected-cell');
    if (!selectedCells || selectedCells.length === 0) {
        const rs = getResultSetAt(rsIndex);
        if (rs?.storageMode === 'sqlite') {
            return {
                rowIndices: [],
                columnIds: visibleColumnIds,
            };
        }
        return {
            rowIndices: filteredRows.map(row => row.index ?? 0),
            columnIds: visibleColumnIds
        };
    }

    const rowSet = new Set<number>();
    const colSet = new Set<number>();

    selectedCells.forEach(cell => {
        const id = cell.getAttribute('data-cell-id');
        if (id) {
            const [r, c] = id.split('-');
            rowSet.add(parseInt(r, 10));
            colSet.add(parseInt(c, 10));
        }
    });

    const finalColIds = Array.from(colSet)
        .map(cIndex => visibleColumnIds[cIndex])
        .filter((id): id is string => id !== undefined && id !== null);

    return {
        rowIndices: Array.from(rowSet).sort((a, b) => a - b),
        columnIds: finalColIds
    };
}

/** Full result set on the host — empty rowIndices exports all rows (memory + disk-backed). */
export function getFullGridExportIndices(table: TanStackTable): SelectionIndices {
    const columnIds = table.getVisibleLeafColumns()
        .filter(col => col.getIsVisible())
        .map(col => col.id);
    return {
        rowIndices: [],
        columnIds,
    };
}

export function getAllGridsExportData(): AllGridsExportPayload | null {
    const resultSets = getResultSets();
    if (resultSets.length === 0) return null;

    const exportMetadata: ResultSetExportMetadata[] = [];

    resultSets.forEach((rs, index) => {
        if (rs.isLog || rs.isTextContent) return;

        const grid = getGrid(index);
        if (!grid || !grid.tanTable) return;

        const table = grid.tanTable;
        const selection = getFullGridExportIndices(table);

        exportMetadata.push({
            resultSetIndex: index,
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            name: rs.name || `Result ${index + 1}`,
            isActive: index === getActiveGridIndex(),
            formatting: index === getActiveGridIndex() ? getCurrentExportFormattingMetadata() : undefined
        });
    });

    return {
        sourceUri: getActiveSourceUri(),
        results: exportMetadata
    };
}

export function openInExcel(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    vscode.postMessage({
        command: 'openInExcel',
        data: data
    });
}

export function openInFilePreview(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    vscode.postMessage({
        command: 'openInFilePreview',
        data: data
    });
}

export function openInExcelXlsx(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    vscode.postMessage({
        command: 'info',
        text: 'Starting Excel (XLSX) export...'
    });

    vscode.postMessage({
        command: 'openInExcelXlsx',
        data: data
    });
}

export function copyAsExcel(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    vscode.postMessage({
        command: 'copyAsExcel',
        data: data
    });
}

export function exportToCsv(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportCsv',
        data: payload
    });
}

const PRIMARY_EXPORT_FORMATS: ExportFormatOption[] = [
    { id: 'excel', label: 'Excel (XLSB)', description: 'Binary Excel format' },
    { id: 'xlsx', label: 'Excel (XLSX)', description: 'Modern Excel format' },
    { id: 'csv', label: 'CSV', description: 'Comma separated values' },
    { id: 'csv.gz', label: 'CSV.GZ', description: 'Gzip-compressed CSV' },
    { id: 'csv.zst', label: 'CSV.ZST', description: 'Zstandard-compressed CSV' },
    { id: 'json', label: 'JSON', description: 'JavaScript object notation' },
    { id: 'xml', label: 'XML', description: 'Extensible markup language' },
    { id: 'sql', label: 'SQL INSERT', description: 'SQL insert statements' },
    { id: 'markdown', label: 'Markdown', description: 'Markdown table' },
    { id: 'parquet', label: 'Parquet', description: 'Apache Parquet columnar format' },
    { id: 'xpt', label: 'SAS XPORT (.xpt)', description: 'SAS Transport Format v5' }
];

const PRIMARY_EXPORT_DESTINATIONS: ExportDestinationOption[] = [
    { id: 'file', label: 'Save to file', description: 'Choose a save location' },
    { id: 'temp', label: 'Copy file to clipboard', description: 'Save to temp directory and copy as file object – paste directly into Explorer' },
    { id: 'open', label: 'Open file', description: 'Save to temp and open in default app' },
    {
        id: 'clipboard',
        label: 'Copy content to clipboard',
        description: 'Copy text directly',
        formats: ['json', 'xml', 'markdown', 'sql', 'parquet']
    }
];

let pendingPrimaryExportFormat: string | null = null;

export function collectCurrentViewExportMetadata(): ViewExportMetadata | null {
    return buildFullGridExportPayload();
}

function buildFullGridExportPayload(): ViewExportMetadata | null {
    const grid = getGrid(getActiveGridIndex());
    if (!grid || !grid.tanTable) {
        return null;
    }

    const selection = getFullGridExportIndices(grid.tanTable);

    return {
        sourceUri: getActiveSourceUri(),
        resultSetIndex: getActiveGridIndex(),
        rowIndices: selection.rowIndices,
        columnIds: selection.columnIds,
        formatting: getCurrentExportFormattingMetadata()
    };
}

function closeExportPrimaryMenu(): void {
    const menu = getElementById('exportPrimaryMenu');
    if (menu) {
        menu.style.display = 'none';
    }
    pendingPrimaryExportFormat = null;
    const exportBtn = document.querySelector('#exportSplitBtn .split-btn__primary');
    if (exportBtn) {
        exportBtn.setAttribute('aria-expanded', 'false');
    }
}

function closeExportSplitMenu(): void {
    const menu = getElementById('exportSplitMenu');
    if (menu) {
        menu.style.display = 'none';
    }
}

function getDestinationsForFormat(formatId: string): ExportDestinationOption[] {
    return PRIMARY_EXPORT_DESTINATIONS.filter(
        destination => !destination.formats || destination.formats.includes(formatId)
    );
}

function createExportMenuItem(label: string, description: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'split-btn__menu-item export-menu-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    item.innerHTML =
        `<span class="export-menu-item__label">${label}</span>` +
        `<span class="export-menu-item__description">${description}</span>`;
    item.onclick = (event) => {
        event.stopPropagation();
        onClick();
    };
    item.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
        }
    };
    return item;
}

function renderExportPrimaryFormatMenu(): void {
    const menu = getElementById('exportPrimaryMenu');
    if (!menu) {
        return;
    }

    menu.innerHTML = '';
    pendingPrimaryExportFormat = null;

    const header = document.createElement('div');
    header.className = 'export-menu-header';
    header.textContent = 'Choose export format';
    menu.appendChild(header);

    PRIMARY_EXPORT_FORMATS.forEach(format => {
        menu.appendChild(createExportMenuItem(format.label, format.description, () => {
            onPrimaryExportFormatSelected(format.id);
        }));
    });
}

function renderExportPrimaryDestinationMenu(formatId: string): void {
    const format = PRIMARY_EXPORT_FORMATS.find(item => item.id === formatId);
    const menu = getElementById('exportPrimaryMenu');
    if (!menu || !format) {
        return;
    }

    menu.innerHTML = '';
    pendingPrimaryExportFormat = formatId;

    const header = document.createElement('div');
    header.className = 'export-menu-header export-menu-header--with-back';

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'export-menu-back';
    backButton.textContent = 'Back';
    backButton.onclick = (event) => {
        event.stopPropagation();
        renderExportPrimaryFormatMenu();
    };
    header.appendChild(backButton);

    const title = document.createElement('span');
    title.className = 'export-menu-header__title';
    title.textContent = format.label;
    header.appendChild(title);
    menu.appendChild(header);

    getDestinationsForFormat(formatId).forEach(destination => {
        menu.appendChild(createExportMenuItem(destination.label, destination.description, () => {
            submitPrimaryExportSelection(formatId, destination.id);
        }));
    });
}

function onPrimaryExportFormatSelected(formatId: string): void {
    renderExportPrimaryDestinationMenu(formatId);
}

function submitPrimaryExportSelection(formatId: string, destinationId: string): void {
    const exportData = collectCurrentViewExportMetadata();
    closeExportPrimaryMenu();
    closeExportSplitMenu();

    if (!exportData) {
        return;
    }

    vscode.postMessage({
        command: 'initiateExportWithSelection',
        data: exportData,
        format: formatId,
        destination: destinationId
    });
}

export function toggleExportPrimaryMenu(event?: Event): void {
    event?.stopPropagation?.();

    const menu = getElementById('exportPrimaryMenu');
    if (!menu) {
        return;
    }

    const isOpen = menu.style.display === 'block';
    closeExportSplitMenu();

    if (isOpen) {
        closeExportPrimaryMenu();
        return;
    }

    if (!collectCurrentViewExportMetadata()) {
        return;
    }

    renderExportPrimaryFormatMenu();
    menu.style.display = 'block';

    const exportBtn = document.querySelector('#exportSplitBtn .split-btn__primary');
    if (exportBtn) {
        exportBtn.setAttribute('aria-expanded', 'true');
    }
}

export function handleClickExport(): void {
    toggleExportPrimaryMenu();
}

export function handleClickQueryLocallyDuckDB(): void {
    const activeIndex = getActiveGridIndex();
    const grid = getGrid(activeIndex);
    const activeSource = getActiveSourceUri();
    if (!grid || !grid.tanTable || !activeSource) return;

    vscode.postMessage({
        command: 'queryLocallyDuckDB',
        data: {
            sourceUri: getActiveSourceUri(),
            resultSetIndex: activeIndex
        }
    });
}

export function getValueForExport(
    row: TanStackRow,
    columnId: string,
    resultSetColumns: ResultSetColumn[],
): unknown {
    const index = parseInt(columnId);
    if (row.original) {
        if (Array.isArray(row.original)) {
            if (!isNaN(index) && index >= 0 && index < row.original.length) {
                return row.original[index];
            }
        } else {
            const record = row.original as Record<string, unknown>;
            const colDef = resultSetColumns[index];
            if (colDef && colDef.accessorKey) {
                return record[colDef.accessorKey];
            }
            return record[columnId];
        }
    }
    return null;
}

export function exportToJson(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportJson',
        data: payload
    });
}

export function exportToXml(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportXml',
        data: payload
    });
}

export function exportToSqlInsert(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportSqlInsert',
        data: payload
    });
}

export function exportToMarkdown(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportMarkdown',
        data: payload
    });
}

// Drag and drop handlers for grouping panel
function findGroupPanel(event: DragEvent): HTMLElement | null {
    const panel = getElementById('groupingPanel');
    const sidebar = getElementById('sidebarGroupDropZone');
    const target = event.target;
    if (sidebar && target instanceof Node && sidebar.contains(target)) {
        return sidebar;
    }
    return panel;
}

export function clearGroupDropTargets(): void {
    ['groupingPanel', 'sidebarGroupDropZone'].forEach((elementId) => {
        const element = getElementById(elementId);
        if (!element) {
            return;
        }
        element.classList.remove('drop-target');
        element.removeAttribute('data-drag-label');
    });

    document.querySelectorAll('.group-chip.drag-over').forEach((chip) => {
        chip.classList.remove('drag-over');
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('dragend', clearGroupDropTargets);
}

export function onDragOverGroup(event: DragEvent): void {
    event.preventDefault();

    const panel = findGroupPanel(event);
    if (panel && event.dataTransfer) {
        const dragState = getGlobalDragState();
        if (dragState.dragType === 'column') {
            event.dataTransfer.dropEffect = 'copy';
            clearGroupDropTargets();
            panel.classList.add('drop-target');
        } else if (dragState.dragType === 'groupChip') {
            event.dataTransfer.dropEffect = 'move';
            clearGroupDropTargets();
            panel.classList.add('drop-target');
        } else {
            event.dataTransfer.dropEffect = 'none';
        }
    }
}

export function onDragLeaveGroup(event: DragEvent): void {
    const panel = findGroupPanel(event);
    if (panel && event.relatedTarget instanceof Node && !panel.contains(event.relatedTarget)) {
        panel.classList.remove('drop-target');
        panel.removeAttribute('data-drag-label');
    }
}

export function onDropGroup(event: DragEvent): void {
    event.preventDefault();
    clearGroupDropTargets();
    const panel = findGroupPanel(event);

    if (!event.dataTransfer) {
        return;
    }

    const type = event.dataTransfer.getData('type');

    if (type === 'column') {
        const colId = event.dataTransfer.getData('columnId');
        const grid = getGrid(getActiveGridIndex());
        if (colId && grid?.tanTable) {
            const currentGrouping = grid.tanTable.getState().grouping || [];
            if (!currentGrouping.includes(colId)) {
                grid.tanTable.setGrouping([...currentGrouping, colId]);
            }
        }
    } else if (type === 'groupChip') {
        const draggedColId = event.dataTransfer.getData('text/plain');
        let targetElement = asHtml(asHtml(event.target)?.closest('.group-chip'));

        if (!targetElement && panel) {
            const allChips = panel.querySelectorAll('.group-chip');
            if (allChips.length > 0) {
                targetElement = asHtml(allChips[allChips.length - 1]);
            }
        }

        if (targetElement) {
            const targetColId = targetElement.dataset.colId;
            const grid = getGrid(getActiveGridIndex());
            if (draggedColId && targetColId && draggedColId !== targetColId && grid?.tanTable) {
                const currentGrouping = grid.tanTable.getState().grouping || [];
                const newGrouping = [...currentGrouping];
                const fromIndex = newGrouping.indexOf(draggedColId);
                const toIndex = newGrouping.indexOf(targetColId);

                if (fromIndex !== -1 && toIndex !== -1) {
                    newGrouping.splice(fromIndex, 1);
                    const insertIndex = fromIndex < toIndex ? toIndex : toIndex + 1;
                    newGrouping.splice(insertIndex, 0, draggedColId);
                    grid.tanTable.setGrouping(newGrouping);
                }
            }
        }
    }
}

// Global drag state (for compatibility)
let globalDragState: ExportDragState = {
    isDragging: false,
    dragType: null,
    draggedItem: null
};

export function setGlobalDragStateForExport(state: Partial<ExportDragState>): void {
    globalDragState = { ...globalDragState, ...state };
}

// Export functions that always export the full result set (ignoring cell selection)
export function exportAllVisibleToCsv(): void {
    exportToCsv();
}

export function exportAllVisibleToJson(): void {
    exportToJson();
}

export function exportAllVisibleToXml(): void {
    exportToXml();
}

export function exportAllVisibleToSqlInsert(): void {
    exportToSqlInsert();
}

export function exportAllVisibleToMarkdown(): void {
    exportToMarkdown();
}

export function exportAllVisibleToExcel(): void {
    const grid = getGrid(getActiveGridIndex());
    if (!grid || !grid.tanTable) return;

    const selection = getFullGridExportIndices(grid.tanTable);

    vscode.postMessage({
        command: 'openInExcel',
        data: {
            sourceUri: getActiveSourceUri(),
            results: [{
                resultSetIndex: getActiveGridIndex(),
                rowIndices: selection.rowIndices,
                columnIds: selection.columnIds,
                name: getResultSetAt(getActiveGridIndex())?.name || `Result ${getActiveGridIndex() + 1}`,
                isActive: true
            }]
        }
    });
}

// Export functions that export only selection
export function exportSelectionToCsv(): void {
    const grid = getGrid(getActiveGridIndex());
    if (!grid || !grid.tanTable) return;

    // Check if there is an actual selection FIRST
    const selectedCells = document.querySelectorAll('.selected-cell');
    if (selectedCells.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No cells selected. Please select cells to export.'
        });
        return;
    }

    const table = grid.tanTable;
    const rows = table.getFilteredRowModel().rows;
    const allVisibleColumnIds = table.getVisibleLeafColumns()
        .filter(col => col.getIsVisible())
        .map(col => col.id);

    const selection = getSelectedIndices(table, rows, allVisibleColumnIds);

    vscode.postMessage({
        command: 'exportCsv',
        data: {
            sourceUri: getActiveSourceUri(),
            resultSetIndex: getActiveGridIndex(),
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            formatting: getCurrentExportFormattingMetadata()
        }
    });
}

export function exportSelectionToJson(): void {
    const grid = getGrid(getActiveGridIndex());
    if (!grid || !grid.tanTable) return;

    // Check if there is an actual selection FIRST
    const selectedCells = document.querySelectorAll('.selected-cell');
    if (selectedCells.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No cells selected. Please select cells to export.'
        });
        return;
    }

    const table = grid.tanTable;
    const rows = table.getFilteredRowModel().rows;
    const allVisibleColumnIds = table.getVisibleLeafColumns()
        .filter(col => col.getIsVisible())
        .map(col => col.id);

    const selection = getSelectedIndices(table, rows, allVisibleColumnIds);

    vscode.postMessage({
        command: 'exportJson',
        data: {
            sourceUri: getActiveSourceUri(),
            resultSetIndex: getActiveGridIndex(),
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            formatting: getCurrentExportFormattingMetadata()
        }
    });
}

export function exportSelectionToExcel(): void {
    const grid = getGrid(getActiveGridIndex());
    if (!grid || !grid.tanTable) return;

    // Check if there is an actual selection FIRST
    const selectedCells = document.querySelectorAll('.selected-cell');
    if (selectedCells.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No cells selected. Please select cells to export.'
        });
        return;
    }

    const table = grid.tanTable;
    const rows = table.getFilteredRowModel().rows;
    const allVisibleColumnIds = table.getVisibleLeafColumns()
        .filter(col => col.getIsVisible())
        .map(col => col.id);

    const selection = getSelectedIndices(table, rows, allVisibleColumnIds);

    vscode.postMessage({
        command: 'openInExcel',
        data: {
            sourceUri: getActiveSourceUri(),
            results: [{
                resultSetIndex: getActiveGridIndex(),
                rowIndices: selection.rowIndices,
                columnIds: selection.columnIds,
                name: getResultSetAt(getActiveGridIndex())?.name || `Result ${getActiveGridIndex() + 1}`,
                isActive: true
            }]
        }
    });
}

/**
 * Build a markdown document combining all result sets with their SQL
 * Posts to host for save dialog and file writing
 */
export function exportToParquet(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    vscode.postMessage({
        command: 'exportParquet',
        data: payload
    });
}

export function exportToMdFile(): void {
    const resultSets = getResultSets();
    if (resultSets.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No result sets to export.'
        });
        return;
    }

    const dataResults = resultSets.filter(
        rs => !rs.isLog && !rs.isError && !rs.isTextContent && rs.data && rs.data.length > 0,
    );
    if (dataResults.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No data result sets to export.'
        });
        return;
    }

    let mdDocument = '# SQL Export\n\n';

    for (let i = 0; i < dataResults.length; i++) {
        const rs = dataResults[i];
        mdDocument += `## Query ${i + 1}\n\n`;
        mdDocument += '```sql\n' + (rs.sql || '') + '\n```\n\n';
        mdDocument += '### Results\n\n';

        if (rs.columns && rs.data && rs.data.length > 0) {
            const headers = rs.columns.map(c => String(c.name || ''));
            mdDocument += '| ' + headers.join(' | ') + ' |\n';
            mdDocument += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
            const maxRows = Math.min(rs.data.length, 1000);
            for (let ri = 0; ri < maxRows; ri++) {
                const row = rs.data[ri];
                const cells = headers.map((_h, ci) => {
                    const val = row[ci];
                    if (val === null || val === undefined) return 'NULL';
                    return String(val).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
                });
                mdDocument += '| ' + cells.join(' | ') + ' |\n';
            }
            if (rs.data.length > 1000) {
                mdDocument += '\n';
                mdDocument += `*Table truncated: ${rs.data.length} total rows, showing first 1000*\n`;
            }
        } else {
            mdDocument += '*No data in this result set*\n';
        }

        mdDocument += '\n---\n\n';
    }

    vscode.postMessage({
        command: 'exportToMdFile',
        data: {
            sourceUri: getActiveSourceUri(),
            mdDocument: mdDocument
        }
    });
}

/**
 * Export all result sets as separate sheets in a single Excel file (XLSX/XLSB)
 * This function collects data from all grids and sends it to the backend
 */
export function exportAllResultSetsToExcel(): void {
    const resultSets = getResultSets();
    if (resultSets.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No result sets to export.'
        });
        return;
    }

    const grids = getAllGrids();
    let dataResultSetCounter = 0; // Counter for data result sets only (excludes logs/errors)

    // Build metadata for all result sets
    const results: Array<{
        resultSetIndex: number;
        rowIndices: number[];
        columnIds: string[];
        name: string;
        isActive: boolean;
    }> = [];
    for (let i = 0; i < resultSets.length; i++) {
        const rs = resultSets[i];
        // Skip log and error result sets
        if (rs.isLog || rs.isError || rs.isTextContent) continue;

        const grid = grids[i];
        if (!grid || !grid.tanTable) continue;

        dataResultSetCounter++; // Increment only for valid data results that will be exported

        const table = grid.tanTable;
        const selection = getFullGridExportIndices(table);

        results.push({
            resultSetIndex: i,
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            name: rs.name || `Result ${dataResultSetCounter}`,
            isActive: i === getActiveGridIndex()
        });
    }

    if (results.length === 0) {
        vscode.postMessage({
            command: 'info',
            text: 'No data available to export.'
        });
        return;
    }

    vscode.postMessage({
        command: 'exportAllResultSetsToExcel',
        data: {
            sourceUri: getActiveSourceUri(),
            results: results
        }
    });
}
