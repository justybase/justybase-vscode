/**
 * Edit Data panel webview: wires the host protocol to the data grid, the
 * Structure tab and the DDL tab.
 */
import type {
    EditDataLoadInfo,
    EditDataMetadata,
    EditDataPanelHostToWebviewMessage,
    EditDataPanelWebviewToHostMessage,
    EditDataRow,
} from './hostContracts.js';
import { postToHost, asHostMessage } from './protocol.js';
import { getElementById } from './dom.js';
import { escapeHtml, formatCount } from './utils.js';
import { DataGrid } from './grid.js';
import {
    type EditorState,
    type GridColumn,
    buildChanges,
    buildValuePredicate,
    createState,
    hasPendingChanges,
    revertAll,
    summarizeChanges,
} from './state.js';
import { confirmDialog, isDialogOpen, showDialog } from './dialog.js';
import { renderStructure } from './structure.js';
import { renderCodeBlock } from './sqlHighlight.js';

type HostMessage = EditDataPanelHostToWebviewMessage;
type WebviewMessage = EditDataPanelWebviewToHostMessage;

let editorState: EditorState = createState([], []);
let metadata: EditDataMetadata | null = null;
let loadInfo: EditDataLoadInfo | null = null;
let grid: DataGrid | null = null;
let loading = false;
let ddlText: string | null = null;
let ddlRequested = false;
let pendingPreview: ((statements: string[], error?: string) => void) | null = null;
/** Filters the current grid was loaded with (inputs may have been edited since). */
let appliedFilter = { whereClause: '', orderBy: '', columns: '' };

const post = (message: WebviewMessage) => postToHost(message);

window.addEventListener('message', event => {
    const message: HostMessage = asHostMessage(event.data);
    switch (message.command) {
        case 'setData':
            initData(message.data, message.columns, message.metadata, message.info);
            break;
        case 'setLoading':
            setLoading(message.loading, message.message);
            break;
        case 'setError':
            showError(message.text);
            break;
        case 'saveFailed':
            setLoading(false);
            showError(`Changes were not saved: ${message.text}`);
            break;
        case 'sqlPreview':
            pendingPreview?.(message.statements, message.error);
            pendingPreview = null;
            break;
        case 'setDdl':
            ddlText = message.ddl ?? null;
            renderDdl(message.ddl, message.error);
            break;
    }
});

function readFilter() {
    return {
        whereClause: getElementById<HTMLInputElement>('filterWhere')?.value.trim() ?? '',
        orderBy: getElementById<HTMLInputElement>('filterOrderBy')?.value.trim() ?? '',
        columns: getElementById<HTMLInputElement>('filterColumns')?.value.trim() ?? '',
    };
}

async function confirmDiscard(action: string): Promise<boolean> {
    if (!hasPendingChanges(editorState)) return true;
    const summary = summarizeChanges(editorState);
    return confirmDialog({
        title: 'Discard pending changes?',
        message: `${summary.total} pending change${summary.total === 1 ? '' : 's'} will be lost if you ${action}.`,
        confirmLabel: 'Discard changes',
        danger: true,
    });
}

async function refresh(): Promise<void> {
    if (loading) return;
    if (!(await confirmDiscard('reload the data'))) return;
    post({ command: 'refresh', ...readFilter() });
}

function submit(): void {
    if (loading) return;
    grid?.commitEdit();
    if (!hasPendingChanges(editorState)) {
        post({ command: 'info', text: 'No changes to save.' });
        return;
    }
    hideError();
    setLoading(true, 'Saving changes…');
    post({ command: 'save', changes: buildChanges(editorState), ...appliedFilter });
}

async function previewSql(): Promise<void> {
    grid?.commitEdit();
    if (!hasPendingChanges(editorState)) {
        post({ command: 'info', text: 'No pending changes to preview.' });
        return;
    }
    const result = await new Promise<{ statements: string[]; error?: string }>(resolve => {
        pendingPreview = (statements, error) => resolve({ statements, error });
        post({ command: 'previewSql', changes: buildChanges(editorState) });
    });
    if (result.error) {
        showError(result.error);
        return;
    }
    const sql = ['BEGIN;', ...result.statements.map(s => `${s};`), 'COMMIT;'].join('\n');
    const choice = await showDialog({
        title: `Pending changes · ${result.statements.length} statement${result.statements.length === 1 ? '' : 's'}`,
        bodyHtml: `<p class="dialog__message">Submit runs these statements in a single transaction on <strong>${escapeHtml(loadInfo?.connectionName ?? '')}</strong>.</p>${renderCodeBlock(sql)}`,
        buttons: [
            { id: 'copy', label: 'Copy' },
            { id: 'open', label: 'Open in editor' },
            { id: 'cancel', label: 'Close' },
            { id: 'submit', label: 'Submit', kind: 'primary' },
        ],
        cancelId: 'cancel',
        wide: true,
    });
    if (choice === 'copy') post({ command: 'copyText', text: sql });
    else if (choice === 'open') post({ command: 'openSqlInEditor', sql });
    else if (choice === 'submit') submit();
}

async function revertAllChanges(): Promise<void> {
    if (!hasPendingChanges(editorState)) return;
    const ok = await confirmDialog({
        title: 'Revert all pending changes?',
        message: 'Edited values, inserted rows and deletions that have not been submitted will be discarded.',
        confirmLabel: 'Revert all',
        danger: true,
    });
    if (!ok) return;
    revertAll(editorState);
    grid?.setState(editorState);
    updateChrome();
}

async function closePanel(): Promise<void> {
    if (!(await confirmDiscard('close the editor'))) return;
    post({ command: 'closePanel' });
}

function applyFilterFromValue(column: GridColumn, value: unknown): void {
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name) ? column.name : `"${column.name.replace(/"/g, '""')}"`;
    const predicate = buildValuePredicate(column, value, identifier);
    const where = getElementById<HTMLInputElement>('filterWhere');
    if (!where) return;
    const current = where.value.trim();
    where.value = current ? `(${current}) AND ${predicate}` : predicate;
    void refresh();
}

async function openValueEditor(column: GridColumn, value: unknown): Promise<string | null | undefined> {
    const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    let textarea: HTMLTextAreaElement | null = null;
    const choice = await showDialog({
        title: `${column.name}${column.type ? ` · ${column.type}` : ''}`,
        bodyHtml: `<textarea class="value-editor" spellcheck="false" ${column.readonly ? 'readonly' : ''}>${escapeHtml(text)}</textarea>`,
        buttons: column.readonly
            ? [{ id: 'cancel', label: 'Close' }]
            : [
                { id: 'null', label: 'Set NULL' },
                { id: 'cancel', label: 'Cancel' },
                { id: 'apply', label: 'Apply', kind: 'primary' },
            ],
        cancelId: 'cancel',
        wide: true,
        onRender: root => {
            textarea = root.querySelector('textarea');
            setTimeout(() => textarea?.focus(), 0);
            textarea?.addEventListener('keydown', event => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    root.querySelector<HTMLButtonElement>('[data-dialog-button="apply"]')?.click();
                }
            });
        },
    });
    if (choice === 'apply') return (textarea as HTMLTextAreaElement | null)?.value ?? text;
    if (choice === 'null') return null;
    return undefined;
}

document.addEventListener('DOMContentLoaded', () => {
    const container = getElementById('gridContainer');
    if (container) {
        grid = new DataGrid(container, {
            onChange: updateChrome,
            onSelectionChange: updateSelectionStatus,
            onFilterByValue: applyFilterFromValue,
            onOpenValueEditor: openValueEditor,
            copyText: text => post({ command: 'copyText', text }),
        });
    }

    const on = (id: string, handler: () => void) => getElementById(id)?.addEventListener('click', handler);
    on('refreshBtn', () => void refresh());
    on('saveBtn', submit);
    on('addRowBtn', () => grid?.addRow());
    on('duplicateRowBtn', () => grid?.duplicateSelected());
    on('deleteRowBtn', () => grid?.deleteSelected());
    on('revertBtn', () => void revertAllChanges());
    on('previewSqlBtn', () => void previewSql());
    on('closeBtn', () => void closePanel());
    on('clearFilterBtn', () => {
        ['filterWhere', 'filterOrderBy', 'filterColumns'].forEach(id => {
            const input = getElementById<HTMLInputElement>(id);
            if (input) input.value = '';
        });
        void refresh();
    });
    on('ddlRefreshBtn', () => requestDdl(true));
    on('ddlCopyBtn', () => { if (ddlText) post({ command: 'copyText', text: ddlText }); });
    on('ddlOpenBtn', () => { if (ddlText) post({ command: 'openSqlInEditor', sql: ddlText }); });

    ['filterWhere', 'filterOrderBy', 'filterColumns'].forEach(id => {
        const input = getElementById<HTMLInputElement>(id);
        input?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void refresh();
            } else if (event.key === 'Escape') {
                input.value = appliedFilter[id === 'filterWhere' ? 'whereClause' : id === 'filterOrderBy' ? 'orderBy' : 'columns'];
                updateFilterState();
                grid?.focus();
            }
        });
        input?.addEventListener('input', updateFilterState);
    });

    document.querySelectorAll<HTMLElement>('.tab').forEach(tab => {
        tab.addEventListener('click', () => setActiveTab(tab.dataset.target));
    });

    document.addEventListener('keydown', event => {
        if (isDialogOpen()) return;
        const ctrl = event.ctrlKey || event.metaKey;
        const inDataTab = getElementById('tab-data')?.classList.contains('active');
        if (event.key === 'F5') {
            event.preventDefault();
            if (inDataTab) void refresh();
            else if (getElementById('tab-ddl')?.classList.contains('active')) requestDdl(true);
        } else if (ctrl && (event.key === 's' || event.key === 'S') && inDataTab) {
            event.preventDefault();
            submit();
        } else if (event.altKey && event.key === 'Insert' && inDataTab) {
            event.preventDefault();
            grid?.addRow();
        } else if (ctrl && !event.altKey && (event.key === 'd' || event.key === 'D') && inDataTab) {
            event.preventDefault();
            grid?.duplicateSelected();
        }
    });

    updateChrome();
});

function setActiveTab(tabId: string | undefined): void {
    if (!tabId) return;
    document.querySelectorAll<HTMLElement>('.tab').forEach(tab => {
        const active = tab.dataset.target === tabId;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll<HTMLElement>('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === tabId);
    });
    if (tabId === 'tab-ddl') requestDdl(false);
    if (tabId === 'tab-data') grid?.focus();
}

function requestDdl(force: boolean): void {
    if (ddlRequested && !force) return;
    ddlRequested = true;
    const content = getElementById('ddlContent');
    if (content) content.innerHTML = '<div class="empty-state"><span class="spinner"></span>Generating DDL…</div>';
    post({ command: 'requestDdl' });
}

function renderDdl(ddl: string | undefined, error: string | undefined): void {
    const content = getElementById('ddlContent');
    if (!content) return;
    (['ddlCopyBtn', 'ddlOpenBtn'] as const).forEach(id => {
        const button = getElementById<HTMLButtonElement>(id);
        if (button) button.disabled = !ddl;
    });
    if (error || !ddl) {
        content.innerHTML = `<div class="empty-state empty-state--error">${escapeHtml(error || 'DDL is not available.')}</div>`;
        return;
    }
    content.innerHTML = renderCodeBlock(ddl.trim());
}

function setLoading(isLoading: boolean, message?: string): void {
    loading = isLoading;
    document.body.classList.toggle('is-loading', isLoading);
    const status = getElementById('status');
    if (status) {
        status.innerHTML = isLoading ? `<span class="spinner"></span>${escapeHtml(message || 'Loading…')}` : '';
    }
    updateChrome();
}

function showError(message: string): void {
    const banner = getElementById('errorBanner');
    if (!banner) return;
    banner.innerHTML = `<span class="error-banner__text">${escapeHtml(message)}</span><button type="button" class="icon-only ghost" title="Dismiss"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>`;
    banner.hidden = false;
    banner.querySelector('button')?.addEventListener('click', hideError);
}

function hideError(): void {
    const banner = getElementById('errorBanner');
    if (banner) {
        banner.hidden = true;
        banner.innerHTML = '';
    }
}

function initData(
    data: EditDataRow[],
    columns: string[],
    nextMetadata: EditDataMetadata | null,
    info: EditDataLoadInfo | undefined,
): void {
    metadata = nextMetadata;
    loadInfo = info ?? loadInfo;
    appliedFilter = readFilter();
    editorState = createState(data || [], columns || [], metadata?.columns);
    hideError();

    const hasFilter = Boolean(appliedFilter.whereClause);
    grid?.setState(editorState, hasFilter
        ? 'No rows match the WHERE filter.'
        : 'This table is empty. Use Add row (Alt+Insert) to insert one.');

    const structure = getElementById('metadataContent');
    if (structure) {
        renderStructure(structure, metadata, post, showError);
    }
    updateFilterState();
    updateChrome();
}

function updateFilterState(): void {
    const current = readFilter();
    const hasAny = Boolean(current.whereClause || current.orderBy || current.columns
        || appliedFilter.whereClause || appliedFilter.orderBy || appliedFilter.columns);
    const clear = getElementById('clearFilterBtn');
    if (clear) clear.hidden = !hasAny;
    const fields: [string, keyof typeof current][] = [
        ['filterWhere', 'whereClause'], ['filterOrderBy', 'orderBy'], ['filterColumns', 'columns'],
    ];
    fields.forEach(([id, key]) => {
        const input = getElementById<HTMLInputElement>(id);
        const field = input?.closest('.filter-field');
        field?.classList.toggle('is-dirty', current[key] !== appliedFilter[key]);
        field?.classList.toggle('is-applied', Boolean(appliedFilter[key]) && current[key] === appliedFilter[key]);
    });
}

function setDisabled(id: string, disabled: boolean): void {
    const button = getElementById<HTMLButtonElement>(id);
    if (button) button.disabled = disabled;
}

function updateChrome(): void {
    const summary = summarizeChanges(editorState);
    const pending = summary.total > 0;
    const hasRows = (grid?.rowCount() ?? 0) > 0;
    const hasColumns = editorState.columns.some(c => !c.readonly);

    setDisabled('refreshBtn', loading);
    setDisabled('addRowBtn', loading || !hasColumns);
    setDisabled('duplicateRowBtn', loading || !hasRows);
    setDisabled('deleteRowBtn', loading || !hasRows);
    setDisabled('revertBtn', loading || !pending);
    setDisabled('previewSqlBtn', loading || !pending);
    setDisabled('saveBtn', loading || !pending);

    const badge = getElementById('pendingCount');
    if (badge) {
        badge.hidden = !pending;
        badge.textContent = String(summary.total);
    }
    document.body.classList.toggle('has-pending', pending);

    const left = getElementById('statusLeft');
    if (left) {
        const loaded = editorState.loadOrder.length - summary.inserted;
        const parts: string[] = [`<strong>${formatCount(loaded)}</strong> row${loaded === 1 ? '' : 's'}`];
        if (loadInfo && loaded >= loadInfo.rowLimit) {
            parts.push(`<span class="status-warn" title="Only the first ${formatCount(loadInfo.rowLimit)} rows are loaded. Narrow the WHERE filter to reach the rest.">limit ${formatCount(loadInfo.rowLimit)} reached</span>`);
        }
        if (loadInfo) parts.push(`${formatCount(loadInfo.elapsedMs)} ms`);
        if (editorState.sort) parts.push(`sorted by ${escapeHtml(editorState.sort.column)} ${editorState.sort.direction === 'asc' ? '▲' : '▼'} (loaded rows)`);
        if (pending) {
            const chips: string[] = [];
            if (summary.modifiedRows) chips.push(`<span class="chip chip--modified">${summary.modifiedRows} updated</span>`);
            if (summary.inserted) chips.push(`<span class="chip chip--new">${summary.inserted} inserted</span>`);
            if (summary.deleted) chips.push(`<span class="chip chip--deleted">${summary.deleted} deleted</span>`);
            parts.push(chips.join(''));
        }
        left.innerHTML = parts.join('<span class="sep">·</span>');
    }
    updateSelectionStatus();
}

function updateSelectionStatus(): void {
    const right = getElementById('statusRight');
    if (right) right.innerHTML = grid?.describeActive() ?? '';
    const hasSelection = (grid?.getSelectedKeys().length ?? 0) > 0;
    setDisabled('duplicateRowBtn', loading || !hasSelection);
    setDisabled('deleteRowBtn', loading || !hasSelection);
}
