import type { TanStackCellContext } from '../shared/tanstackShims.js';
import type {
    QueryHistoryEntryDto,
    QueryHistoryExtendedStateSnapshot,
    QueryHistoryHostToWebviewMessage,
    QueryHistoryMessageSource,
    QueryHistoryParameterDto,
    QueryHistoryRecoveryActionType,
    QueryHistoryStatsDto,
    QueryHistoryUiState,
    QueryHistoryWebviewToHostMessage,
    QueryExecutionStatus,
} from './hostContracts.js';
import { postToHost, vscode, asHostMessage } from './protocol.js';
import { showParameterDialog as openParameterDialog } from './parameterDialog.js';
import {
    escapeHtml,
    formatDuration,
    formatRowsAffected,
    formatTimestamp,
    getStatusInfo,
    gridSqlPreview,
} from './utils.js';

declare const TableCore: {
    createColumnHelper: () => {
        accessor: (
            accessor: (row: QueryHistoryEntryDto) => unknown,
            column: Record<string, unknown>,
        ) => unknown;
    };
    createTable: (options: Record<string, unknown>) => TanStackTableHandle;
    getCoreRowModel: () => unknown;
};

declare const VirtualCore: {
    Virtualizer: new (options: Record<string, unknown>) => TanStackVirtualizerHandle;
    elementScroll: (...args: unknown[]) => void;
    observeElementRect: (...args: unknown[]) => void;
    observeElementOffset: (...args: unknown[]) => void;
};

interface TanStackTableHandle {
    options: { data: QueryHistoryEntryDto[] };
    getRowModel: () => {
        rows: Array<{
            index: number;
            original: QueryHistoryEntryDto;
            getValue: (colId: string) => unknown;
            _getAllCellsByColumnId?: () => Record<string, { getValue: () => unknown }>;
        }>;
    };
    getAllLeafColumns: () => Array<{
        id: string;
        getSize: () => number;
        columnDef: { minSize?: number; maxSize?: number; header?: string };
    }>;
}

interface TanStackVirtualizerHandle {
    options: { count: number };
    getVirtualItems: () => Array<{ index: number; start: number; size: number }>;
    getTotalSize: () => number;
    _didMount: () => () => void;
    _willUpdate: () => void;
}

type HistoryTableLeafColumn = ReturnType<TanStackTableHandle['getAllLeafColumns']>[number];

type QueryHistoryEntry = QueryHistoryEntryDto;
type QueryHistoryParameter = QueryHistoryParameterDto;

let allHistory: QueryHistoryEntryDto[] = [];
let selectedEntryId: string | null = null;
let pendingQuickRerunId: string | null = null;
let currentUiState: QueryHistoryUiState | null = null;

// ── TanStack Table state ────────────────────────────────────────────
let tanTable: TanStackTableHandle | null = null;
let rowVirtualizer: TanStackVirtualizerHandle | null = null;
let virtualizerCleanup: (() => void) | null = null;
let renderScheduled = false;

function getPersistedState(): QueryHistoryExtendedStateSnapshot | undefined {
    return vscode.getState() as QueryHistoryExtendedStateSnapshot | undefined;
}

function persistState(): void {
    const nextState: QueryHistoryExtendedStateSnapshot = {
        selectedEntryId,
        pendingQuickRerunId,
        currentUiState,
    };
    vscode.setState(nextState);
}

function dispatchRecoveryAction(actionType: QueryHistoryRecoveryActionType): void {
    if (actionType === 'refresh') {
        postToHost({ type: 'refresh' });
        return;
    }

    if (actionType === 'getSavedViews') {
        postToHost({ type: 'getSavedViews' });
        return;
    }

    postToHost({ type: 'getHistory' });
}

// ── TanStack Column definitions ────────────────────────────────────

function buildColumns(): unknown[] {
    const { createColumnHelper } = TableCore;
    const helper = createColumnHelper();

    return [
        helper.accessor(row => row, {
            id: 'statusIcon',
            header: '',
            size: 36,
            minSize: 36,
            maxSize: 36,
            enableResizing: false,
            enableSorting: false,
            cell: (info: TanStackCellContext<QueryHistoryEntryDto>) => {
                const entry = info.getValue();
                const si = getStatusInfo(entry.status);
                const span = document.createElement('span');
                span.className = 'tcell-status-badge ' + si.className;
                span.textContent = si.icon;
                span.title = si.text;
                return span;
            }
        }),
        helper.accessor(row => row.durationMs, {
            id: 'duration',
            header: 'Duration',
            size: 80,
            minSize: 60,
            cell: (info: TanStackCellContext<number | undefined>) => {
                const dur = formatDuration(info.getValue());
                if (!dur.text) return document.createTextNode('');
                const span = document.createElement('span');
                span.className = 'tcell-duration ' + dur.className;
                span.textContent = dur.text;
                return span;
            }
        }),
        helper.accessor(row => row.rowsAffected, {
            id: 'rows',
            header: 'Rows',
            size: 65,
            minSize: 50,
            cell: (info: TanStackCellContext<number | undefined | null>) => {
                const v = info.getValue();
                if (v === undefined || v === null) return document.createTextNode('—');
                return document.createTextNode(v.toLocaleString());
            }
        }),
        helper.accessor(row => row.timestamp, {
            id: 'time',
            header: 'Time',
            size: 140,
            minSize: 100,
            cell: (info: TanStackCellContext<number>) => document.createTextNode(formatTimestamp(info.getValue()))
        }),
        helper.accessor(row => row.connectionName || row.host, {
            id: 'connection',
            header: 'Connection',
            size: 130,
            minSize: 80,
            cell: (info: TanStackCellContext<string | undefined>) => document.createTextNode(info.getValue() ?? '')
        }),
        helper.accessor(row => row.database, {
            id: 'database',
            header: 'Database',
            size: 100,
            minSize: 60,
            cell: (info: TanStackCellContext<string>) => document.createTextNode(info.getValue())
        }),
        helper.accessor(row => row.query, {
            id: 'sql',
            header: 'SQL',
            size: 300,
            minSize: 100,
            enableResizing: false,
            cell: (info: TanStackCellContext<string>) => {
                const q = info.getValue();
                const txt = document.createTextNode(gridSqlPreview(q, 50));
                const div = document.createElement('div');
                div.className = 'tcell-sql';
                div.appendChild(txt);
                div.title = q;
                return div;
            }
        }),
    ];
}

// ── Table initialization ────────────────────────────────────────────

function initTable(): void {
    const { createTable, getCoreRowModel } = TableCore;

    tanTable = createTable({
        data: allHistory,
        columns: buildColumns(),
        state: {
            columnSizing: {},
            columnSizingInfo: { startOffset: null, startSize: null, deltaOffset: null, deltaPercentage: null, isResizingColumn: false, columnSizingStart: [] },
            columnOrder: [],
            columnVisibility: {},
            columnPinning: { left: [], right: [] }
        },
        getCoreRowModel: getCoreRowModel(),
    });

    initVirtualizer();
    scheduleRenderRows();
}

function initVirtualizer(): void {
    if (!tanTable) return;
    const wrapper = document.getElementById('entriesContainer');
    if (!wrapper) return;
    const rows = tanTable.getRowModel().rows;

    if (!rowVirtualizer) {
        rowVirtualizer = new VirtualCore.Virtualizer({
            count: rows.length,
            getScrollElement: () => wrapper,
            estimateSize: () => 32,
            overscan: 15,
            scrollToFn: VirtualCore.elementScroll,
            observeElementRect: VirtualCore.observeElementRect,
            observeElementOffset: VirtualCore.observeElementOffset,
            onChange: () => scheduleRenderRows()
        });
        virtualizerCleanup = rowVirtualizer._didMount();
    } else {
        rowVirtualizer.options.count = rows.length;
    }
    rowVirtualizer._willUpdate();
}

function scheduleRenderRows(): void {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        renderTableRows();
    });
}

function syncTableColumnWidths(table: HTMLTableElement): void {
    if (!tanTable) return;
    const columns = tanTable.getAllLeafColumns();
    let totalWidth = 0;

    columns.forEach((col, index) => {
        const size = col.getSize() || 100;
        const minSize = col.columnDef.minSize || 40;
        totalWidth += size;

        const th = table.querySelector(`thead th:nth-child(${index + 1}`) as HTMLElement | null;
        if (th) {
            th.style.width = size + 'px';
            th.style.minWidth = minSize + 'px';
            if (col.columnDef.maxSize) {
                th.style.maxWidth = col.columnDef.maxSize + 'px';
            }
        }
    });

    table.style.minWidth = totalWidth + 'px';
}

function applyColumnCellWidth(td: HTMLTableCellElement, col: HistoryTableLeafColumn): void {
    const size = col.getSize() || 100;
    const minSize = col.columnDef.minSize || 40;
    td.style.width = size + 'px';
    td.style.minWidth = minSize + 'px';
    if (col.columnDef.maxSize) {
        td.style.maxWidth = col.columnDef.maxSize + 'px';
    }
}

function renderTableRows(): void {
    const container = document.getElementById('entriesContainer');
    if (!container || !tanTable || !rowVirtualizer) return;

    const rows = tanTable.getRowModel().rows;
    if (rows.length === 0) {
        container.innerHTML = '';
        return;
    }

    const virtualItems = rowVirtualizer.getVirtualItems();

    let table = container.querySelector('table.history-table');
    if (!table) {
        table = document.createElement('table');
        table.className = 'history-table';
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const columns = tanTable.getAllLeafColumns();
        columns.forEach(col => {
            const th = document.createElement('th');
            th.textContent = typeof col.columnDef.header === 'string' ? col.columnDef.header : '';
            const sz = col.getSize() || 100;
            th.style.width = sz + 'px';
            th.style.minWidth = (col.columnDef.minSize || 40) + 'px';
            if (col.columnDef.maxSize) {
                th.style.maxWidth = col.columnDef.maxSize + 'px';
            }
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        table.appendChild(tbody);
        container.innerHTML = '';
        container.appendChild(table);
    }

    syncTableColumnWidths(table as HTMLTableElement);

    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const fragment = document.createDocumentFragment();

    if (virtualItems.length > 0) {
        const padTop = document.createElement('tr');
        padTop.className = 'tpad-top';
        padTop.style.height = virtualItems[0].start + 'px';
        const td = document.createElement('td');
        td.colSpan = tanTable.getAllLeafColumns().length;
        td.style.padding = '0';
        td.style.border = 'none';
        padTop.appendChild(td);
        fragment.appendChild(padTop);
    }

    for (const vItem of virtualItems) {
        const row = rows[vItem.index];
        if (!row) continue;
        const entry = row.original;

        const tr = document.createElement('tr');
        tr.className = 'history-table-row';
        tr.dataset.id = entry.id;
        if (selectedEntryId === entry.id) {
            tr.classList.add('selected');
        }
        const si = getStatusInfo(entry.status);
        tr.classList.add(si.className);

        tr.addEventListener('click', () => {
            selectEntry(entry.id);
        });

        // Render cells from column order
        const columns = tanTable.getAllLeafColumns();
        const allCells = row._getAllCellsByColumnId?.() ?? {};
        for (let ci = 0; ci < columns.length; ci++) {
            const col = columns[ci];
            const td = document.createElement('td');
            applyColumnCellWidth(td, col);
            const cell = allCells[col.id];
            const cellValue = cell ? cell.getValue() : undefined;

            if (col.id === 'statusIcon') {
                const span = document.createElement('span');
                span.className = 'tcell-status-badge ' + si.className;
                span.textContent = si.icon;
                span.title = si.text;
                td.appendChild(span);
            } else if (col.id === 'duration') {
                const dur = formatDuration(entry.durationMs);
                if (dur.text) {
                    const span = document.createElement('span');
                    span.className = 'tcell-duration ' + dur.className;
                    span.textContent = dur.text;
                    td.appendChild(span);
                } else {
                    td.textContent = '—';
                }
            } else if (col.id === 'rows') {
                const v = entry.rowsAffected;
                td.textContent = v !== undefined && v !== null ? v.toLocaleString() : '—';
            } else if (col.id === 'time') {
                td.textContent = formatTimestamp(entry.timestamp);
            } else if (col.id === 'connection') {
                td.textContent = entry.connectionName || entry.host || '—';
            } else if (col.id === 'database') {
                td.textContent = entry.database || '—';
            } else if (col.id === 'sql') {
                const div = document.createElement('div');
                div.className = 'tcell-sql';
                div.textContent = gridSqlPreview(entry.query, 50);
                div.title = entry.query;
                td.appendChild(div);
            } else {
                td.textContent = String(cellValue ?? '');
            }
            tr.appendChild(td);
        }

        fragment.appendChild(tr);
    }

    // Bottom padding
    const totalSize = rowVirtualizer.getTotalSize();
    const lastItem = virtualItems[virtualItems.length - 1];
    if (lastItem) {
        const bottomPad = lastItem.start + lastItem.size;
        const remaining = totalSize - bottomPad;
        if (remaining > 0) {
            const padBottom = document.createElement('tr');
            padBottom.className = 'tpad-bottom';
            padBottom.style.height = remaining + 'px';
            const td = document.createElement('td');
            td.colSpan = tanTable.getAllLeafColumns().length;
            td.style.padding = '0';
            td.style.border = 'none';
            padBottom.appendChild(td);
            fragment.appendChild(padBottom);
        }
    }

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
}

function updateTableData(): void {
    if (!tanTable) {
        initTable();
    } else {
        tanTable.options.data = allHistory;
        initVirtualizer();
        scheduleRenderRows();
    }
}

function init(): void {
    console.log('queryHistoryExtended webview: init -> requesting history');

    const savedState = getPersistedState();
    if (savedState) {
        selectedEntryId = savedState.selectedEntryId;
        pendingQuickRerunId = savedState.pendingQuickRerunId;
        currentUiState = savedState.currentUiState;
    }

    attachEventListeners();

    if (currentUiState) {
        renderUiState(currentUiState);
    }

    postToHost({ type: 'getHistory' });
}

function updateStats(stats: QueryHistoryStatsDto): void {
    const statsEl = document.getElementById('stats');
    if (statsEl) {
        let text = `${stats.activeEntries} active`;
        if (stats.archivedEntries > 0) {
            text += ` · ${stats.archivedEntries} archived`;
        }
        text += ` · ${stats.totalFileSizeMB} MB`;
        statsEl.textContent = text;
    }
}

function renderUiState(state: QueryHistoryUiState): void {
    currentUiState = state;
    persistState();

    const container = document.getElementById('entriesContainer');
    if (!container) {
        return;
    }

    enableDetailButtons(false);
    showEmptyDetails();

    if (state.kind === 'empty' && state.stats) {
        updateStats(state.stats);
    }

    const icon = state.kind === 'error' ? '⚠️' : state.kind === 'loading' ? '⏳' : '📜';
    const primaryText = state.kind === 'loading' ? state.message : state.title;
    const secondaryText = state.kind === 'loading' ? '' : state.detail;

    container.innerHTML = `
        <div class="empty-details" data-state-kind="${escapeHtml(state.kind)}">
            <div class="empty-details-icon">${icon}</div>
            <div>${escapeHtml(primaryText)}</div>
            ${secondaryText ? `<div>${escapeHtml(secondaryText)}</div>` : ''}
            ${state.kind !== 'loading' && state.action ? `<button class="secondary state-action-btn" data-action-type="${escapeHtml(state.action.messageType)}">${escapeHtml(state.action.label)}</button>` : ''}
        </div>
    `;
}

function selectEntry(id: string): void {
    selectedEntryId = id;
    persistState();

    // Update row highlight
    const container = document.getElementById('entriesContainer');
    if (container) {
        container.querySelectorAll('.history-table-row').forEach((rowElement) => {
            const row = rowElement as HTMLElement;
            row.classList.toggle('selected', row.dataset.id === id);
        });
    }

    const entry = allHistory.find(historyEntry => historyEntry.id === id);
    if (entry) {
        showEntryDetails(entry);
        enableDetailButtons(true);
    } else {
        showEmptyDetails();
        enableDetailButtons(false);
    }
}

function showEntryDetails(entry: QueryHistoryEntryDto): void {
    const content = document.getElementById('detailsContent');
    if (!content) return;

    const statusInfo = getStatusInfo(entry.status);
    const durationInfo = formatDuration(entry.durationMs);
    const rowsText = formatRowsAffected(entry.rowsAffected);

    content.innerHTML = `
        <div class="detail-section">
            <div class="detail-meta">
                <div class="detail-meta-item">
                    <div class="detail-meta-label">Timestamp</div>
                    <div class="detail-meta-value">${formatTimestamp(entry.timestamp)}</div>
                </div>
                <div class="detail-meta-item">
                    <div class="detail-meta-label">Connection</div>
                    <div class="detail-meta-value">${escapeHtml(entry.connectionName || entry.host)}</div>
                </div>
                <div class="detail-meta-item">
                    <div class="detail-meta-label">Database</div>
                    <div class="detail-meta-value">${escapeHtml(entry.database)}</div>
                </div>
                <div class="detail-meta-item">
                    <div class="detail-meta-label">Host</div>
                    <div class="detail-meta-value">${escapeHtml(entry.host)}</div>
                </div>
            </div>
        </div>

        <div class="detail-section detail-execution">
            <div class="detail-label">Execution</div>
            <div class="detail-execution-info">
                <div class="detail-execution-item">
                    <span class="execution-label">Status</span>
                    <span class="execution-value"><span class="status-badge ${statusInfo.className}">${statusInfo.icon}</span> ${statusInfo.text}</span>
                </div>
                ${durationInfo.text ? `
                <div class="detail-execution-item">
                    <span class="execution-label">Duration</span>
                    <span class="execution-value"><span class="duration-badge ${durationInfo.className}">${escapeHtml(durationInfo.text)}</span></span>
                </div>
                ` : ''}
                ${rowsText ? `
                <div class="detail-execution-item">
                    <span class="execution-label">Rows Affected</span>
                    <span class="execution-value">📊 ${escapeHtml(rowsText)}</span>
                </div>
                ` : ''}
                ${entry.durationMs ? `
                <div class="detail-execution-item">
                    <span class="execution-label">Duration (ms)</span>
                    <span class="execution-value">${entry.durationMs} ms</span>
                </div>
                ` : ''}
            </div>
            ${entry.errorMessage ? `
            <div class="detail-error">
                <div class="error-label">Error Message</div>
                <div class="error-message">${escapeHtml(entry.errorMessage)}</div>
            </div>
            ` : ''}
        </div>

        ${entry.description ? `
        <div class="detail-section">
            <div class="detail-label">Description</div>
            <div class="detail-description">${escapeHtml(entry.description)}</div>
        </div>
        ` : ''}

        ${entry.tags ? `
        <div class="detail-section">
            <div class="detail-label">Tags</div>
            <div class="detail-tags">
                ${entry.tags.split(',').map(tag => `<span class="tag">${escapeHtml(tag.trim())}</span>`).join('')}
            </div>
        </div>
        ` : ''}

        <div class="detail-section">
            <div class="detail-label">SQL Query</div>
            <pre class="detail-query"></pre>
        </div>
    `;

    const pre = content.querySelector('.detail-query');
    if (pre) pre.textContent = entry.query ?? '';

    const favoriteBtn = document.getElementById('toggleFavoriteBtn');
    if (favoriteBtn) {
        favoriteBtn.textContent = entry.is_favorite ? '⭐ Unfavorite' : '☆ Favorite';
        favoriteBtn.classList.toggle('favorite', entry.is_favorite);
    }
}

function showEmptyDetails(): void {
    const content = document.getElementById('detailsContent');
    if (!content) return;

    content.innerHTML = `
        <div class="empty-details">
            <div class="empty-details-icon">📋</div>
            <div>Select an entry to view details</div>
        </div>
    `;
}

function enableDetailButtons(enabled: boolean): void {
    const buttons = ['copyQueryBtn', 'executeQueryBtn', 'quickRerunBtn', 'deleteEntryBtn', 'toggleFavoriteBtn'];
    buttons.forEach(buttonId => {
        const button = document.getElementById(buttonId) as HTMLButtonElement | null;
        if (button) {
            button.disabled = !enabled;
        }
    });
}

function copyQuery(): void {
    if (!selectedEntryId) return;
    const entry = allHistory.find(historyEntry => historyEntry.id === selectedEntryId);
    if (entry) {
        postToHost({ type: 'copyQuery', query: entry.query });
    }
}

function executeQuery(): void {
    if (!selectedEntryId) return;
    const entry = allHistory.find(historyEntry => historyEntry.id === selectedEntryId);
    if (entry) {
        postToHost({ type: 'executeQuery', query: entry.query });
    }
}

function deleteEntry(): void {
    if (!selectedEntryId) return;
    const entry = allHistory.find(historyEntry => historyEntry.id === selectedEntryId);
    if (entry) {
        postToHost({ type: 'deleteEntry', id: selectedEntryId, query: entry.query });
    }
}

function toggleFavorite(): void {
    if (!selectedEntryId) return;
    postToHost({ type: 'toggleFavorite', id: selectedEntryId });
}

function refreshHistory(): void {
    postToHost({ type: 'getHistory' });
}

function searchHistory(term: string): void {
    if (!term.trim()) {
        postToHost({ type: 'getHistory' });
        document.getElementById('searchStatus')?.remove();
        return;
    }

    postToHost({ type: 'search', term: term.toLowerCase() });
}

function showSearchStatus(term: string, source: QueryHistoryMessageSource, count: number): void {
    let statusEl = document.getElementById('searchStatus');
    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'searchStatus';
        statusEl.className = 'search-status';
        const toolbar = document.querySelector('.toolbar-left');
        if (toolbar) {
            toolbar.appendChild(statusEl);
        }
    }

    if (count === 0) {
        statusEl.textContent = `No results found for "${term || ''}"`;
        statusEl.style.color = '#d9534f';
    } else {
        const sourceText = source === 'active+archive' ? 'Active + Archive' : 'Active';
        statusEl.textContent = `Found ${count} result(s) in ${sourceText}`;
        statusEl.style.color = '#5cb85c';
    }
}

function attachEventListeners(): void {
    const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('searchInput'));
    const refreshBtn = document.getElementById('refreshBtn');
    const copyQueryBtn = document.getElementById('copyQueryBtn');
    const executeQueryBtn = document.getElementById('executeQueryBtn');
    const quickRerunBtn = document.getElementById('quickRerunBtn');
    const deleteEntryBtn = document.getElementById('deleteEntryBtn');
    const toggleFavoriteBtn = document.getElementById('toggleFavoriteBtn');
    const statusFilter = /** @type {HTMLSelectElement | null} */ (document.getElementById('statusFilter'));

    if (searchInput) {
        let searchTimeout: number | undefined;
        searchInput.addEventListener('input', (event) => {
            const target = event.target as HTMLInputElement;
            const searchTerm = target.value.trim();

            if (searchTimeout !== undefined) {
                window.clearTimeout(searchTimeout);
            }

            searchTimeout = window.setTimeout(() => {
                searchHistory(searchTerm);
            }, 300);
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', (event) => {
            const status = (event.target as HTMLSelectElement).value;
            postToHost({
                type: 'filterByStatus',
                status: status as QueryExecutionStatus | 'all',
            });
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => refreshHistory());
    }
    if (copyQueryBtn) {
        copyQueryBtn.addEventListener('click', () => copyQuery());
    }
    if (executeQueryBtn) {
        executeQueryBtn.addEventListener('click', () => executeQuery());
    }
    if (deleteEntryBtn) {
        deleteEntryBtn.addEventListener('click', () => deleteEntry());
    }
    if (toggleFavoriteBtn) {
        toggleFavoriteBtn.addEventListener('click', () => toggleFavorite());
    }
    if (quickRerunBtn) {
        quickRerunBtn.addEventListener('click', () => requestQuickRerunExtended());
    }

    const entriesContainer = document.getElementById('entriesContainer');
    if (entriesContainer) {
        entriesContainer.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const actionButton = target.closest('.state-action-btn');
            if (!actionButton) {
                return;
            }

            const actionType = actionButton.getAttribute('data-action-type');
            if (
                actionType === 'refresh'
                || actionType === 'getHistory'
                || actionType === 'getSavedViews'
            ) {
                dispatchRecoveryAction(actionType);
            }
        });
    }

    // ── Resizable divider ──────────────────────────────────────────────
    const divider = document.getElementById('resizeDivider');
    const entriesList = document.getElementById('entriesList');
    let dividerDragging = false;
    if (divider && entriesList) {
        divider.addEventListener('mousedown', function (e) {
            dividerDragging = true;
            divider.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dividerDragging) return;
            const parent = entriesList.parentElement;
            if (!parent) return;
            const parentRect = parent.getBoundingClientRect();
            const pct = ((e.clientX - parentRect.left) / parentRect.width) * 100;
            const clamped = Math.max(20, Math.min(80, pct));
            entriesList.style.flex = '0 0 ' + clamped + '%';
        });
        document.addEventListener('mouseup', function () {
            if (dividerDragging) {
                dividerDragging = false;
                divider.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }
}

// ====================
// Quick Rerun with Parameters (Extended View)
// ====================

function requestQuickRerunExtended(): void {
    if (!selectedEntryId) return;
    const entry = allHistory.find(historyEntry => historyEntry.id === selectedEntryId);
    if (!entry) return;

    pendingQuickRerunId = entry.id;
    persistState();
    postToHost({ type: 'parseQueryParameters', query: entry.query });
}

function handleQueryParametersExtended(parameters: QueryHistoryParameterDto[]): void {
    openParameterDialog({
        parameters,
        onRun(values) {
            if (pendingQuickRerunId) {
                postToHost({ type: 'quickRerun', queryId: pendingQuickRerunId, parameters: values });
            }
            pendingQuickRerunId = null;
            persistState();
        },
        onCancel() {
            pendingQuickRerunId = null;
            persistState();
        },
    });
}

window.addEventListener('message', (event) => {
    const message = asHostMessage(event.data);
    console.log('queryHistoryExtended webview: received message', message);

    switch (message.type) {
        case 'historyData':
            currentUiState = null;
            allHistory = message.history;
            updateStats(message.stats);
            if (!tanTable) {
                initTable();
            } else {
                updateTableData();
            }
            if (selectedEntryId && !allHistory.find(entry => entry.id === selectedEntryId)) {
                selectedEntryId = null;
                showEmptyDetails();
                enableDetailButtons(false);
            } else if (selectedEntryId) {
                selectEntry(selectedEntryId);
            }
            persistState();
            break;

        case 'entryAdded':
            // Prepend new entry and update stats without full re-initialization
            allHistory = [message.entry, ...allHistory];
            updateStats(message.stats);
            if (tanTable) {
                updateTableData();
            } else {
                initTable();
            }
            persistState();
            break;

        case 'searchResults':
            currentUiState = null;
            allHistory = message.history;
            updateStats(message.stats);
            updateTableData();
            selectedEntryId = null;
            showEmptyDetails();
            enableDetailButtons(false);
            showSearchStatus(message.term, message.source, allHistory.length);
            persistState();
            break;

        case 'entryDeleted':
            allHistory = allHistory.filter(e => e.id !== message.id);
            if (selectedEntryId === message.id) {
                selectedEntryId = null;
                showEmptyDetails();
                enableDetailButtons(false);
            }
            updateTableData();
            persistState();
            break;

        case 'updateStats':
            updateStats(message.stats);
            break;

        case 'debug':
            console.log('queryHistoryExtended debug:', message.msg, message);
            break;

        case 'queryParameters':
            handleQueryParametersExtended(message.parameters);
            break;

        case 'uiState':
            renderUiState(message.state);
            break;
    }
});

window.addEventListener('load', () => {
    init();
});
