// Export module - Export functionality for result panel
import {
    getActiveGridIndex,
    getAllGrids,
    getGrid,
    getGlobalDragState,
    setGlobalDragState,
} from './state.js';
import { getCurrentExportFormattingMetadata } from './formatting.js';
import { postHostMessage } from './protocol.js';
import { asHtml, getElementById } from './dom.js';
import {
    callPanelMethod,
    getActiveSourceUri,
    getResultSetAt,
    getResultSets,
    requireActiveSourceUri,
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
    more?: boolean;
}

interface ResultSetExportMetadata {
    resultSetIndex: number;
    rowIndices: number[];
    columnIds: string[];
    name: string;
    isActive: boolean;
    formatting?: ReturnType<typeof getCurrentExportFormattingMetadata>;
    rowScope?: ExportRowScope;
}

interface AllGridsExportPayload {
    sourceUri: string | undefined;
    results: ResultSetExportMetadata[];
    rowScope?: ExportRowScope;
}

interface ViewExportMetadata {
    sourceUri: string | undefined;
    resultSetIndex: number;
    rowIndices: number[];
    columnIds: string[];
    formatting: ReturnType<typeof getCurrentExportFormattingMetadata>;
    rowScope?: ExportRowScope;
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

    vscode.postMessage({ command: 'openInExcel', data });
}

export function openInFilePreview(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'openInFilePreview', data: scopedData }));
}

export function openInExcelXlsx(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    postExportWithScope(data, scopedData => {
        vscode.postMessage({
            command: 'info',
            text: 'Starting Excel (XLSX) export...'
        });
        vscode.postMessage({ command: 'openInExcelXlsx', data: scopedData });
    });
}

export function copyAsExcel(): void {
    const data = getAllGridsExportData();
    if (!data || data.results.length === 0) return;

    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'copyAsExcel', data: scopedData }));
}

export function exportToCsv(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportCsv', data }));
}

/** Common formats are chips; `more` formats sit in the "More…" picker. */
const EXPORT_FORMATS: ExportFormatOption[] = [
    { id: 'xlsx', label: 'Excel', description: 'Excel workbook (.xlsx)' },
    { id: 'csv', label: 'CSV', description: 'Comma separated values (.csv)' },
    { id: 'json', label: 'JSON', description: 'Array of row objects (.json)' },
    { id: 'markdown', label: 'Markdown', description: 'Markdown table with the SQL (.md, up to 1000 rows)' },
    { id: 'sql', label: 'SQL INSERT', description: 'INSERT statements, data only (.sql)' },
    { id: 'excel', label: 'Excel binary (.xlsb)', description: 'Binary Excel workbook (.xlsb) — fastest for large results', more: true },
    { id: 'xml', label: 'XML', description: 'Extensible markup language (.xml)', more: true },
    { id: 'parquet', label: 'Parquet', description: 'Apache Parquet columnar format (.parquet)', more: true },
    { id: 'csv.gz', label: 'CSV.GZ', description: 'Gzip-compressed CSV (.csv.gz)', more: true },
    { id: 'csv.zst', label: 'CSV.ZST', description: 'Zstandard-compressed CSV (.csv.zst)', more: true },
    { id: 'xpt', label: 'SAS XPORT (.xpt)', description: 'SAS Transport Format v5 (.xpt)', more: true },
];

const DEFAULT_EXPORT_FORMAT = 'xlsx';

/**
 * Host destinations: save dialog, temp file opened externally, temp file put on
 * the clipboard, or the exported text itself put on the clipboard.
 */
type ExportDestination = 'file' | 'open' | 'temp' | 'clipboard';

/** Formats whose exported content is text that can go straight to the clipboard. */
const TEXT_CONTENT_FORMATS = new Set(['csv', 'json', 'markdown', 'sql', 'xml']);

type ExportRowScope = 'loaded' | 'all';

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
    const exportBtn = document.querySelector('#exportSplitBtn .split-btn__primary');
    if (exportBtn) {
        exportBtn.setAttribute('aria-expanded', 'false');
    }
}

function showStandaloneExportScope(onSelected: (scope: ExportRowScope) => void): void {
    const menu = getElementById('exportPrimaryMenu');
    if (!menu) return;

    menu.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'export-menu-header export-menu-header--with-back';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'export-menu-back';
    cancelButton.textContent = 'Cancel';
    cancelButton.onclick = (event) => {
        event.stopPropagation();
        closeExportPrimaryMenu();
    };
    header.appendChild(cancelButton);
    const title = document.createElement('span');
    title.className = 'export-menu-header__title';
    title.textContent = 'Rows to export';
    header.appendChild(title);
    menu.appendChild(header);

    const select = (scope: ExportRowScope) => {
        closeExportPrimaryMenu();
        onSelected(scope);
    };
    menu.appendChild(createExportMenuItem(
        'Loaded rows',
        'Export only the rows currently loaded in SQL Results.',
        () => select('loaded'),
    ));
    menu.appendChild(createExportMenuItem(
        'ALL rows',
        'Re-run SQL without LIMIT, then export all returned rows.',
        () => select('all'),
    ));
    menu.style.display = 'block';
}

function postExportWithScope<T extends object>(
    data: T,
    post: (data: T & { rowScope?: ExportRowScope }) => void,
): void {
    if (!activeResultHasTrailingLimit()) {
        post(data);
        return;
    }
    showStandaloneExportScope(scope => post({ ...data, rowScope: scope }));
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

function activeResultHasTrailingLimit(): boolean {
    const refreshSql = getResultSetAt(getActiveGridIndex())?.refreshSql?.trim();
    if (!refreshSql) return false;
    return /\blimit(?:\s+(?:\/\*[\s\S]*?\*\/\s*)*|\/\*[\s\S]*?\*\/\s*)(\d+)(\s*;?\s*)$/i.test(refreshSql);
}

/**
 * Choices of the open Export menu. They start from the same defaults every time
 * the menu opens: the button never silently repeats an earlier export.
 */
const exportMenuSelection: { format: string; rowScope: ExportRowScope } = {
    format: DEFAULT_EXPORT_FORMAT,
    rowScope: 'loaded',
};

function resetExportMenuSelection(): void {
    exportMenuSelection.format = DEFAULT_EXPORT_FORMAT;
    exportMenuSelection.rowScope = 'loaded';
}

function createExportMenuSection(title: string): HTMLDivElement {
    const section = document.createElement('div');
    section.className = 'export-menu-section';
    const heading = document.createElement('div');
    heading.className = 'export-menu-section__title';
    heading.textContent = title;
    section.appendChild(heading);
    return section;
}

function createExportChip(label: string, title: string, checked: boolean, onSelect: () => void): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'export-chip';
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(checked));
    chip.title = title;
    chip.textContent = label;
    chip.onclick = (event) => {
        event.stopPropagation();
        onSelect();
    };
    return chip;
}

function renderFormatSection(menu: HTMLElement): void {
    const section = createExportMenuSection('Format');
    const group = document.createElement('div');
    group.className = 'export-chip-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Export format');

    const selected = exportMenuSelection.format;
    EXPORT_FORMATS.filter(format => !format.more).forEach(format => {
        group.appendChild(createExportChip(format.label, format.description, format.id === selected, () => {
            exportMenuSelection.format = format.id;
            renderExportMenu();
        }));
    });

    const more = document.createElement('select');
    more.className = 'export-more-formats';
    more.setAttribute('aria-label', 'More export formats');
    const moreFormats = EXPORT_FORMATS.filter(format => format.more);
    const selectedMore = moreFormats.some(format => format.id === selected);
    more.classList.toggle('is-selected', selectedMore);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'More…';
    more.appendChild(placeholder);
    moreFormats.forEach(format => {
        const option = document.createElement('option');
        option.value = format.id;
        option.textContent = format.label;
        option.title = format.description;
        option.selected = format.id === selected;
        more.appendChild(option);
    });
    more.onclick = (event) => event.stopPropagation();
    more.onchange = () => {
        if (more.value) {
            exportMenuSelection.format = more.value;
            renderExportMenu();
        }
    };
    group.appendChild(more);
    section.appendChild(group);

    const description = EXPORT_FORMATS.find(format => format.id === selected)?.description;
    if (description) {
        const hint = document.createElement('div');
        hint.className = 'export-menu-hint';
        hint.textContent = description;
        section.appendChild(hint);
    }
    menu.appendChild(section);
}

function renderRowScopeSection(menu: HTMLElement): void {
    const section = createExportMenuSection('Rows');
    const group = document.createElement('div');
    group.className = 'export-chip-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Rows to export');
    const scopes: Array<{ id: ExportRowScope; label: string; title: string }> = [
        { id: 'loaded', label: 'Loaded rows', title: 'Export only the rows currently loaded in SQL Results.' },
        { id: 'all', label: 'ALL rows', title: 'Re-run SQL without LIMIT, then export all returned rows.' },
    ];
    scopes.forEach(scope => {
        group.appendChild(createExportChip(scope.label, scope.title, exportMenuSelection.rowScope === scope.id, () => {
            exportMenuSelection.rowScope = scope.id;
            renderExportMenu();
        }));
    });
    section.appendChild(group);
    menu.appendChild(section);
}

function createExportActionButton(
    icon: string,
    label: string,
    title: string,
    destination: ExportDestination,
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-action';
    button.setAttribute('role', 'menuitem');
    button.dataset.destination = destination;
    button.title = title;
    button.innerHTML = `<span class="export-action__icon" aria-hidden="true">${icon}</span><span>${label}</span>`;
    button.onclick = (event) => {
        event.stopPropagation();
        submitExportSelection(destination);
    };
    return button;
}

function renderActionSection(menu: HTMLElement): void {
    const actions = document.createElement('div');
    actions.className = 'export-actions';
    actions.appendChild(createExportActionButton('💾', 'Save as…', 'Choose where to save the file', 'file'));
    actions.appendChild(createExportActionButton('↗', 'Export & Open', 'Save to the temp folder and open it in the default application', 'open'));
    actions.appendChild(createExportActionButton('📋', 'Export & Copy file', 'Save to the temp folder and put the file itself on the clipboard (paste it into a mail, chat or folder)', 'temp'));
    if (TEXT_CONTENT_FORMATS.has(exportMenuSelection.format)) {
        actions.appendChild(createExportActionButton('📝', 'Copy content', 'Put the exported text itself on the clipboard (no file)', 'clipboard'));
    }
    menu.appendChild(actions);
}

function createExportFooterItem(label: string, onClick: () => void): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'split-btn__menu-item export-menu-footer-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = 0;
    item.textContent = label;
    const run = () => {
        closeExportPrimaryMenu();
        onClick();
    };
    item.onclick = (event) => {
        event.stopPropagation();
        run();
    };
    item.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            run();
        }
    };
    return item;
}

function renderExportMenu(): void {
    const menu = getElementById('exportPrimaryMenu');
    if (!menu) return;

    menu.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'export-menu-header';
    header.textContent = 'Export active result';
    menu.appendChild(header);

    renderFormatSection(menu);
    if (activeResultHasTrailingLimit()) {
        renderRowScopeSection(menu);
    }
    renderActionSection(menu);

    const separator = document.createElement('div');
    separator.className = 'split-btn__menu-separator';
    menu.appendChild(separator);
    if (getResultSets().filter(resultSet => !resultSet.isLog && !resultSet.isError).length > 1) {
        menu.appendChild(createExportFooterItem('All result sets → Excel workbook…', () => exportAllResultSetsToExcel()));
    }
    menu.appendChild(createExportFooterItem('Copy grid as image (up to 500 rows)', () => callPanelMethod('copyGridAsImage')));
}

function submitExportSelection(destination: ExportDestination): void {
    const exportData = collectCurrentViewExportMetadata();
    closeExportPrimaryMenu();
    if (!exportData) {
        return;
    }

    vscode.postMessage({
        command: 'initiateExportWithSelection',
        data: exportData,
        format: exportMenuSelection.format,
        destination,
        rowScope: activeResultHasTrailingLimit() ? exportMenuSelection.rowScope : 'loaded',
    });
}

export function handleExportPrimaryClick(event?: Event): void {
    toggleExportPrimaryMenu(event);
}

export function toggleExportPrimaryMenu(event?: Event): void {
    event?.stopPropagation?.();

    const menu = getElementById('exportPrimaryMenu');
    if (!menu) {
        return;
    }

    if (menu.style.display === 'block') {
        closeExportPrimaryMenu();
        return;
    }

    if (!collectCurrentViewExportMetadata()) {
        return;
    }

    resetExportMenuSelection();
    renderExportMenu();
    menu.style.display = 'block';

    const exportBtn = document.querySelector('#exportSplitBtn .split-btn__primary');
    if (exportBtn) {
        exportBtn.setAttribute('aria-expanded', 'true');
    }
    menu.querySelector<HTMLElement>('.export-chip[aria-checked="true"]')?.focus();
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

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportJson', data }));
}

export function exportToXml(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportXml', data }));
}

export function exportToSqlInsert(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportSqlInsert', data }));
}

export function exportToMarkdown(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportMarkdown', data }));
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
    // A drag session token guards the deferred reveal below: when the drag ends before the
    // timer runs, the stale callback must not re-add the reveal class.
    let groupDragSession = 0;

    const isGroupDragState = (): boolean => {
        const state = getGlobalDragState();
        return state.isDragging && (state.dragType === 'column' || state.dragType === 'groupChip');
    };

    /** Hides the reveal panel and clears drop highlights without touching the drag payload. */
    const clearGroupDragReveal = (): void => {
        groupDragSession += 1;
        document.body.classList.remove('group-dragging');
        clearGroupDropTargets();
    };

    const endGroupDragSession = (): void => {
        setGlobalDragState({ isDragging: false, dragType: null, draggedItem: null });
        clearGroupDragReveal();
    };

    // Reveal the (otherwise collapsed) grouping panel while a column is being dragged.
    document.addEventListener('dragstart', () => {
        const session = ++groupDragSession;
        // Changing layout synchronously inside dragstart makes Chromium cancel the drag,
        // so reveal the panel on a later tick. Drag state is set by the element's own handler.
        setTimeout(() => {
            if (session !== groupDragSession) return;
            if (isGroupDragState()) {
                document.body.classList.add('group-dragging');
            }
        }, 0);
    });

    // Capture phase so drop handlers that stop propagation (group chips, schema items) cannot
    // skip the cleanup. A drag source that is re-rendered mid-drag never fires dragend, so the
    // drop cleanup must not rely on bubbling either.
    document.addEventListener('dragend', endGroupDragSession, true);
    document.addEventListener('drop', clearGroupDragReveal, true);

    // A missed dragend leaves the body class (and the drag state) behind, which keeps the
    // grouping panel expanded with a stale "drop a column header" hint. Any new press proves
    // the previous drag is over unless a drag source still carries the in-flight marker.
    document.addEventListener('pointerdown', () => {
        if (!getGlobalDragState().isDragging && !document.body.classList.contains('group-dragging')) {
            return;
        }
        if (document.querySelector('.dragging')) {
            return;
        }
        endGroupDragSession();
    }, true);
    window.addEventListener('blur', endGroupDragSession);
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

    const data = {
            sourceUri: getActiveSourceUri(),
            results: [{
                resultSetIndex: getActiveGridIndex(),
                rowIndices: selection.rowIndices,
                columnIds: selection.columnIds,
                name: getResultSetAt(getActiveGridIndex())?.name || `Result ${getActiveGridIndex() + 1}`,
                isActive: true
            }]
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'openInExcel', data: scopedData }));
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

    const data = {
            sourceUri: getActiveSourceUri(),
            resultSetIndex: getActiveGridIndex(),
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            formatting: getCurrentExportFormattingMetadata()
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'exportCsv', data: scopedData }));
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

    const data = {
            sourceUri: getActiveSourceUri(),
            resultSetIndex: getActiveGridIndex(),
            rowIndices: selection.rowIndices,
            columnIds: selection.columnIds,
            formatting: getCurrentExportFormattingMetadata()
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'exportJson', data: scopedData }));
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

    const data = {
            sourceUri: getActiveSourceUri(),
            results: [{
                resultSetIndex: getActiveGridIndex(),
                rowIndices: selection.rowIndices,
                columnIds: selection.columnIds,
                name: getResultSetAt(getActiveGridIndex())?.name || `Result ${getActiveGridIndex() + 1}`,
                isActive: true
            }]
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'openInExcel', data: scopedData }));
}

/**
 * Build a markdown document combining all result sets with their SQL
 * Posts to host for save dialog and file writing
 */
export function exportToParquet(): void {
    const payload = buildFullGridExportPayload();
    if (!payload) return;

    postExportWithScope(payload, data => vscode.postMessage({ command: 'exportParquet', data }));
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

    const data = {
        sourceUri: requireActiveSourceUri(),
        mdDocument,
        resultSetIndices: dataResults.map(resultSet => resultSets.indexOf(resultSet)),
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'exportToMdFile', data: scopedData }));
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

    const data = {
            sourceUri: getActiveSourceUri(),
            results: results
    };
    postExportWithScope(data, scopedData => vscode.postMessage({ command: 'exportAllResultSetsToExcel', data: scopedData }));
}
