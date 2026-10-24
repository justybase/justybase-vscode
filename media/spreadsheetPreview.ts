/**
 * Esbuild IIFE entry for the Excel-like file preview (XLSX, XLSB, CSV, TSV).
 *
 * This is deliberately separate from the SQL result grid: it renders its own fixed-height
 * virtual table, owns selection and keyboard handling, and copies through the host so that
 * clipboard writes never depend on webview focus.
 */
import {
    addressOf,
    buildSearchIndex,
    cellText,
    clampColumnWidth,
    clamp,
    COLUMN_WIDTH,
    columnAt,
    columnStart,
    edgeScrollStep,
    findCells,
    HEADER_HEIGHT,
    isCellInRange,
    isNumericValue,
    jumpToEdge,
    moveCell,
    normalizeRange,
    ROW_HEIGHT,
    ROW_NUMBER_WIDTH,
    rangeToTsv,
    stepMatch,
    tableWidth,
    visibleRowRange,
    MAX_SEARCH_MATCHES,
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
    nameBox: HTMLSpanElement;
    valueBar: HTMLSpanElement;
    searchInput: HTMLInputElement;
    searchCount: HTMLSpanElement;
    tabs: HTMLElement;
    footer: HTMLElement;
    tbody: HTMLTableSectionElement;
}

const vscode = acquireVsCodeApi();
const data = readData();
let sheetIndex = 0;
let anchor: CellRef = { row: 0, col: 0 };
let focusCell: CellRef = { row: 0, col: 0 };
let dragging = false;
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

function post(message: Record<string, unknown>): void {
    vscode.postMessage(message);
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

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const node = el('button', undefined, label);
    node.type = 'button';
    node.title = title;
    node.addEventListener('click', onClick);
    return node;
}

function buildLayout(host: HTMLElement): Elements {
    const toolbar = el('div', 'toolbar');
    toolbar.appendChild(el('span', 'file-title', data.fileName));
    toolbar.appendChild(el('span', 'file-info', data.fileInfo));
    const search = el('div', 'search');
    const searchInput = el('input', 'search-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search sheet';
    searchInput.setAttribute('aria-label', 'Search the whole sheet');
    searchInput.spellcheck = false;
    const searchCount = el('span', 'search-count');
    search.append(
        searchInput,
        searchCount,
        button('↑', 'Previous match (Shift+Enter)', () => stepSearch(-1)),
        button('↓', 'Next match (Enter)', () => stepSearch(1)),
    );
    toolbar.appendChild(search);
    toolbar.appendChild(button('Copy', 'Copy selected cells (Ctrl+C)', copySelection));
    toolbar.appendChild(button('Export', 'Export this file', () => post({ command: 'handleClickExport' })));
    if (data.canAddToWorkspace) {
        toolbar.appendChild(button('Add to Data Workspace', 'Add this file to a new or existing Data Workspace',
            () => post({ command: 'addFileToDataWorkspace' })));
    }

    const formulaBar = el('div', 'formula-bar');
    const nameBox = el('span', 'name-box');
    formulaBar.append(nameBox, el('span', 'fx', 'fx'));
    const valueBar = el('span', 'value-bar');
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
    const footer = el('div', 'footer');

    host.replaceChildren(toolbar, formulaBar, scroller, tabs, footer);
    return { scroller, headRow, bodyTable, spacer, inner, head, nameBox, valueBar, searchInput, searchCount, tabs, footer, tbody };
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

/** Double-clicking the resize handle restores the default width, as in Excel. */
function onHeaderDoubleClick(event: MouseEvent): void {
    const handle = event.target as HTMLElement;
    if (!handle.classList.contains('col-resize')) {
        return;
    }
    const col = Number(handle.parentElement?.dataset.col);
    if (!Number.isInteger(col)) {
        return;
    }
    widthsFor(sheetIndex)[col] = COLUMN_WIDTH;
    applyColumnWidths(currentSheet());
}

function attachEvents(): void {
    els.scroller.addEventListener('scroll', () => {
        if (scrollFrame !== null) {
            return;
        }
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = null;
            renderBody();
        });
    });
    els.scroller.addEventListener('keydown', onKeyDown);
    els.searchInput.addEventListener('input', onSearchInput);
    els.searchInput.addEventListener('keydown', onSearchKeyDown);
    els.headRow.parentElement?.addEventListener('mousedown', onHeaderMouseDown);
    els.head.addEventListener('dblclick', onHeaderDoubleClick);
    els.bodyTable.addEventListener('mousedown', onBodyMouseDown);
    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', () => {
        stopDragSelection();
        endColumnResize();
    });
    // The viewport has no height until layout runs, so re-render the visible rows when it changes.
    new ResizeObserver(() => renderBody()).observe(els.scroller);
}

function refresh(): void {
    const sheet = currentSheet();
    if (!sheet) {
        els.footer.textContent = 'No data to show.';
        return;
    }
    const range = normalizeRange(anchor, focusCell);
    renderTabs();
    sizeContent(sheet);
    renderHeader(sheet, range);
    renderBody();
    updateFormulaBar(sheet);
    updateFooter(sheet, range);
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

function renderHeader(sheet: SpreadsheetSheet, range: CellRange): void {
    const cells: HTMLElement[] = [];
    const corner = el('th', 'corner');
    corner.dataset.corner = 'true';
    cells.push(corner);
    sheet.columns.forEach((label, col) => {
        const inCols = col >= range.startCol && col <= range.endCol;
        const th = el('th', inCols ? 'colhdr sel' : 'colhdr', label);
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
    const range = normalizeRange(anchor, focusCell);
    const { scroller } = els;
    const viewportTop = Math.max(0, scroller.scrollTop - HEADER_HEIGHT);
    const { start, end } = visibleRowRange(viewportTop, scroller.clientHeight, sheet.rows.length);

    const tbody = document.createElement('tbody');
    for (let row = start; row < end; row++) {
        tbody.appendChild(buildRow(sheet, row, range));
    }
    els.tbody.replaceWith(tbody);
    els.tbody = tbody;
    els.bodyTable.style.top = `${start * ROW_HEIGHT}px`;
}

function buildRow(sheet: SpreadsheetSheet, row: number, range: CellRange): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const inRows = row >= range.startRow && row <= range.endRow;
    const rowHeader = el('th', inRows ? 'rowhdr sel' : 'rowhdr', String(row + 1));
    rowHeader.dataset.row = String(row);
    tr.appendChild(rowHeader);

    const source = sheet.rows[row] ?? [];
    const currentMatch = searchMatchIndex >= 0 ? searchMatches[searchMatchIndex] : null;
    sheet.columns.forEach((_label, col) => {
        const value = source[col];
        const classes = ['cell'];
        if (isNumericValue(value)) {
            classes.push('num');
        }
        if (isCellInRange(range, row, col)) {
            classes.push('sel');
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
        const td = el('td', classes.join(' '), cellText(value));
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
    anchor = { row: 0, col: 0 };
    focusCell = { row: 0, col: 0 };
    els.scroller.scrollTop = 0;
    els.scroller.scrollLeft = 0;
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

function updateFormulaBar(sheet: SpreadsheetSheet): void {
    els.nameBox.textContent = addressOf(sheet, anchor);
    const value = cellText(sheet.rows[anchor.row]?.[anchor.col]);
    els.valueBar.textContent = value;
    els.valueBar.title = value;
}

function updateFooter(sheet: SpreadsheetSheet, range: CellRange): void {
    const parts = [`${sheet.rows.length.toLocaleString()} rows`, `${sheet.columns.length} columns`];
    const cellCount = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
    if (cellCount > 1) {
        parts.push(`${cellCount.toLocaleString()} cells selected`);
    }
    if (data.limitReached) {
        parts.push(`first ${data.maxRows.toLocaleString()} data rows shown (justybase.filePreview.maxRows)`);
    }
    els.footer.textContent = parts.join(' · ');
}

function copySelection(): void {
    const sheet = currentSheet();
    if (!sheet) {
        return;
    }
    const range = normalizeRange(anchor, focusCell);
    post({ command: 'copyToClipboard', text: rangeToTsv(sheet, range) });
    const cellCount = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
    els.footer.textContent = `Copied ${cellCount.toLocaleString()} cell(s) to clipboard`;
}

function selectAll(sheet: SpreadsheetSheet): void {
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
    if (Number.isInteger(col)) {
        anchor = { row: 0, col };
        focusCell = { row: lastRow(sheet), col };
        refresh();
    }
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
    if (target.dataset.col === undefined) {
        anchor = { row, col: 0 };
        focusCell = { row, col: lastCol(sheet) };
        dragging = false;
    } else {
        const col = Number(target.dataset.col);
        if (event.shiftKey) {
            focusCell = { row, col };
        } else {
            anchor = { row, col };
            focusCell = { row, col };
        }
        dragging = true;
    }
    refresh();
}

function onDocumentMouseMove(event: MouseEvent): void {
    onColumnResizeMove(event);
    if (!dragging) {
        return;
    }
    // No button left pressed means the mouseup went elsewhere (for example over another panel): stop, don't extend.
    if (event.buttons === 0) {
        stopDragSelection();
        return;
    }
    dragPointer = { x: event.clientX, y: event.clientY };
    extendDragSelection();
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

/** While the pointer rests at a visible edge, keep scrolling and extending the selection each frame. */
function startDragScroll(): void {
    if (dragFrame === null) {
        dragFrame = requestAnimationFrame(dragScrollFrame);
    }
}

function dragScrollFrame(): void {
    dragFrame = null;
    if (!dragging || !dragPointer) {
        return;
    }
    const { scroller } = els;
    const box = scroller.getBoundingClientRect();
    const dy = edgeScrollStep(dragPointer.y, box.top + HEADER_HEIGHT, box.top + scroller.clientHeight);
    const dx = edgeScrollStep(dragPointer.x, box.left + ROW_NUMBER_WIDTH, box.left + scroller.clientWidth);
    if (dy === 0 && dx === 0) {
        return;
    }
    scroller.scrollTop += dy;
    scroller.scrollLeft += dx;
    extendDragSelection();
    dragFrame = requestAnimationFrame(dragScrollFrame);
}

function stopDragSelection(): void {
    dragging = false;
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
    if (event.key.startsWith('Arrow')) {
        event.preventDefault();
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
