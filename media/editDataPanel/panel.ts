import {
    createTable,
    getCoreRowModel,
    getSortedRowModel,
} from '@tanstack/table-core';
import type { Row, Table } from '@tanstack/table-core';
import {
    Virtualizer,
    elementScroll,
    observeElementRect,
    observeElementOffset,
} from '@tanstack/virtual-core';
import type { TanStackCellContext } from '../shared/tanstackShims.js';
import type {
    EditDataChanges,
    EditDataMetadata,
    EditDataPanelHostToWebviewMessage,
    EditDataPanelWebviewToHostMessage,
    EditDataRow,
} from './hostContracts.js';
import { postToHost, asHostMessage } from './protocol.js';
import { getElementById } from './dom.js';
import { escapeHtml } from './utils.js';

interface EditDataTableState {
    original: EditDataRow[];
    working: EditDataRow[];
    columns: string[];
    metadata: EditDataMetadata | null;
}

interface TrackedChanges {
    updates: Record<string | number, { rowId: string | number; changes: Record<string, unknown> }>;
    deletes: Set<string | number>;
    inserts: EditDataRow[];
}

let nextInsertId = -1;
let tanTable: Table<EditDataRow> | null = null;
let rowVirtualizer: Virtualizer<HTMLDivElement, Element> | null = null;

const tableData: EditDataTableState = {
    original: [],
    working: [],
    columns: [],
    metadata: null,
};

const changes: TrackedChanges = {
    updates: {},
    deletes: new Set(),
    inserts: [],
};

function resetChanges(): void {
    changes.updates = {};
    changes.deletes = new Set();
    changes.inserts = [];
}

// Initialize
window.addEventListener('message', event => {
    const message = asHostMessage(event.data);
    switch (message.command) {
        case 'setData':
            initData(message.data, message.columns, message.metadata);
            break;
        case 'setLoading':
            setLoading(message.loading, message.message);
            break;
        case 'setError':
            showError(message.text);
            break;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const filterWhere = getElementById<HTMLInputElement>('filterWhere');
    const filterColumns = getElementById<HTMLInputElement>('filterColumns');
    const refreshBtn = getElementById<HTMLButtonElement>('refreshBtn');
    const saveBtn = getElementById<HTMLButtonElement>('saveBtn');
    const addRowBtn = getElementById<HTMLButtonElement>('addRowBtn');

    const triggerRefresh = () => {
        if (hasUnsavedChanges() && !confirm('You have unsaved changes. Discard them?')) {
            return;
        }

        postToHost({
            command: 'refresh',
            whereClause: filterWhere?.value ?? '',
            columns: filterColumns?.value ?? ''
        });
    };

    if (refreshBtn) refreshBtn.onclick = triggerRefresh;

    [filterWhere, filterColumns].forEach(el => {
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') triggerRefresh();
            });
        }
    });

    if (saveBtn) saveBtn.onclick = () => {
        saveChanges();
    };

    if (addRowBtn) addRowBtn.onclick = () => {
        addNewRow();
    };

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const htmlTab = tab as HTMLElement;
            setActiveTab(htmlTab.dataset.target);
        });
    });
});

function setActiveTab(tabId: string | undefined): void {
    if (!tabId) return;
    document.querySelectorAll('.tab').forEach(t => {
        const htmlTab = t as HTMLElement;
        if (htmlTab.dataset.target === tabId) htmlTab.classList.add('active');
        else htmlTab.classList.remove('active');
    });

    document.querySelectorAll('.tab-content').forEach(c => {
        const content = c as HTMLElement;
        if (content.id === tabId) content.classList.add('active');
        else content.classList.remove('active');
    });
}

function setLoading(isLoading: boolean, message?: string): void {
    const status = getElementById('status');
    if (!status) return;

    if (message) {
        status.textContent = message;
    } else {
        status.textContent = isLoading ? 'Loading...' : (tableData.working ? `${tableData.working.length} rows` : '');
    }

    document.querySelectorAll('button').forEach(b => {
        (b as HTMLButtonElement).disabled = isLoading;
    });
}

function showError(msg: string): void {
    const container = getElementById('gridContainer');
    if (container) {
        container.innerHTML = `<div style="color: var(--vscode-errorForeground); padding: 20px;">Error: ${msg}</div>`;
    }
}

function initData(
    data: EditDataRow[],
    columns: string[],
    metadata: EditDataMetadata | null,
): void {
    console.log('[editDataPanel] initData received:', { dataRows: data ? data.length : 0, columns: columns ? columns.length : 0, metadata: !!metadata });
    console.log('[editDataPanel] Sample data (first row):', data && data[0] ? JSON.stringify(data[0]).substring(0, 200) : 'none');

    tableData.original = JSON.parse(JSON.stringify(data));
    tableData.working = JSON.parse(JSON.stringify(data));
    tableData.columns = columns;
    tableData.metadata = metadata;

    resetChanges();
    nextInsertId = -1;

    renderMetadataPanel();
    renderTable();
    setLoading(false);
}

function hasUnsavedChanges() {
    return Object.keys(changes.updates).length > 0 ||
        changes.deletes.size > 0 ||
        changes.inserts.length > 0;
}

// --- Metadata Panel ---
function renderMetadataPanel(): void {
    const container = getElementById('metadataContent');
    if (!container) return;

    container.innerHTML = '';

    if (!tableData.metadata) {
        container.innerHTML = `
            <div class="empty-state">
                <span style="font-size: 32px; margin-bottom: 12px;">📋</span>
                <span>No metadata available</span>
            </div>
        `;
        return;
    }

    const { tableComment, columns } = tableData.metadata;

    // 1. Table Comment Card
    const commentCard = document.createElement('div');
    commentCard.className = 'metadata-card';
    commentCard.innerHTML = `
        <div class="metadata-card-header">
            <h3><span class="icon">💬</span> Table Description</h3>
            <button id="saveTableCommentBtn" class="small-btn primary">Save</button>
        </div>
        <div class="metadata-card-body">
            <textarea id="tableCommentBox" class="comment-box" placeholder="Add a description for this table...">${tableComment || ''}</textarea>
        </div>
    `;
    container.appendChild(commentCard);

    const saveTableCommentBtn = getElementById<HTMLButtonElement>('saveTableCommentBtn');
    const tableCommentBox = getElementById<HTMLTextAreaElement>('tableCommentBox');
    if (saveTableCommentBtn) {
        saveTableCommentBtn.onclick = () => {
            postToHost({ command: 'updateTableComment', comment: tableCommentBox?.value ?? '' });
        };
    }

    // 2. Columns Card
    const columnsCard = document.createElement('div');
    columnsCard.className = 'metadata-card';

    const columnRows = columns.map(col => {
        const keyIndicators: string[] = [];
        if (col.IS_PK == 1) keyIndicators.push('<span class="key-indicator pk" title="Primary Key">🔑</span>');
        if (col.IS_FK == 1) keyIndicators.push('<span class="key-indicator fk" title="Foreign Key">🔗</span>');
        const keyCell = keyIndicators.length > 0 ? keyIndicators.join(' ') : '<span style="opacity:0.3">—</span>';

        const nullIndicator = col.IS_NOT_NULL == 1
            ? '<span class="null-indicator required" title="NOT NULL">✓</span>'
            : '<span class="null-indicator nullable" title="Nullable">○</span>';

        const defaultVal = col.COLDEFAULT
            ? `<span class="default-value">${escapeHtml(col.COLDEFAULT)}</span>`
            : '<span class="no-default">—</span>';

        return `
            <tr>
                <td style="text-align:center; width:50px;">${keyCell}</td>
                <td style="font-weight:500;">${escapeHtml(col.ATTNAME)}</td>
                <td><span class="type-badge">${escapeHtml(col.FORMAT_TYPE)}</span></td>
                <td style="text-align:center; width:60px;">${nullIndicator}</td>
                <td>${defaultVal}</td>
                <td style="padding:4px;">
                    <input type="text" 
                        class="inline-edit col-comment" 
                        data-col="${escapeHtml(col.ATTNAME)}" 
                        value="${escapeHtml(col.DESCRIPTION || '')}" 
                        placeholder="Add comment..."
                    >
                </td>
                <td style="text-align:center; width:40px;">
                    <button class="icon-btn delete-col-btn" data-col="${escapeHtml(col.ATTNAME)}" title="Drop Column">×</button>
                </td>
            </tr>
        `;
    }).join('');

    columnsCard.innerHTML = `
        <div class="metadata-card-header">
            <h3><span class="icon">📊</span> Columns <span style="opacity:0.6; font-weight:400; margin-left:8px;">(${columns.length})</span></h3>
        </div>
        <div class="metadata-grid-container">
            <table class="metadata-table">
                <thead>
                    <tr>
                        <th style="width:60px; text-align:center;">Key</th>
                        <th style="width:180px;">Column Name</th>
                        <th style="width:140px;">Type</th>
                        <th style="width:50px; text-align:center;">NN</th>
                        <th style="width:120px;">Default</th>
                        <th style="min-width:200px;">Comment</th>
                        <th style="width:40px;"></th>
                    </tr>
                </thead>
                <tbody>
                    ${columnRows}
                </tbody>
            </table>
        </div>
    `;

    container.appendChild(columnsCard);

    // Bind Metadata Events - Comment updates
    container.querySelectorAll('.col-comment').forEach(input => {
        const htmlInput = input as HTMLInputElement;
        htmlInput.onblur = () => {
            const colName = htmlInput.dataset.col;
            const newComment = htmlInput.value;
            const original = columns.find(c => c.ATTNAME === colName);
            if (original && colName && (original.DESCRIPTION || '') !== newComment) {
                postToHost({ command: 'updateColumnComment', column: colName, comment: newComment });
            }
        };
        htmlInput.onkeydown = (e) => {
            if (e.key === 'Enter') htmlInput.blur();
        };
    });

    container.querySelectorAll('.delete-col-btn').forEach(btn => {
        const htmlBtn = btn as HTMLButtonElement;
        htmlBtn.onclick = () => {
            const colName = htmlBtn.dataset.col;
            if (colName && confirm(`Are you sure you want to DROP column "${colName}"? This cannot be undone.`)) {
                postToHost({ command: 'dropColumn', column: colName });
            }
        };
    });

    // 3. Add Column Card
    const addCard = document.createElement('div');
    addCard.className = 'add-column-form';
    addCard.innerHTML = `
        <span class="form-label"><span class="icon">➕</span> Add Column</span>
        <input type="text" id="newColName" class="form-input" placeholder="Column name" style="width:140px;">
        <input type="text" id="newColType" class="form-input" placeholder="Type (e.g. INTEGER)" style="width:160px;">
        <button id="addColBtn" class="primary">Add Column</button>
    `;
    container.appendChild(addCard);

    const addColBtn = getElementById<HTMLButtonElement>('addColBtn');
    const newColName = getElementById<HTMLInputElement>('newColName');
    const newColType = getElementById<HTMLInputElement>('newColType');
    if (addColBtn) {
        addColBtn.onclick = () => {
            const name = newColName?.value ?? '';
            const type = newColType?.value ?? '';
            if (!name || !type) {
                showError("Column Name and Type are required.");
                return;
            }
            postToHost({ command: 'addColumn', name, type });
        };
    }
}

// --- Main Data Table ---

function renderTable(): void {
    console.log('[editDataPanel] renderTable called. tableData.working:', tableData.working ? tableData.working.length : 'null');
    console.log('[editDataPanel] tableData.columns:', tableData.columns);

    const container = getElementById('gridContainer');
    console.log('[editDataPanel] gridContainer found:', !!container);
    if (!container) return;

    container.innerHTML = '';

    if (!tableData.working || tableData.working.length === 0) {
        container.innerHTML = '<div class="empty-state">No data in table or loading failed</div>';
        console.log('[editDataPanel] renderTable: No working data, showing empty state');
        return;
    }

    console.log('[editDataPanel] renderTable: Libraries loaded, building table...');

    const columnDefs = [
        {
            id: '__actions',
            header: '',
            size: 40,
            cell: (info: TanStackCellContext) => {
                const row = info.row.original as EditDataRow;
                const btn = document.createElement('span');
                btn.className = 'delete-btn';
                btn.textContent = '×';
                btn.title = 'Delete Row';
                btn.onclick = (e) => {
                    e.stopPropagation();
                    toggleDeleteRow(row);
                };
                return btn;
            }
        },
        ...tableData.columns.map(col => ({
            accessorKey: col,
            header: col,
            cell: (info: TanStackCellContext) => {
                const value = info.getValue();
                const row = info.row.original as EditDataRow;
                const rowId = row.ROWID ?? row.__tempId;
                const isReadOnly = col === 'ROWID';

                if (isReadOnly) {
                    return `<span class="readonly-val">${value !== null && value !== undefined ? value : 'NULL'}</span>`;
                }

                const input = document.createElement('input');
                input.value = value !== null && value !== undefined ? String(value) : '';
                input.placeholder = 'NULL';

                input.onblur = () => {
                    if (isReadOnly || rowId === undefined) return;
                    const newValue = input.value;
                    updateCell(rowId, col, newValue, value);

                    const parentTd = input.parentElement;
                    if (parentTd) {
                        if (isModified(rowId, col)) {
                            parentTd.classList.add('cell-modified');
                        } else {
                            parentTd.classList.remove('cell-modified');
                        }
                    }
                };
                return input;
            }
        }))
    ];

    try {
        tanTable = createTable({
            data: tableData.working,
            columns: columnDefs,
            defaultColumn: {
                size: 150,
                minSize: 50,
                maxSize: 500
            },
            state: {
                columnPinning: { left: [], right: [] },
                columnSizing: { __actions: 40 },
            },
            getCoreRowModel: getCoreRowModel(),
            getSortedRowModel: getSortedRowModel(),
        } as never);
        console.log('[editDataPanel] TanStack Table created successfully');

        // Initialize Virtualizer
        // wrapper is created below, so we need to move wrapper creation up or do this after wrapper creation
    } catch (e) {
        console.error('[editDataPanel] Error creating TanStack Table:', e);
        const message = e instanceof Error ? e.message : String(e);
        container.innerHTML = '<div class="empty-state">Error creating table: ' + message + '</div>';
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.height = '100%';
    wrapper.style.overflow = 'auto';
    wrapper.style.position = 'relative';
    container.appendChild(wrapper);

    if (!tanTable) {
        return;
    }

    // Create Virtualizer
    try {
        const { rows } = tanTable.getRowModel();
        rowVirtualizer = new Virtualizer({
            count: rows.length,
            getScrollElement: () => wrapper,
            estimateSize: () => 35, // Default row height
            overscan: 5,
            scrollToFn: elementScroll,
            observeElementRect: observeElementRect,
            observeElementOffset: observeElementOffset,
            onChange: () => {
                renderRows(tbody, rows);
            }
        });
        rowVirtualizer._didMount();
        rowVirtualizer._willUpdate();
    } catch (e) {
        console.error('[editDataPanel] Error creating Virtualizer:', e);
    }

    const tableEl = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
    wrapper.appendChild(tableEl);

    if (!tanTable) {
        return;
    }

    // Render header
    tanTable.getHeaderGroups().forEach((headerGroup) => {
        const tr = document.createElement('tr');
        headerGroup.headers.forEach((header) => {
            const th = document.createElement('th');
            th.textContent = typeof header.column.columnDef.header === 'string'
                ? header.column.columnDef.header
                : '';
            th.style.width = `${header.getSize()}px`;

            if (tableData.metadata) {
                const colMeta = tableData.metadata.columns.find(c => c.ATTNAME === header.column.id);
                if (colMeta) {
                    if (colMeta.IS_PK == 1) th.textContent = '🔑 ' + th.textContent;
                    if (colMeta.IS_FK == 1) th.textContent = '🔗 ' + th.textContent;
                    th.title = colMeta.DESCRIPTION || '';
                }
            }
            tr.appendChild(th);
        });
        thead.appendChild(tr);
    });
    console.log('[editDataPanel] Header rendered');

    const { rows } = tanTable.getRowModel();
    console.log('[editDataPanel] Row model rows:', rows.length);

    // Initial render
    renderRows(tbody, rows);

    // Re-render on scroll - handled by Virtualizer onChange
    // wrapper.addEventListener('scroll', () => {
    //    renderRows(tbody, rows);
    // });
}

function renderRows(tbody: HTMLElement, rows: Row<EditDataRow>[]): void {
    if (!rowVirtualizer) return;

    tbody.innerHTML = '';

    const virtualRows = rowVirtualizer.getVirtualItems();
    if (virtualRows.length === 0) return;

    const padTop = virtualRows[0].start;
    const totalHeight = rowVirtualizer.getTotalSize();
    const padBottom = totalHeight - virtualRows[virtualRows.length - 1].end;

    if (padTop > 0) {
        const tr = document.createElement('tr');
        tr.style.height = `${padTop}px`;
        tbody.appendChild(tr);
    }

    virtualRows.forEach((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return;
        const tr = document.createElement('tr');
        tr.dataset.index = String(virtualRow.index);
        tr.style.height = `${virtualRow.size}px`;

        const rowData = row.original;
        const rowId = rowData.ROWID ?? rowData.__tempId;

        if (rowId !== undefined && changes.deletes.has(rowId)) tr.classList.add('row-deleted');
        if (!rowData.ROWID) tr.classList.add('row-new');

        row.getVisibleCells().forEach((cell) => {
            const td = document.createElement('td');
            if (rowId !== undefined && isModified(rowId, cell.column.id)) td.classList.add('cell-modified');
            if (cell.column.id === 'ROWID') td.classList.add('readonly');

            const cellRenderer = cell.column.columnDef.cell;
            if (typeof cellRenderer !== 'function') {
                tr.appendChild(td);
                return;
            }
            const content = cellRenderer(cell.getContext());
            if (content instanceof Node) {
                td.appendChild(content);
            } else {
                td.innerHTML = content;
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    if (padBottom > 0) {
        const tr = document.createElement('tr');
        tr.style.height = `${padBottom}px`;
        tbody.appendChild(tr);
    }
}

function updateCell(
    rowId: string | number,
    col: string,
    newValue: unknown,
    originalValue: unknown,
): void {
    if (col === 'ROWID' || col === '__actions') return;

    const row = tableData.working.find(r => (r.ROWID || r.__tempId) == rowId);
    if (!row) return;

    row[col] = newValue;

    if (!row.ROWID) {
        const insertObj = changes.inserts.find(i => i.__tempId == rowId);
        if (insertObj) {
            insertObj[col] = newValue;
        }
        return;
    }

    if (!changes.updates[rowId]) {
        changes.updates[rowId] = { rowId, changes: {} };
    }

    const originalRow = tableData.original.find(r => r.ROWID == rowId);
    const origVal = originalRow ? originalRow[col] : null;

    const valEq = (a: unknown, b: unknown): boolean => {
        if (a === b) return true;
        if ((a === null || a === '') && (b === null || b === '')) return true;
        return String(a) === String(b);
    };

    if (!valEq(newValue, origVal)) {
        changes.updates[rowId].changes[col] = newValue;
    } else {
        delete changes.updates[rowId].changes[col];
        if (Object.keys(changes.updates[rowId].changes).length === 0) {
            delete changes.updates[rowId];
        }
    }
}

function isModified(rowId: string | number | undefined, col: string): boolean {
    if (!rowId) return false;
    if (changes.updates[rowId] && changes.updates[rowId].changes[col] !== undefined) {
        return true;
    }
    return false;
}

function toggleDeleteRow(row: EditDataRow): void {
    const rowId = row.ROWID ?? row.__tempId;
    if (rowId === undefined || rowId === null) {
        return;
    }

    if (!row.ROWID) {
        const idx = tableData.working.findIndex(r => r.__tempId == rowId);
        if (idx !== -1) tableData.working.splice(idx, 1);
        const insIdx = changes.inserts.findIndex(i => i.__tempId == rowId);
        if (insIdx !== -1) changes.inserts.splice(insIdx, 1);
        renderTable();
        return;
    }

    if (changes.deletes.has(rowId)) {
        changes.deletes.delete(rowId);
    } else {
        changes.deletes.add(rowId);
    }
    renderTable();
}

function addNewRow(): void {
    const tempId = nextInsertId--;
    const newRow: EditDataRow = { __tempId: tempId };
    tableData.columns.forEach(c => {
        if (c !== 'ROWID') newRow[c] = null;
    });

    tableData.working.unshift(newRow);
    changes.inserts.push(newRow);
    renderTable();
}

function saveChanges() {
    /** @type {EditDataChanges} */
    const payload = {
        updates: Object.values(changes.updates),
        deletes: Array.from(changes.deletes),
        inserts: changes.inserts.map(i => {
            const { __tempId, ...rest } = i;
            return rest;
        })
    };

    if (payload.updates.length === 0 && payload.deletes.length === 0 && payload.inserts.length === 0) {
        postToHost({ command: 'info', text: 'No changes to save.' });
        return;
    }

    // Include current filter state so after save we can reapply same filters
    const filterWhere = getElementById<HTMLInputElement>('filterWhere');
    const filterColumns = getElementById<HTMLInputElement>('filterColumns');

    postToHost({
        command: 'save',
        changes: payload,
        whereClause: filterWhere?.value ?? '',
        columns: filterColumns?.value ?? ''
    });
}
