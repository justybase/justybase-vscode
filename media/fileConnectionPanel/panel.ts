import type {
    FileConnectionPanelHostToWebviewMessage,
    FileConnectionPanelState,
    FileConnectionPanelWebviewToHostMessage,
} from './hostContracts.js';
import { asHostMessage, postToHost } from './protocol.js';

function sendToHost(message: FileConnectionPanelWebviewToHostMessage): void {
    postToHost(message);
}

const app = document.getElementById('app');
let currentState: FileConnectionPanelState | undefined;
let statusMessage = '';
let statusKind: 'info' | 'error' | 'success' = 'info';

const FORMAT_COLORS: Record<string, string> = {
    csv: '#1e88e5',
    external: '#8e24aa',
    parquet: '#f57c00',
};

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatIcon(format: string, size = 40): string {
    const color = FORMAT_COLORS[format] ?? '#607d8b';
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
        trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
        upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
        download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
        refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
        add: '<path d="M12 5v14M5 12h14"/>',
        sql: '<path d="M4 5l5 3-5 3zM9 8l6-3-6-3zM9 8l6 3-6 3zM15 8l5 3-5 3zM15 8l5-3-5-3z"/>',
    };
    const paths = icons[name] ?? icons.add;
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function connectionSelect(state: FileConnectionPanelState): string {
    const options = state.connections
        .map(name => `<option value="${escapeHtml(name)}"${name === state.selectedConnectionName ? ' selected' : ''}>${escapeHtml(name)}</option>`)
        .join('');
    const disabled = state.connections.length === 0 ? ' disabled' : '';
    return `<label class="connection-picker">
        <select id="connection-select"${disabled}>${options || '<option value="">No Data Workspace yet</option>'}</select>
        <button id="delete-connection" class="icon-btn danger" title="Delete Data Workspace"${state.selectedConnectionName ? '' : ' disabled'}>${smallIcon('trash')}</button>
    </label>`;
}

function modeBadge(state: FileConnectionPanelState): string {
    if (!state.selectedConnectionName) {
        return '<span class="mode-badge none">No workspace selected</span>';
    }
    return '<span class="mode-badge workspace" title="Persistent local DuckDB workspace">Data Workspace &middot; DuckDB</span>';
}

function renderWorkspaceSources(state: FileConnectionPanelState): string {
    const sources = state.workspaceSources ?? [];
    const rows = sources.map(source => {
        const refresh = source.lastRefresh ? ` &middot; ${escapeHtml(source.lastRefresh)}` : '';
        const count = source.rowCount === undefined ? '' : ` &middot; ${source.rowCount.toLocaleString()} rows`;
        const message = source.message ? `<div class="muted small-note">${escapeHtml(source.message)}</div>` : '';
        const iconFormat = source.kind === 'file' ? 'csv' : 'external';
        return `<li class="file-card">
            <div class="file-icon">${formatIcon(iconFormat)}</div>
            <div class="file-info"><div class="file-name-row"><span class="file-name">${escapeHtml(source.tableName)}</span><span class="file-format-badge">${escapeHtml(source.kind)}</span></div>
            <div class="file-meta">${escapeHtml(source.label)} &middot; ${escapeHtml(source.refreshStatus)}${count}${refresh}</div>${message}</div>
            <div class="file-actions"><button data-workspace-action="refresh" data-source-id="${escapeHtml(source.id)}" class="icon-btn" title="Refresh source">${smallIcon('refresh')}</button><button data-workspace-action="remove" data-source-id="${escapeHtml(source.id)}" class="icon-btn danger" title="Remove source and local table">${smallIcon('trash')}</button></div>
        </li>`;
    }).join('');
    const empty = '<p class="muted">Add a local file or a saved Netezza table, view, or read-only SELECT query. Each source becomes a real DuckDB table.</p>';
    return `<div class="workspace-actions"><span class="workspace-actions-title">Add source:</span><button id="add-workspace-file" class="tool-btn">${smallIcon('add')} Add local file</button><button id="add-netezza-source" class="primary">${smallIcon('add')} Add Netezza source</button><button id="query-workspace" class="tool-btn">${smallIcon('sql')} Open SQL</button></div>${sources.length ? `<ul class="file-list">${rows}</ul>` : empty}`;
}

function renderEmptyWorkspace(): string {
    return `<div class="empty-state">
        <div class="empty-icon">${formatIcon('external', 56)}</div>
        <h2>No Data Workspace yet</h2>
        <p class="muted">Create a persistent DuckDB workspace, then add one or more local files or Netezza sources.</p>
        <button id="new-data-workspace" class="primary">${smallIcon('add')} New Data Workspace</button>
    </div>`;
}

function render(): void {
    if (!app || !currentState) return;
    const state = currentState;
    const noConnection = !state.selectedConnectionName;
    const fileList = noConnection ? renderEmptyWorkspace() : renderWorkspaceSources(state);

    app.innerHTML = `<main class="file-connection-root">
        <header class="panel-header">
            <div class="panel-title"><div class="panel-icon">${formatIcon('external', 34)}</div><div><h1>Data Workspace Manager</h1><p class="muted">Persistent DuckDB: local files and materialized Netezza sources</p></div></div>
            <div class="panel-toolbar">
                <button id="new-data-workspace" class="tool-btn" title="Create a persistent local DuckDB Data Workspace">${smallIcon('add')} New Data Workspace</button>
                <button id="export-connections" class="tool-btn"${noConnection ? ' disabled' : ''} title="Export the selected Data Workspace definition">${smallIcon('download')} Export</button>
                <button id="import-connections" class="tool-btn" title="Import Data Workspace definitions from JSON">${smallIcon('upload')} Import</button>
                <button id="refresh-panel" class="icon-btn" title="Refresh">${smallIcon('refresh')}</button>
            </div>
        </header>
        ${statusMessage ? `<div class="status ${statusKind}">${escapeHtml(statusMessage)}</div>` : ''}
        <section class="card connection-section">
            ${connectionSelect(state)}
            <div class="mode-row">${modeBadge(state)}${state.notice ? `<span class="notice-text">${escapeHtml(state.notice)}</span>` : ''}</div>
        </section>
        <section class="card files-section">${fileList}</section>
    </main>`;
}

function showStatus(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    statusMessage = message;
    statusKind = kind;
    render();
}

document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const workspaceAction = target.closest<HTMLElement>('[data-workspace-action]');
    if (workspaceAction?.dataset.sourceId) {
        if (workspaceAction.dataset.workspaceAction === 'refresh') {
            sendToHost({ type: 'refreshWorkspaceSource', sourceId: workspaceAction.dataset.sourceId });
        } else if (workspaceAction.dataset.workspaceAction === 'remove') {
            sendToHost({ type: 'removeWorkspaceSource', sourceId: workspaceAction.dataset.sourceId });
        }
        return;
    }

    const control = target.closest<HTMLElement>(
        '#add-workspace-file, #add-netezza-source, #query-workspace, #new-data-workspace, #export-connections, #import-connections, #refresh-panel, #delete-connection',
    );
    if (!control) return;
    if (control.id === 'add-workspace-file') {
        sendToHost({ type: 'addWorkspaceFile' });
    } else if (control.id === 'add-netezza-source') {
        sendToHost({ type: 'addNetezzaSource' });
    } else if (control.id === 'query-workspace') {
        sendToHost({ type: 'queryWorkspace' });
    } else if (control.id === 'new-data-workspace') {
        sendToHost({ type: 'createDataWorkspace' });
    } else if (control.id === 'export-connections') {
        sendToHost({ type: 'exportConnections' });
    } else if (control.id === 'import-connections') {
        sendToHost({ type: 'importConnections' });
    } else if (control.id === 'refresh-panel') {
        sendToHost({ type: 'refresh' });
    } else if (control.id === 'delete-connection') {
        sendToHost({ type: 'deleteConnection' });
    }
});

document.addEventListener('change', event => {
    const target = event.target as HTMLElement | null;
    if (target?.id === 'connection-select') {
        sendToHost({ type: 'selectConnection', connectionName: (target as HTMLSelectElement).value });
    }
});

window.addEventListener('message', event => {
    const message = asHostMessage(event.data) as FileConnectionPanelHostToWebviewMessage;
    switch (message.type) {
        case 'state':
            currentState = message.state;
            if (message.state.notice) {
                statusMessage = message.state.notice;
                statusKind = 'info';
            } else if (statusKind !== 'error') {
                statusMessage = '';
            }
            break;
        case 'error':
            showStatus(message.message, 'error');
            return;
        case 'notice':
            showStatus(message.message, 'success');
            return;
        default:
            return;
    }
    render();
});

sendToHost({ type: 'ready' });
