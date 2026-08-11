import type {
    FileConnectionPanelFile,
    FileConnectionPanelHostToWebviewMessage,
    FileConnectionPanelState,
    FileConnectionPanelWebviewToHostMessage,
} from './hostContracts.js';
import { asHostMessage, postToHost } from './protocol.js';

const app = document.getElementById('app');
let currentState: FileConnectionPanelState | undefined;
let statusMessage = '';
let statusKind: 'info' | 'error' | 'success' = 'info';
let sheetsByPath: Record<string, string[] | 'loading'> = {};
let dragActive = false;

const FORMAT_COLORS: Record<string, string> = {
    xlsx: '#43a047',
    csv: '#1e88e5',
    tsv: '#00897b',
    parquet: '#f57c00',
    avro: '#8e24aa',
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatIcon(format: string | undefined, size = 40): string {
    const color = FORMAT_COLORS[format ?? ''] ?? '#607d8b';
    return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <rect x="6" y="6" width="52" height="52" rx="12" fill="${color}"/>
        <path d="M19 13h19l9 9v26a4 4 0 0 1-4 4H19a4 4 0 0 1-4-4V17a4 4 0 0 1 4-4z" fill="#fff" opacity=".95"/>
        <path d="M38 13v10h9" fill="#e8f5e9"/>
        <path d="M23 30h18M23 37h18M23 44h18" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M29 30v14M35 30v14" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>
    </svg>`;
}

function smallIcon(name: string): string {
    const icons: Record<string, string> = {
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        sql: '<path d="M4 5l5 3-5 3zM9 8l6-3-6-3zM9 8l6 3-6 3zM15 8l5 3-5 3zM15 8l5-3-5-3z"/>',
        trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
        upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
        download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
        refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
        add: '<path d="M12 5v14M5 12h14"/>',
        close: '<path d="M6 6l12 12M18 6L6 18"/>',
        folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    };
    const paths = icons[name] ?? icons.file;
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const FORMAT_LABELS: Record<string, string> = {
    xlsx: 'Excel',
    csv: 'CSV',
    tsv: 'TSV',
    parquet: 'Parquet',
    avro: 'Avro',
};

function formatLabel(format: string | undefined): string {
    return format ? (FORMAT_LABELS[format] ?? 'File') : 'File';
}

function connectionSelect(state: FileConnectionPanelState): string {
    const options = state.connections
        .map(name => `<option value="${escapeHtml(name)}"${name === state.selectedConnectionName ? ' selected' : ''}>${escapeHtml(name)}</option>`)
        .join('');
    return `<label class="connection-picker">
        <select id="connection-select">${options}</select>
        <button id="delete-connection" class="icon-btn danger" title="Delete connection profile">${smallIcon('trash')}</button>
    </label>`;
}

function modeBadge(state: FileConnectionPanelState): string {
    if (!state.selectedConnectionName) {
        return '<span class="mode-badge none">No connection selected</span>';
    }
    if (state.mode === 'workspace') {
        return '<span class="mode-badge workspace" title="Multi-file workspaces are read-only">Workspace &middot; read-only</span>';
    }
    if (state.mode === 'single') {
        const editable = state.editable ? ' &middot; editable copy' : '';
        return `<span class="mode-badge single">Single file${editable}</span>`;
    }
    return '';
}

function renderFileActions(file: FileConnectionPanelFile): string {
    const buttons = [
        `<button data-action="preview" data-path="${escapeHtml(file.path)}" class="icon-btn" title="Preview sample data">${smallIcon('eye')}</button>`,
    ];
    if (file.format === 'xlsx') {
        buttons.push(`<button data-action="sheets" data-path="${escapeHtml(file.path)}" class="icon-btn" title="List Excel sheets">${smallIcon('grid')}</button>`);
    }
    buttons.push(
        `<button data-action="query" data-path="${escapeHtml(file.path)}" class="icon-btn" title="Query with SQL">${smallIcon('sql')}</button>`,
        `<button data-action="remove" data-path="${escapeHtml(file.path)}" class="icon-btn danger" title="Remove from connection">${smallIcon('trash')}</button>`,
    );
    return buttons.join('');
}

function renderSheets(path: string): string {
    const sheets = sheetsByPath[path];
    if (!sheets || sheets === 'loading') {
        return '';
    }
    if (sheets.length === 0) {
        return '<div class="sheet-chips"><span class="muted">No worksheets found.</span></div>';
    }
    const chips = sheets
        .map(sheet => `<span class="sheet-chip" data-path="${escapeHtml(path)}" data-sheet="${escapeHtml(sheet)}">${escapeHtml(sheet)}</span>`)
        .join('');
    return `<div class="sheet-chips">${chips}</div>`;
}

function renderFileCard(file: FileConnectionPanelFile, index: number): string {
    const missing = !file.exists ? '<span class="missing-badge">File not found</span>' : '';
    const size = file.sizeLabel ? `<span class="file-size">${escapeHtml(file.sizeLabel)}</span>` : '';
    return `<li class="file-card" data-index="${index}">
        <div class="file-icon">${formatIcon(file.format)}</div>
        <div class="file-info">
            <div class="file-name-row"><span class="file-name">${escapeHtml(file.name)}</span>${missing}<span class="file-format-badge">${escapeHtml(formatLabel(file.format))}</span></div>
            <div class="file-meta"><span class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>${size}</div>
            ${renderSheets(file.path)}
        </div>
        <div class="file-actions">${renderFileActions(file)}</div>
    </li>`;
}

function renderEmptyState(): string {
    return `<div class="empty-state">
        <div class="empty-icon">${formatIcon('xlsx', 56)}</div>
        <h2>No files in this connection yet</h2>
        <p class="muted">Drop Excel, CSV, TSV, Parquet or Avro files here,<br/>or use the buttons below to add them.</p>
        <button id="add-files" class="primary">${smallIcon('add')} Add files</button>
    </div>`;
}

function render(): void {
    if (!app || !currentState) return;
    const state = currentState;
    const noConnection = !state.selectedConnectionName;
    const dropZone = noConnection
        ? ''
        : `<div id="drop-zone" class="drop-zone${dragActive ? ' active' : ''}">
            ${smallIcon('upload')}<span>Drag &amp; drop data files here, or click to browse</span>
        </div>`;
    const editableToggle = state.mode === 'single'
        ? `<label class="checkbox"><input id="editable-toggle" type="checkbox"${state.editable ? ' checked' : ''} /> Editable copy (INSERT/UPDATE/DELETE on <code>_edit</code> table)</label>`
        : state.mode === 'workspace'
            ? '<p class="muted small-note">Multi-file workspaces are read-only. Remove files to switch back to a single editable file.</p>'
            : '';
    const fileList = noConnection
        ? '<p class="muted">Select a File SQL connection from the dropdown above to manage its data files.</p>'
        : state.files.length === 0
            ? renderEmptyState()
            : `<ul class="file-list">${state.files.map((file, index) => renderFileCard(file, index)).join('')}</ul>`;

    app.innerHTML = `<main class="file-connection-root">
        <header class="panel-header">
            <div class="panel-title"><div class="panel-icon">${formatIcon('csv', 34)}</div><div><h1>File Connection Manager</h1><p class="muted">Excel &middot; CSV/TSV &middot; Parquet &middot; Avro</p></div></div>
            <div class="panel-toolbar">
                <button id="export-connections" class="tool-btn"${noConnection ? ' disabled' : ''} title="Export the selected connection profile">${smallIcon('download')} Export</button>
                <button id="import-connections" class="tool-btn" title="Import connection profiles from JSON">${smallIcon('upload')} Import</button>
                <button id="refresh-panel" class="icon-btn" title="Refresh">${smallIcon('refresh')}</button>
            </div>
        </header>
        ${statusMessage ? `<div class="status ${statusKind}">${escapeHtml(statusMessage)}</div>` : ''}
        <section class="card connection-section">
            ${connectionSelect(state)}
            <div class="mode-row">${modeBadge(state)}${state.notice ? `<span class="notice-text">${escapeHtml(state.notice)}</span>` : ''}</div>
        </section>
        ${dropZone}
        <section class="card files-section">
            ${fileList}
        </section>
        <section class="card options-section">${editableToggle}</section>
    </main>`;
}

function showStatus(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    statusMessage = message;
    statusKind = kind;
    render();
}


function droppedFileNames(event: DragEvent): string[] {
    // VS Code and the OS expose the actual local path through text/uri-list.
    // Prefer it over File.name, which contains only a basename and is
    // ambiguous for duplicate names or files outside the workspace.
    const uriList = event.dataTransfer?.getData('text/uri-list') ?? '';
    const paths = uriList
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
    if (paths.length > 0) {
        return paths;
    }

    const names: string[] = [];
    const items = event.dataTransfer?.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file?.name) {
                    names.push(file.name);
                }
            }
        }
    }
    return names;
}

function setDragActive(active: boolean): void {
    dragActive = active;
    const zone = document.getElementById('drop-zone');
    if (zone) {
        zone.classList.toggle('active', active);
    }
}

document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    // File card actions (Preview / Sheets / SQL / Remove). Resolve from the
    // closest element so clicks landing on the inline SVG icon still work.
    const actionElement = target.closest<HTMLElement>('[data-action]');
    if (actionElement) {
        const action = actionElement.dataset.action;
        const path = actionElement.dataset.path;
        if (!action || !path) {
            return;
        }
        if (action === 'preview') {
            postToHost({ type: 'previewFile', path });
        } else if (action === 'query') {
            postToHost({ type: 'queryFile', path });
        } else if (action === 'remove') {
            postToHost({ type: 'removeFile', path });
        } else if (action === 'sheets') {
            if (sheetsByPath[path] === undefined) {
                sheetsByPath[path] = 'loading';
                postToHost({ type: 'requestSheets', path });
                render();
            } else {
                delete sheetsByPath[path];
                render();
            }
        }
        return;
    }

    // Excel sheet chips open the workbook preview.
    const sheetElement = target.closest<HTMLElement>('[data-sheet]');
    if (sheetElement && sheetElement.dataset.path) {
        postToHost({ type: 'previewFile', path: sheetElement.dataset.path });
        return;
    }

    // Toolbar buttons and the drop zone (click-to-browse).
    const control = target.closest<HTMLElement>(
        '#add-files, #export-connections, #import-connections, #refresh-panel, #delete-connection, #drop-zone',
    );
    if (!control) {
        return;
    }
    if (control.id === 'add-files' || control.id === 'drop-zone') {
        postToHost({ type: 'addFiles', paths: [] });
    } else if (control.id === 'export-connections') {
        postToHost({ type: 'exportConnections' });
    } else if (control.id === 'import-connections') {
        postToHost({ type: 'importConnections' });
    } else if (control.id === 'refresh-panel') {
        postToHost({ type: 'refresh' });
    } else if (control.id === 'delete-connection') {
        postToHost({ type: 'deleteConnection' });
    }
});

document.addEventListener('change', event => {
    const target = event.target as HTMLElement | null;
    if (target?.id === 'connection-select') {
        const select = target as HTMLSelectElement;
        postToHost({ type: 'selectConnection', connectionName: select.value });
    } else if (target?.id === 'editable-toggle') {
        const checkbox = target as HTMLInputElement;
        postToHost({ type: 'setEditable', enabled: checkbox.checked });
    }
});

let dragDepth = 0;

document.addEventListener('dragenter', event => {
    if (event.target instanceof Element && event.target.closest('#drop-zone')) {
        dragDepth += 1;
        setDragActive(true);
    }
});

document.addEventListener('dragover', event => {
    if (event.target instanceof Element && event.target.closest('#drop-zone')) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    }
});

document.addEventListener('dragleave', event => {
    if (event.target instanceof Element && event.target.closest('#drop-zone')) {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            setDragActive(false);
        }
    }
});

document.addEventListener('drop', event => {
    if (!(event.target instanceof Element) || !event.target.closest('#drop-zone')) {
        return;
    }
    event.preventDefault();
    dragDepth = 0;
    setDragActive(false);
    const names = droppedFileNames(event);
    if (names.length === 0) {
        showStatus('Dropped files could not be read. Use "Add files" to pick them manually.', 'error');
        return;
    }
    postToHost({ type: 'resolveDroppedNames', names });
});

window.addEventListener('message', event => {
    const message = asHostMessage(event.data) as FileConnectionPanelHostToWebviewMessage;
    switch (message.type) {
        case 'state':
            currentState = message.state;
            sheetsByPath = {};
            if (message.state.notice) {
                statusMessage = message.state.notice;
                statusKind = 'info';
            } else if (!statusMessage) {
                statusMessage = '';
            }
            break;
        case 'sheets':
            sheetsByPath[message.path] = message.sheetNames;
            statusMessage = '';
            break;
        case 'error':
            statusMessage = message.message;
            statusKind = 'error';
            break;
        case 'notice':
            statusMessage = message.message;
            statusKind = 'success';
            break;
        default:
            return;
    }
    render();
});

postToHost({ type: 'ready' });
