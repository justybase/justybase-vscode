/**
 * Esbuild IIFE entry for the Excel-like file preview (XLSX, XLSB, CSV, TSV).
 *
 * This is deliberately separate from the SQL result grid: it renders its own fixed-height
 * virtual table, owns selection and keyboard handling, and copies through the host so that
 * clipboard writes never depend on webview focus.
 */
import {
    buildSearchIndex,
    cellText,
    clampColumnWidth,
    clamp,
    classifyRangeAddress,
    COLUMN_WIDTH,
    columnAt,
    columnStart,
    edgeScrollStep,
    findCells,
    formatStat,
    HEADER_HEIGHT,
    isCellInRange,
    isNumericValue,
    jumpToEdge,
    MAX_STATS_CELLS,
    moveCell,
    normalizeRange,
    overflowColumns,
    parseRangeAddress,
    rangeAddress,
    ROW_HEIGHT,
    ROW_NUMBER_WIDTH,
    rangeToTsv,
    stepMatch,
    tableWidth,
    visibleRowRange,
    MAX_SEARCH_MATCHES,
    selectionStatsForRanges,
    type CellRange,
    type CellRef,
    type SpreadsheetPreviewData,
    type SpreadsheetSheet,
} from './spreadsheetPreview/model.js';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface Elements {
    scroller: HTMLDivElement;
    headRow: HTMLTableRowElement;
    bodyTable: HTMLTableElement;
    spacer: HTMLDivElement;
    inner: HTMLDivElement;
    head: HTMLTableElement;
    searchInput: HTMLInputElement;
    searchCount: HTMLSpanElement;
    tabs: HTMLElement;
    status: HTMLElement;
    tbody: HTMLTableSectionElement;
    nameBox: HTMLInputElement;
    valueBar: HTMLSpanElement;
    contextMenu: HTMLDivElement;
}

const ICON_SEARCH = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.3"></circle><path d="M10.2 10.2 14 14"></path></svg>';
const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7.5" rx="1.2"></rect><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1"></path></svg>';
const ICON_EXPORT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5"></path><path d="M5.2 5.3 8 2.5l2.8 2.8"></path><path d="M2.8 10.5v2.2a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-2.2"></path></svg>';
const ICON_IMPORT = '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.6" rx="4.4" ry="1.7"></ellipse><path d="M3.6 3.6v5.6c0 .9 2 1.7 4.4 1.7s4.4-.8 4.4-1.7V3.6"></path><path d="M8 7.4v6.1"></path><path d="M5.9 11.4 8 13.5l2.1-2.1"></path></svg>';
const ICON_WORKSPACE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.2" height="4.2" rx=".6"></rect><rect x="9.3" y="2.5" width="4.2" height="4.2" rx=".6"></rect><rect x="2.5" y="9.3" width="4.2" height="4.2" rx=".6"></rect><path d="M11.4 9.1v4.6M9.1 11.4h4.6"></path></svg>';
const ICON_UP = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10 8 6l4 4"></path></svg>';
const ICON_DOWN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"></path></svg>';

/** Rows sampled by double-click autofit; the rest of a large sheet rarely changes the width. */
const AUTOFIT_SAMPLE_ROWS = 2000;
/** Horizontal padding (twice 4px plus a little slack) kept inside an autofitted column. */
const AUTOFIT_COLUMN_PADDING = 14;

const vscode = acquireVsCodeApi();
const data = readData();
let sheetIndex = 0;
let anchor: CellRef = { row: 0, col: 0 };
let focusCell: CellRef = { row: 0, col: 0 };
/**
 * Excel-style multi-area selection. `anchor`..`focusCell` is the active area (the one the name box
 * shows); areas created earlier with Ctrl+click/drag are kept here.
 */
let completedAreas: CellRange[] = [];
/** How the active area was selected; header selections use A:A / 1:5 in the name box. */
let areaKind: 'rows' | 'columns' | null = null;
let dragging = false;
let headerDrag: { kind: 'row' | 'col' } | null = null;
let contextCell: CellRef | null = null;
let scrollFrame: number | null = null;

// Whole-sheet search. Each sheet's lowercase index is built once, on first search, and reused.
const searchIndexes = new Map<number, string[]>();
let searchQuery = '';
let searchMatches: CellRef[] = [];
let searchTruncated = false;
let searchMatchKeys = new Set<string>();
let searchMatchIndex = -1;

// Column widths are per sheet and survive switching tabs; they are not persisted across reloads.
const columnWidthsBySheet = new Map<number, number[]>();
let resizing: { col: number; startX: number; startWidth: number } | null = null;
let dragPointer: { x: number; y: number } | null = null;
let dragFrame: number | null = null;

const root = document.getElementById('app');
if (!root) {
    throw new Error('Spreadsheet preview root element is missing.');
}
const els = buildLayout(root);
attachEvents();
refresh();
window.addEventListener('message', event => onHostMessage(event.data));
post({ command: 'ready' });

function readData(): SpreadsheetPreviewData {
    const source = document.getElementById('sheet-data')?.textContent ?? '';
    return JSON.parse(source) as SpreadsheetPreviewData;
}

function currentSheet(): SpreadsheetSheet {
    return data.sheets[sheetIndex];
}

function lastRow(sheet: SpreadsheetSheet): number {
    return Math.max(0, sheet.rows.length - 1);
}

function lastCol(sheet: SpreadsheetSheet): number {
    return Math.max(0, sheet.columns.length - 1);
}

/** The active selection area, which is what the name box shows. */
function activeRange(): CellRange {
    return normalizeRange(anchor, focusCell);
}

/** Every selected area; the active one is always last, as in Excel. */
function allAreas(): CellRange[] {
    return completedAreas.length > 0 ? [...completedAreas, activeRange()] : [activeRange()];
}

/** Keeps the current areas and starts a new active one (Ctrl+click or Ctrl+drag). */
function beginAdditionalArea(): void {
    completedAreas = allAreas();
}

/** Collapses the selection back to the active area. */
function resetAreas(): void {
    completedAreas = [];
}

function post(message: Record<string, unknown>): void {
    vscode.postMessage(message);
}

let searchRefreshTimer: number | null = null;

/** Streaming keeps adding rows; keep an active whole-sheet search in step without scanning per chunk. */
function scheduleSearchRefresh(): void {
    if (searchQuery.trim() === '') {
        return;
    }
    if (searchRefreshTimer !== null) {
        window.clearTimeout(searchRefreshTimer);
    }
    searchRefreshTimer = window.setTimeout(() => {
        searchRefreshTimer = null;
        if (!currentSheet()) {
            return;
        }
        runSearch();
        refresh();
    }, 300);
}

/** Host messages: rows streamed in after the first page, or a streaming error. */
function onHostMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
        return;
    }
    const payload = message as {
        command?: string;
        sheetIndex?: number;
        rows?: unknown[][];
        done?: boolean;
        columnsTruncated?: boolean;
        message?: string;
    };
    if (payload.command === 'sheetAppend') {
        const index = typeof payload.sheetIndex === 'number' ? payload.sheetIndex : -1;
        const sheet = data.sheets[index];
        if (!sheet) {
            return;
        }
        if (Array.isArray(payload.rows)) {
            for (const row of payload.rows) {
                sheet.rows.push(row);
            }
        }
        sheet.shownRows = Math.max(0, sheet.rows.length - 1);
        sheet.loading = payload.done !== true;
        sheet.columnsTruncated = payload.columnsTruncated === true;
        if (index !== sheetIndex) {
            return;
        }
        // The row set changed, so any cached search index for this sheet is stale.
        searchIndexes.delete(index);
        sizeContent(sheet);
        renderBody();
        updateStatus(sheet, allAreas());
        scheduleSearchRefresh();
        return;
    }
    if (payload.command === 'sheetStreamError') {
        els.status.textContent = `Could not read the whole file: ${payload.message ?? 'unknown error'}`;
    }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function actionButton(
    icon: string,
    label: string,
    title: string,
    onClick: () => void,
): HTMLButtonElement {
    const node = el('button', 'action');
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', label);
    const glyph = el('span', 'icon');
    glyph.innerHTML = icon;
    node.append(glyph, el('span', 'action-label', label));
    node.addEventListener('click', onClick);
    return node;
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const node = el('button', 'icon-button');
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon;
    node.addEventListener('click', onClick);
    return node;
}

function menuItem(action: string, label: string, shortcut: string, onSelect: () => void): HTMLButtonElement {
    const item = el('button', 'context-menu-item');
    item.type = 'button';
    item.dataset.action = action;
    item.setAttribute('role', 'menuitem');
    item.appendChild(el('span', 'context-menu-label', label));
    if (shortcut) {
        item.appendChild(el('span', 'context-menu-shortcut', shortcut));
    }
    item.addEventListener('click', () => {
        hideContextMenu();
        onSelect();
        if (action !== 'find') {
            els.scroller.focus();
        }
    });
    return item;
}

function buildLayout(host: HTMLElement): Elements {
    const toolbar = el('div', 'toolbar');
    const workbook = el('div', 'workbook');
    workbook.appendChild(el('span', 'file-title', data.fileName));
    if (data.fileKind) {
        workbook.appendChild(el('span', 'file-badge', data.fileKind));
    }
    workbook.appendChild(el('span', 'file-info', data.fileInfo));
    toolbar.appendChild(workbook);

    const actions = el('div', 'toolbar-actions');
    const search = el('div', 'search');
    const searchIcon = el('span', 'search-icon');
    searchIcon.innerHTML = ICON_SEARCH;
    const searchInput = el('input', 'search-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search sheet';
    searchInput.setAttribute('aria-label', 'Search the whole sheet');
    searchInput.spellcheck = false;
    const searchCount = el('span', 'search-count');
    search.append(
        searchIcon,
        searchInput,
        searchCount,
        iconButton(ICON_UP, 'Previous match (Shift+Enter)', () => stepSearch(-1)),
        iconButton(ICON_DOWN, 'Next match (Enter)', () => stepSearch(1)),
    );
    actions.appendChild(search);
    actions.appendChild(actionButton(ICON_COPY, 'Copy', 'Copy selected cells (Ctrl+C)', copySelection));
    actions.appendChild(actionButton(ICON_EXPORT, 'Export', 'Export this file', () => post({ command: 'handleClickExport' })));
    if (data.canImportToDatabase) {
        actions.appendChild(actionButton(
            ICON_IMPORT,
            'Import to Database',
            'Import the current sheet into a database table',
            () => post({ command: 'importSheetToDatabase', sheetIndex }),
        ));
    }
    if (data.canAddToWorkspace) {
        actions.appendChild(actionButton(
            ICON_WORKSPACE,
            'Add to Data Workspace',
            'Add this file to a new or existing Data Workspace',
            () => post({ command: 'addFileToDataWorkspace' }),
        ));
    }
    toolbar.appendChild(actions);

    const formulaBar = el('div', 'formula-bar');
    const nameBox = el('input', 'name-box');
    nameBox.type = 'text';
    nameBox.spellcheck = false;
    nameBox.autocomplete = 'off';
    nameBox.setAttribute('aria-label', 'Cell or range reference');
    formulaBar.append(nameBox, el('span', 'fx', 'fx'));
    const valueBar = el('span', 'value-bar');
    valueBar.setAttribute('aria-label', 'Cell value');
    formulaBar.appendChild(valueBar);

    const scroller = el('div', 'scroller');
    scroller.tabIndex = 0;
    const inner = el('div', 'sheet-inner');

    const head = el('table', 'head-table');
    head.appendChild(columnGroup());
    const headRow = document.createElement('tr');
    const headBody = document.createElement('thead');
    headBody.appendChild(headRow);
    head.appendChild(headBody);
    const headWrap = el('div', 'head-wrap');
    headWrap.appendChild(head);

    const spacer = el('div', 'body-spacer');
    const bodyTable = el('table', 'body-table');
    bodyTable.appendChild(columnGroup());
    const tbody = document.createElement('tbody');
    bodyTable.appendChild(tbody);
    spacer.appendChild(bodyTable);

    inner.append(headWrap, spacer);
    scroller.appendChild(inner);

    const tabs = el('nav', 'sheet-tabs');
    tabs.setAttribute('role', 'tablist');
    const status = el('div', 'sheet-status');
    const bottomBar = el('div', 'bottom-bar');
    bottomBar.append(tabs, status);

    const contextMenu = el('div', 'context-menu');
    contextMenu.hidden = true;
    contextMenu.setAttribute('role', 'menu');
    contextMenu.setAttribute('aria-label', 'Cell actions');
    contextMenu.append(
        menuItem('copy', 'Copy', 'Ctrl+C', copySelection),
        menuItem('copy-cell', 'Copy cell value', '', copyContextCell),
        menuItem('select-all', 'Select all', 'Ctrl+A', () => {
            const sheet = currentSheet();
            if (sheet) {
                selectAll(sheet);
            }
        }),
        menuItem('find', 'Find…', 'Ctrl+F', () => {
            els.searchInput.focus();
            els.searchInput.select();
        }),
    );
    document.body.appendChild(contextMenu);

    host.replaceChildren(toolbar, formulaBar, scroller, bottomBar);
    return {
        scroller, headRow, bodyTable, spacer, inner, head, nameBox, valueBar,
        searchInput, searchCount, tabs, status, tbody, contextMenu,
    };
}

function widthsFor(index: number): number[] {
    let widths = columnWidthsBySheet.get(index);
    if (!widths) {
        widths = data.sheets[index].columns.map(() => COLUMN_WIDTH);
        columnWidthsBySheet.set(index, widths);
    }
    return widths;
}

function columnGroup(): HTMLTableColElement {
    const group = document.createElement('colgroup');
    // A colgroup is an HTMLTableColElement in the DOM typings, the same as a col.
    const rowNumber = document.createElement('col');
    rowNumber.style.width = `${ROW_NUMBER_WIDTH}px`;
    group.appendChild(rowNumber);
    for (const width of widthsFor(sheetIndex)) {
        const col = document.createElement('col');
        col.style.width = `${width}px`;
        group.appendChild(col);
    }
    return group;
}

/** Pushes the current widths into both tables without rebuilding any rows, so a drag stays cheap. */
function applyColumnWidths(sheet: SpreadsheetSheet): void {
    const widths = widthsFor(sheetIndex);
    for (const table of [els.head, els.bodyTable]) {
        table.querySelectorAll('col').forEach((col, index) => {
            col.style.width = `${index === 0 ? ROW_NUMBER_WIDTH : widths[index - 1]}px`;
        });
    }
    sizeContent(sheet);
    // Overflow spans are measured in pixels, so they have to follow the new widths.
    renderBody();
}

/** Sheets can differ in column count, so the colgroups are rebuilt when the active sheet changes. */
function rebuildColumnGroups(): void {
    for (const table of [els.head, els.bodyTable]) {
        const group = table.querySelector('colgroup');
        if (group) {
            table.replaceChild(columnGroup(), group);
        }
    }
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Shared canvas used only to measure text for autofit; measuring through the DOM would force layout. */
function textMeasureContext(): CanvasRenderingContext2D | null {
    if (measureContext === undefined) {
        measureContext = document.createElement('canvas').getContext('2d');
    }
    return measureContext;
}

/** Excel's double-click autofit: widen the column to its widest sampled value, within the resize limits. */
function autofitColumn(col: number): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const context = textMeasureContext();
    if (!context) {
        return;
    }
    const style = getComputedStyle(els.bodyTable);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    const rows = Math.min(sheet.rows.length, AUTOFIT_SAMPLE_ROWS);
    let widest = 0;
    for (let row = 0; row < rows; row++) {
        const text = cellText(sheet.rows[row]?.[col]);
        if (text !== '') {
            widest = Math.max(widest, context.measureText(text).width);
        }
    }
    widthsFor(sheetIndex)[col] = clampColumnWidth(Math.ceil(widest) + AUTOFIT_COLUMN_PADDING);
    applyColumnWidths(sheet);
}

function startColumnResize(event: MouseEvent, col: number): void {
    resizing = { col, startX: event.clientX, startWidth: widthsFor(sheetIndex)[col] };
    document.body.classList.add('resizing-columns');
}

function onColumnResizeMove(event: MouseEvent): void {
    if (!resizing) {
        return;
    }
    widthsFor(sheetIndex)[resizing.col] = clampColumnWidth(resizing.startWidth + event.clientX - resizing.startX);
    applyColumnWidths(currentSheet());
}

function endColumnResize(): void {
    if (!resizing) {
        return;
    }
    resizing = null;
    document.body.classList.remove('resizing-columns');
}

/** Double-clicking the resize handle autofits the column, as in Excel; Alt+double-click restores the default. */
function onHeaderDoubleClick(event: MouseEvent): void {
    const handle = event.target as HTMLElement;
    if (!handle.classList.contains('col-resize')) {
        return;
    }
    const col = Number(handle.parentElement?.dataset.col);
    if (!Number.isInteger(col)) {
        return;
    }
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    if (event.altKey) {
        widthsFor(sheetIndex)[col] = COLUMN_WIDTH;
        applyColumnWidths(sheet);
        return;
    }
    autofitColumn(col);
}

function attachEvents(): void {
    els.scroller.addEventListener('scroll', () => {
        hideContextMenu();
        if (scrollFrame !== null) {
            return;
        }
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = null;
            renderBody();
        });
    });
    els.scroller.addEventListener('keydown', onKeyDown);
    els.scroller.addEventListener('contextmenu', onContextMenu);
    els.searchInput.addEventListener('input', onSearchInput);
    els.searchInput.addEventListener('keydown', onSearchKeyDown);
    els.nameBox.addEventListener('focus', () => els.nameBox.select());
    els.nameBox.addEventListener('blur', () => {
        els.nameBox.value = currentSelectionAddress();
        els.nameBox.classList.remove('invalid');
    });
    els.nameBox.addEventListener('keydown', onNameBoxKeyDown);
    els.contextMenu.addEventListener('keydown', onContextMenuKeyDown);
    document.addEventListener('mousedown', event => {
        if (!els.contextMenu.hidden && !els.contextMenu.contains(event.target as Node)) {
            hideContextMenu();
        }
    });
    window.addEventListener('blur', hideContextMenu);
    els.headRow.parentElement?.addEventListener('mousedown', onHeaderMouseDown);
    els.head.addEventListener('dblclick', onHeaderDoubleClick);
    els.bodyTable.addEventListener('mousedown', onBodyMouseDown);
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', () => {
        stopDragSelection();
        endColumnResize();
    });
    // The viewport has no height until layout runs, so re-render the visible rows when it changes.
    new ResizeObserver(() => {
        hideContextMenu();
        renderBody();
    }).observe(els.scroller);
}

function refresh(): void {
    const sheet = currentSheet();
    if (!sheet) {
        els.status.textContent = 'No data to show.';
        return;
    }
    const range = activeRange();
    const areas = allAreas();
    renderTabs();
    sizeContent(sheet);
    renderHeader(sheet, areas);
    renderBody();
    updateFormulaBar(sheet, range);
    updateStatus(sheet, areas);
    updateSearchCount();
}

function sizeContent(sheet: SpreadsheetSheet): void {
    const width = tableWidth(widthsFor(sheetIndex));
    els.inner.style.width = `${width}px`;
    els.head.style.width = `${width}px`;
    els.bodyTable.style.width = `${width}px`;
    els.spacer.style.height = `${sheet.rows.length * ROW_HEIGHT}px`;
    els.spacer.style.width = `${width}px`;
}

function renderHeader(sheet: SpreadsheetSheet, areas: CellRange[]): void {
    const cells: HTMLElement[] = [];
    const corner = el('th', 'corner');
    corner.dataset.corner = 'true';
    corner.title = 'Select all cells';
    cells.push(corner);
    sheet.columns.forEach((label, col) => {
        const inCols = areas.some(area => col >= area.startCol && col <= area.endCol);
        const classes = ['colhdr'];
        if (inCols) {
            classes.push('sel');
        }
        if (col === anchor.col) {
            classes.push('active');
        }
        const th = el('th', classes.join(' '), label);
        th.dataset.col = String(col);
        th.appendChild(el('span', 'col-resize'));
        cells.push(th);
    });
    els.headRow.replaceChildren(...cells);
}

function renderBody(): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const areas = allAreas();
    const { scroller } = els;
    // Sticky headers get a shadow only while the grid is scrolled, as in Excel.
    scroller.classList.toggle('scrolled', scroller.scrollTop > 0);
    scroller.classList.toggle('scrolled-x', scroller.scrollLeft > 0);
    const viewportTop = Math.max(0, scroller.scrollTop - HEADER_HEIGHT);
    const { start, end } = visibleRowRange(viewportTop, scroller.clientHeight, sheet.rows.length);

    const tbody = document.createElement('tbody');
    for (let row = start; row < end; row++) {
        tbody.appendChild(buildRow(sheet, row, areas));
    }
    els.tbody.replaceWith(tbody);
    els.tbody = tbody;
    els.bodyTable.style.top = `${start * ROW_HEIGHT}px`;
}

function buildRow(sheet: SpreadsheetSheet, row: number, areas: CellRange[]): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const inRows = areas.some(area => row >= area.startRow && row <= area.endRow);
    const rowClasses = ['rowhdr'];
    if (inRows) {
        rowClasses.push('sel');
    }
    if (row === anchor.row) {
        rowClasses.push('active');
    }
    const rowHeader = el('th', rowClasses.join(' '), String(row + 1));
    rowHeader.dataset.row = String(row);
    tr.appendChild(rowHeader);

    const source = sheet.rows[row] ?? [];
    const widths = widthsFor(sheetIndex);
    const currentMatch = searchMatchIndex >= 0 ? searchMatches[searchMatchIndex] : null;
    sheet.columns.forEach((_label, col) => {
        const value = source[col];
        const edge = { top: false, bottom: false, left: false, right: false };
        const inRange = areas.some(area => {
            if (!isCellInRange(area, row, col)) {
                return false;
            }
            edge.top ||= row === area.startRow;
            edge.bottom ||= row === area.endRow;
            edge.left ||= col === area.startCol;
            edge.right ||= col === area.endCol;
            return true;
        });
        const classes = ['cell'];
        if (isNumericValue(value)) {
            classes.push('num');
        }
        if (inRange) {
            classes.push('sel');
            if (edge.top) {
                classes.push('sel-top');
            }
            if (edge.bottom) {
                classes.push('sel-bottom');
            }
            if (edge.left) {
                classes.push('sel-left');
            }
            if (edge.right) {
                classes.push('sel-right');
            }
        }
        if (searchMatchKeys.has(cellKey(row, col))) {
            classes.push('hit');
        }
        if (currentMatch !== null && currentMatch.row === row && currentMatch.col === col) {
            classes.push('hit-current');
        }
        if (anchor.row === row && anchor.col === col) {
            classes.push('active');
        }
        let td: HTMLTableCellElement;
        const overflow = overflowColumns(sheet, row, col);
        if (overflow > 0) {
            classes.push('ovf');
            td = el('td', classes.join(' '));
            // The text may paint over the empty cells, up to the last one it is allowed to cover.
            let spanWidth = 0;
            for (let index = col; index <= col + overflow; index++) {
                spanWidth += widths[index] ?? COLUMN_WIDTH;
            }
            const text = el('span', 'cell-overflow', cellText(value));
            text.style.maxWidth = `${Math.max(0, spanWidth - 9)}px`;
            td.appendChild(text);
        } else {
            td = el('td', classes.join(' '), cellText(value));
        }
        td.dataset.row = String(row);
        td.dataset.col = String(col);
        tr.appendChild(td);
    });
    return tr;
}

function renderTabs(): void {
    const tabs = data.sheets.map((sheet, index) => {
        const tab = el('button', index === sheetIndex ? 'sheet-tab active' : 'sheet-tab', sheet.name);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(index === sheetIndex));
        tab.addEventListener('click', () => selectSheet(index));
        return tab;
    });
    els.tabs.replaceChildren(...tabs);
}

function selectSheet(index: number): void {
    if (index === sheetIndex || !data.sheets[index]) {
        return;
    }
    sheetIndex = index;
    resetAreas();
    areaKind = null;
    anchor = { row: 0, col: 0 };
    focusCell = { row: 0, col: 0 };
    els.scroller.scrollTop = 0;
    els.scroller.scrollLeft = 0;
    rebuildColumnGroups();
    runSearch();
    refresh();
}

function cellKey(row: number, col: number): string {
    return `${row}:${col}`;
}

function indexForCurrentSheet(): string[] {
    let index = searchIndexes.get(sheetIndex);
    if (!index) {
        index = buildSearchIndex(currentSheet());
        searchIndexes.set(sheetIndex, index);
    }
    return index;
}

/** Recomputes matches for the current query on the current sheet. Does not move the selection. */
function runSearch(): void {
    const result = findCells(currentSheet(), indexForCurrentSheet(), searchQuery);
    searchMatches = result.cells;
    searchTruncated = result.truncated;
    searchMatchKeys = new Set(result.cells.map(ref => cellKey(ref.row, ref.col)));
    searchMatchIndex = -1;
}

function stepSearch(step: 1 | -1): void {
    if (searchMatches.length === 0) {
        return;
    }
    searchMatchIndex = stepMatch(searchMatchIndex, searchMatches.length, step);
    const ref = searchMatches[searchMatchIndex];
    resetAreas();
    areaKind = null;
    anchor = ref;
    focusCell = ref;
    keepVisible(ref);
    refresh();
}

function onSearchInput(): void {
    searchQuery = els.searchInput.value;
    runSearch();
    if (searchMatches.length > 0) {
        // Like Excel's find, typing selects the first match so it can be scrolled to at once.
        stepSearch(1);
    } else {
        refresh();
    }
}

function onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
        event.preventDefault();
        stepSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        els.searchInput.value = '';
        searchQuery = '';
        runSearch();
        refresh();
        els.scroller.focus();
    }
}

function updateSearchCount(): void {
    if (searchQuery.trim() === '') {
        els.searchCount.textContent = '';
        return;
    }
    if (searchMatches.length === 0) {
        els.searchCount.textContent = 'No results';
        return;
    }
    const total = `${searchMatches.length.toLocaleString()}${searchTruncated ? '+' : ''}`;
    els.searchCount.textContent = searchMatchIndex >= 0
        ? `${(searchMatchIndex + 1).toLocaleString()} of ${total}`
        : `${total} matches`;
    els.searchCount.title = searchTruncated
        ? `Showing the first ${MAX_SEARCH_MATCHES.toLocaleString()} matches`
        : '';
}

function updateFormulaBar(sheet: SpreadsheetSheet, range: CellRange): void {
    const address = rangeAddress(range, areaKind);
    // While the user is typing in the name box, keep their text; selection changes still update it.
    if (document.activeElement !== els.nameBox) {
        els.nameBox.value = address;
    }
    els.nameBox.title = address;
    const value = cellText(sheet.rows[anchor.row]?.[anchor.col]);
    els.valueBar.textContent = value;
    els.valueBar.title = value;
}

/** Address of the current selection, used to restore the name box after editing. */
function currentSelectionAddress(): string {
    return currentSheet() ? rangeAddress(normalizeRange(anchor, focusCell), areaKind) : '';
}

/** Enter in the name box selects the typed cell or range, as Excel does. */
function commitNameBox(): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const range = parseRangeAddress(sheet, els.nameBox.value);
    if (!range) {
        els.nameBox.classList.add('invalid');
        window.setTimeout(() => els.nameBox.classList.remove('invalid'), 900);
        els.nameBox.value = currentSelectionAddress();
        return;
    }
    areaKind = classifyRangeAddress(els.nameBox.value);
    anchor = { row: range.startRow, col: range.startCol };
    focusCell = { row: range.endRow, col: range.endCol };
    resetAreas();
    keepVisible(anchor);
    refresh();
    els.scroller.focus();
}

function onNameBoxKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
        event.preventDefault();
        commitNameBox();
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        els.nameBox.value = currentSelectionAddress();
        els.nameBox.classList.remove('invalid');
        els.scroller.focus();
    }
}

/** Status bar text: sheet size plus Excel-style statistics for the current selection. */
function updateStatus(sheet: SpreadsheetSheet, areas: CellRange[]): void {
    const parts = [`${sheet.rows.length.toLocaleString()} rows`, `${sheet.columns.length} columns`];
    const stats = selectionStatsForRanges(sheet, areas);
    if (stats.numericCount > 0) {
        parts.push(`Count: ${stats.count.toLocaleString()}`);
        parts.push(`Sum: ${formatStat(stats.sum)}`);
        parts.push(`Average: ${formatStat(stats.average ?? 0)}`);
    } else if (stats.count > 0) {
        parts.push(`Count: ${stats.count.toLocaleString()}`);
    }
    if (stats.truncated) {
        parts.push(`first ${MAX_STATS_CELLS.toLocaleString()} cells`);
    }
    if (sheet.loading) {
        const shown = sheet.shownRows ?? Math.max(0, sheet.rows.length - 1);
        parts.push(`loading… ${shown.toLocaleString()} rows`);
    }
    if (sheet.columnsTruncated) {
        parts.push(`first ${sheet.columns.length.toLocaleString()} columns shown (justybase.filePreview.maxColumns)`);
    }
    els.status.textContent = parts.join(' · ');
}

function copySelection(): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const areas = allAreas();
    // Excel copies multiple areas one after another, separated by a blank line.
    post({ command: 'copyToClipboard', text: areas.map(area => rangeToTsv(sheet, area)).join('\n') });
    const cellCount = areas.reduce(
        (total, area) => total + (area.endRow - area.startRow + 1) * (area.endCol - area.startCol + 1),
        0,
    );
    els.status.textContent = `Copied ${cellCount.toLocaleString()} cell(s) to clipboard`;
}

function copyContextCell(): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const ref = contextCell ?? anchor;
    post({ command: 'copyToClipboard', text: cellText(sheet.rows[ref.row]?.[ref.col]) });
    els.status.textContent = 'Copied cell value to clipboard';
}

function hideContextMenu(): void {
    if (!els.contextMenu.hidden) {
        els.contextMenu.hidden = true;
    }
}

function showContextMenu(x: number, y: number): void {
    els.contextMenu.hidden = false;
    const bounds = els.contextMenu.getBoundingClientRect();
    els.contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - bounds.width - 4))}px`;
    els.contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - bounds.height - 4))}px`;
    els.contextMenu.querySelector<HTMLButtonElement>('button')?.focus();
}

/**
 * Our own menu replaces the webview's native Cut/Copy/Paste menu: the native one copies the DOM
 * text selection, which is empty for a CSS-selected grid, so it appeared to copy nothing.
 */
function onContextMenu(event: MouseEvent): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    event.preventDefault();
    contextCell = null;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (target) {
        const row = Number(target.dataset.row);
        if (target.dataset.col === undefined) {
            const fullRowSelected = allAreas().some(area =>
                row >= area.startRow && row <= area.endRow
                && area.startCol === 0 && area.endCol === lastCol(sheet));
            if (!fullRowSelected) {
                resetAreas();
                areaKind = 'rows';
                anchor = { row, col: 0 };
                focusCell = { row, col: lastCol(sheet) };
                refresh();
            }
        } else {
            const col = Number(target.dataset.col);
            contextCell = { row, col };
            if (!allAreas().some(area => isCellInRange(area, row, col))) {
                resetAreas();
                areaKind = null;
                anchor = { row, col };
                focusCell = { row, col };
                refresh();
            }
        }
    }
    showContextMenu(event.clientX, event.clientY);
}

function onContextMenuKeyDown(event: KeyboardEvent): void {
    const items = Array.from(els.contextMenu.querySelectorAll<HTMLButtonElement>('button'));
    if (items.length === 0) {
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        hideContextMenu();
        copySelection();
        els.scroller.focus();
        return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
        event.preventDefault();
        hideContextMenu();
        els.scroller.focus();
        return;
    }
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[current < 0 ? 0 : (current + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length]?.focus();
    }
}

function selectAll(sheet: SpreadsheetSheet): void {
    resetAreas();
    areaKind = null;
    anchor = { row: 0, col: 0 };
    focusCell = { row: lastRow(sheet), col: lastCol(sheet) };
    refresh();
}

function onHeaderMouseDown(event: MouseEvent): void {
    const sheet = currentSheet();
    const target = (event.target as HTMLElement).closest<HTMLElement>('th');
    if (!sheet || !target || event.button !== 0) {
        return;
    }
    event.preventDefault();
    if ((event.target as HTMLElement).classList.contains('col-resize')) {
        startColumnResize(event, Number(target.dataset.col));
        return;
    }
    els.scroller.focus();
    if (target.dataset.corner === 'true') {
        selectAll(sheet);
        return;
    }
    const col = Number(target.dataset.col);
    if (!Number.isInteger(col)) {
        return;
    }

    if (event.shiftKey) {
        // Shift+click extends the current column block from the active column.
        anchor = { row: 0, col: anchor.col };
        focusCell = { row: lastRow(sheet), col };
    } else {
        if (event.ctrlKey || event.metaKey) {
            beginAdditionalArea();
        } else {
            resetAreas();
        }
        anchor = { row: 0, col };
        focusCell = { row: lastRow(sheet), col };
    }
    headerDrag = { kind: 'col' };
    areaKind = 'columns';
    dragging = false;
    refresh();
}

function onBodyMouseDown(event: MouseEvent): void {
    const sheet = currentSheet();
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!sheet || !target || event.button !== 0) {
        return;
    }
    event.preventDefault();
    els.scroller.focus();
    const row = Number(target.dataset.row);
    const ctrl = event.ctrlKey || event.metaKey;

    if (target.dataset.col === undefined) {
        // Row header: select the whole row, or extend/add rows while dragging down the header.
        if (event.shiftKey) {
            anchor = { row: anchor.row, col: 0 };
            focusCell = { row, col: lastCol(sheet) };
        } else {
            if (ctrl) {
                beginAdditionalArea();
            } else {
                resetAreas();
            }
            anchor = { row, col: 0 };
            focusCell = { row, col: lastCol(sheet) };
        }
        headerDrag = { kind: 'row' };
        areaKind = 'rows';
        dragging = false;
        refresh();
        return;
    }

    const col = Number(target.dataset.col);
    areaKind = null;
    if (event.shiftKey) {
        focusCell = { row, col };
    } else if (ctrl) {
        // Ctrl+click/drag adds a new area instead of replacing the current selection.
        beginAdditionalArea();
        anchor = { row, col };
        focusCell = { row, col };
    } else {
        resetAreas();
        anchor = { row, col };
        focusCell = { row, col };
    }
    headerDrag = null;
    dragging = true;
    refresh();
}

function onDocumentMouseMove(event: MouseEvent): void {
    onColumnResizeMove(event);
    if (!dragging && !headerDrag) {
        return;
    }
    // No button left pressed means the mouseup went elsewhere (for example over another panel): stop, don't extend.
    if (event.buttons === 0) {
        stopDragSelection();
        return;
    }
    dragPointer = { x: event.clientX, y: event.clientY };
    if (headerDrag) {
        extendHeaderDrag();
    } else {
        extendDragSelection();
    }
    startDragScroll();
}

/** Moves the moving end of the selection to the cell under the pointer, clamped to the visible body. */
function extendDragSelection(): void {
    const sheet = currentSheet();
    if (!sheet || !dragPointer) {
        return;
    }
    const { scroller } = els;
    const box = scroller.getBoundingClientRect();
    const y = clamp(dragPointer.y, box.top + HEADER_HEIGHT, box.top + scroller.clientHeight - 1);
    const x = clamp(dragPointer.x, box.left + ROW_NUMBER_WIDTH, box.left + scroller.clientWidth - 1);
    const row = clamp(Math.floor((y - box.top - HEADER_HEIGHT + scroller.scrollTop) / ROW_HEIGHT), 0, lastRow(sheet));
    const col = columnAt(widthsFor(sheetIndex), x - box.left - ROW_NUMBER_WIDTH + scroller.scrollLeft);
    if (row === focusCell.row && col === focusCell.col) {
        return;
    }
    focusCell = { row, col };
    refresh();
}

/** Dragging along row or column headers selects the whole rows or columns under the pointer. */
function extendHeaderDrag(): void {
    const sheet = currentSheet();
    if (!sheet || !headerDrag || !dragPointer) {
        return;
    }
    const { scroller } = els;
    const box = scroller.getBoundingClientRect();
    if (headerDrag.kind === 'row') {
        const y = clamp(dragPointer.y, box.top + HEADER_HEIGHT, box.top + scroller.clientHeight - 1);
        const row = clamp(Math.floor((y - box.top - HEADER_HEIGHT + scroller.scrollTop) / ROW_HEIGHT), 0, lastRow(sheet));
        if (row === focusCell.row) {
            return;
        }
        focusCell = { row, col: lastCol(sheet) };
    } else {
        const x = clamp(dragPointer.x, box.left + ROW_NUMBER_WIDTH, box.left + scroller.clientWidth - 1);
        const col = columnAt(widthsFor(sheetIndex), x - box.left - ROW_NUMBER_WIDTH + scroller.scrollLeft);
        if (col === focusCell.col) {
            return;
        }
        focusCell = { row: lastRow(sheet), col };
    }
    refresh();
}

/** While the pointer rests at a visible edge, keep scrolling and extending the selection each frame. */
function startDragScroll(): void {
    if (dragFrame === null) {
        dragFrame = requestAnimationFrame(dragScrollFrame);
    }
}

function dragScrollFrame(): void {
    dragFrame = null;
    if ((!dragging && !headerDrag) || !dragPointer) {
        return;
    }
    const { scroller } = els;
    const box = scroller.getBoundingClientRect();
    const vertical = dragging || headerDrag?.kind === 'row';
    const horizontal = dragging || headerDrag?.kind === 'col';
    const dy = vertical
        ? edgeScrollStep(dragPointer.y, box.top + HEADER_HEIGHT, box.top + scroller.clientHeight)
        : 0;
    const dx = horizontal
        ? edgeScrollStep(dragPointer.x, box.left + ROW_NUMBER_WIDTH, box.left + scroller.clientWidth)
        : 0;
    if (dy === 0 && dx === 0) {
        return;
    }
    scroller.scrollTop += dy;
    scroller.scrollLeft += dx;
    if (headerDrag) {
        extendHeaderDrag();
    } else {
        extendDragSelection();
    }
    dragFrame = requestAnimationFrame(dragScrollFrame);
}

function stopDragSelection(): void {
    dragging = false;
    headerDrag = null;
    dragPointer = null;
    if (dragFrame !== null) {
        cancelAnimationFrame(dragFrame);
        dragFrame = null;
    }
}

function onKeyDown(event: KeyboardEvent): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === 'c') {
        event.preventDefault();
        copySelection();
        return;
    }
    if (modifier && key === 'a') {
        event.preventDefault();
        selectAll(sheet);
        return;
    }
    if (modifier && key === 'f') {
        event.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
        return;
    }
    if (modifier && key === 'home') {
        event.preventDefault();
        resetAreas();
        areaKind = null;
        anchor = { row: 0, col: 0 };
        focusCell = { row: 0, col: 0 };
        els.scroller.scrollTop = 0;
        els.scroller.scrollLeft = 0;
        refresh();
        return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        resetAreas();
        areaKind = null;
        // Excel moves down on Enter and right on Tab; Shift reverses the direction.
        const direction = event.key === 'Enter'
            ? (event.shiftKey ? 'ArrowUp' : 'ArrowDown')
            : (event.shiftKey ? 'ArrowLeft' : 'ArrowRight');
        const moved = moveCell(sheet, anchor, direction);
        anchor = moved;
        focusCell = moved;
        keepVisible(focusCell);
        refresh();
        return;
    }
    if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        resetAreas();
        areaKind = null;
        // Like Excel: Shift extends from the moving end, a plain arrow moves from the active (anchor) cell.
        const from = event.shiftKey ? focusCell : anchor;
        const moved = modifier ? jumpToEdge(sheet, from, event.key) : moveCell(sheet, from, event.key);
        if (event.shiftKey) {
            focusCell = moved;
        } else {
            anchor = moved;
            focusCell = moved;
        }
        keepVisible(focusCell);
        refresh();
    }
}

/** Scrolls the grid just enough that the cell is fully visible (sticky headers are accounted for). */
function keepVisible(ref: CellRef): void {
    const { scroller } = els;
    const top = HEADER_HEIGHT + ref.row * ROW_HEIGHT;
    if (top < scroller.scrollTop + HEADER_HEIGHT) {
        scroller.scrollTop = top - HEADER_HEIGHT;
    } else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    }
    const widths = widthsFor(sheetIndex);
    const left = columnStart(widths, ref.col);
    const right = left + widths[ref.col];
    if (left < scroller.scrollLeft + ROW_NUMBER_WIDTH) {
        scroller.scrollLeft = left - ROW_NUMBER_WIDTH;
    } else if (right > scroller.scrollLeft + scroller.clientWidth) {
        scroller.scrollLeft = right - scroller.clientWidth;
    }
}
