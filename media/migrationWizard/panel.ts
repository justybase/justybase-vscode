import type {
    MigrationWizardAnalysisState,
    MigrationWizardCatalogTable,
    MigrationWizardHostToWebviewMessage,
    MigrationWizardProgressState,
    MigrationWizardSourceState,
    MigrationWizardState,
    MigrationWizardTargetState,
} from './hostContracts.js';
import { asHostMessage, postToHost } from './protocol.js';
import { getMigrationWizardTargetDatabase } from './targetDefaults.js';
import { escapeHtml } from './utils.js';

const app = document.getElementById('app');
let currentState: MigrationWizardState | undefined;
let statusMessage = '';
let statusKind: 'info' | 'error' | 'success' = 'info';
let lastExecutionSucceeded = false;
let targetAnalyzeTimer: ReturnType<typeof setTimeout> | undefined;

function selected(value: string | undefined, candidate: string): string {
    return value === candidate ? ' selected' : '';
}

function connectionOptions(connections: MigrationWizardState['connections'], current: string): string {
    return connections
        .map(connection => `<option value="${escapeHtml(connection.name)}"${selected(current, connection.name)}>${escapeHtml(connection.name)} (${escapeHtml(connection.kind)})</option>`)
        .join('');
}

function optionList(values: readonly string[]): string {
    return values
        .map(value => `<option value="${escapeHtml(value)}"></option>`)
        .join('');
}

function tableOptions(tables: readonly MigrationWizardCatalogTable[], schemaFilter: string): string {
    const filter = schemaFilter.trim().toUpperCase();
    return tables
        .filter(table => !filter || table.schema.toUpperCase() === filter)
        .map(table => `<option value="${escapeHtml(table.name)}" label="${escapeHtml(`${table.schema}.${table.name}`)}"></option>`)
        .join('');
}

function syncTableDatalist(): void {
    const state = currentState;
    const list = document.getElementById('source-tables');
    if (!list || !state) return;
    const schemaValue = (document.getElementById('source-schema') as HTMLInputElement | null)?.value || '';
    list.innerHTML = tableOptions(state.catalog?.tables ?? [], schemaValue);
}

function renderSource(source: MigrationWizardSourceState, state: MigrationWizardState): string {
    const catalog = state.catalog;
    const tableFields = source.mode === 'table'
        ? `<div class="field-grid">
            <label>Database<input id="source-database" list="source-databases" value="${escapeHtml(source.database)}" /><datalist id="source-databases">${optionList(catalog?.databases ?? [])}</datalist></label>
            <label>Schema<input id="source-schema" list="source-schemas" value="${escapeHtml(source.schema)}" /><datalist id="source-schemas">${optionList(catalog?.schemas ?? [])}</datalist></label>
            <label class="wide">Table<input id="source-table" list="source-tables" value="${escapeHtml(source.table)}" /><datalist id="source-tables">${tableOptions(catalog?.tables ?? [], source.schema ?? '')}</datalist></label>
        </div>
        ${catalog && !catalog.loaded ? '<p class="catalog-hint">Schema metadata is not loaded yet. Expand the schema tree in the sidebar for this connection, or type the names manually.</p>' : ''}`
        : `<label>SQL query<textarea id="source-sql" rows="8">${escapeHtml(source.sql)}</textarea></label>`;

    return `<section class="card">
        <div class="section-heading"><h2><span class="step-badge">1</span>Source</h2><div class="segmented">
            <button data-source-mode="table" class="${source.mode === 'table' ? 'active' : ''}">Table</button>
            <button data-source-mode="sql" class="${source.mode === 'sql' ? 'active' : ''}">SQL query</button>
        </div></div>
        <label>Connection<select id="source-connection">${connectionOptions(state.connections, source.connectionName)}</select></label>
        ${tableFields}
    </section>`;
}

function renderTarget(target: MigrationWizardTargetState, state: MigrationWizardState): string {
    return `<section class="card">
        <div class="section-heading"><h2><span class="step-badge">2</span>Target</h2><span class="row-count"></span></div>
        <label>Connection<select id="target-connection">${connectionOptions(state.connections, target.connectionName)}</select></label>
        <div class="field-grid">
            <label>Database<input id="target-database" value="${escapeHtml(target.database)}" /></label>
            <label>Schema<input id="target-schema" value="${escapeHtml(target.schema)}" /></label>
            <label class="wide">Table<input id="target-table" value="${escapeHtml(target.table)}" /></label>
        </div>
        <label class="checkbox"><input id="append-target" type="checkbox"${target.appendToExistingTable ? ' checked' : ''} /> Append to existing table</label>
    </section>`;
}

function renderAnalysis(analysis: MigrationWizardAnalysisState | undefined, state: MigrationWizardState): string {
    if (!analysis) {
        return `<section class="card empty-state plan-card"><div class="section-heading"><h2><span class="step-badge">3</span>Plan</h2></div><p class="muted">Analyze the source to preview the target DDL. Row counting is optional.</p></section>`;
    }

    const columns = analysis.columns.map(column => `<tr>
        <td>${escapeHtml(column.sourceName)}</td><td>${escapeHtml(column.sourceType)}</td>
        <td>${escapeHtml(column.targetName)}</td><td><span class="type-badge">${escapeHtml(column.targetTypeDisplay)}</span></td>
        <td>${column.isPk ? '<span class="constraint-chip pk">PK</span>' : ''}${column.notNull ? '<span class="constraint-chip notnull">NOT NULL</span>' : ''}</td>
    </tr>`).join('');
    const warnings = analysis.warnings.length > 0
        ? `<ul class="warnings">${analysis.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
        : '<p class="muted success-note">&#10003; No type translation warnings.</p>';

    const countButtonDisabled = state.executing || state.counting ? ' disabled' : '';
    const rowCountLabel = analysis.totalRows === undefined ? 'count not requested' : `${analysis.totalRows.toLocaleString()} rows`;
    return `<section class="card plan-card">
        <div class="section-heading"><h2><span class="step-badge">3</span>Plan</h2><div><span class="row-count">${rowCountLabel}</span><button id="count-rows"${countButtonDisabled}>Count rows</button></div></div>
        <p class="muted">${escapeHtml(analysis.sourceKind)} &rarr; ${escapeHtml(analysis.targetKind)} &middot; <code>${escapeHtml(analysis.targetQualifiedName)}</code></p>
        <table><thead><tr><th>Source</th><th>Type</th><th>Target</th><th>Rendered type</th><th>Constraints</th></tr></thead><tbody>${columns}</tbody></table>
        <details open><summary>CREATE TABLE DDL <small class="muted">(editable &mdash; adjust types; column names must stay unchanged)</small></summary><textarea id="create-table-ddl" rows="14" spellcheck="false">${escapeHtml(analysis.createTableDdl)}</textarea></details>
        <h3>Warnings</h3>${warnings}
    </section>`;
}

function renderProgress(state: MigrationWizardState): string {
    const progress = state.progress;
    if (!progress) return '';
    return `<section class="progress card"><div class="section-heading"><strong data-progress-phase>${escapeHtml(progress.phase)}</strong><span data-progress-percent>${progress.percent}%</span></div>
        <div class="progress-track"><div data-progress-bar style="width:${Math.max(0, Math.min(100, progress.percent))}%"></div></div>
        <p data-progress-message>${escapeHtml(progress.message)}</p><small data-progress-rows>${progress.rowsRead.toLocaleString()}${progress.totalRows === undefined ? '' : ` / ${progress.totalRows.toLocaleString()}`} rows</small>
    </section>`;
}

function updateProgressDom(progress: MigrationWizardProgressState): boolean {
    const section = app?.querySelector<HTMLElement>('.progress');
    if (!section) return false;

    const percent = Math.max(0, Math.min(100, progress.percent));
    const phase = section.querySelector<HTMLElement>('[data-progress-phase]');
    const percentLabel = section.querySelector<HTMLElement>('[data-progress-percent]');
    const progressBar = section.querySelector<HTMLElement>('[data-progress-bar]');
    const message = section.querySelector<HTMLElement>('[data-progress-message]');
    const rows = section.querySelector<HTMLElement>('[data-progress-rows]');

    if (phase) phase.textContent = progress.phase;
    if (percentLabel) percentLabel.textContent = `${percent}%`;
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (message) message.textContent = progress.message;
    if (rows) {
        rows.textContent = `${progress.rowsRead.toLocaleString()}${progress.totalRows === undefined ? '' : ` / ${progress.totalRows.toLocaleString()}`} rows`;
    }
    return true;
}

function render(): void {
    if (!app || !currentState) return;
    const state = currentState;
    const disabled = state.executing || state.counting ? ' disabled' : '';
    const openSqlButton = lastExecutionSucceeded ? '<button id="open-sql">Open in SQL window</button>' : '';
    app.innerHTML = `<main class="migration-root">
        <header class="wizard-header"><div><h1>Migration Studio</h1><p>Stream a table or SQL result into another database without materializing the full result set.</p></div>
            <button id="analyze" class="primary"${disabled}>${state.executing || state.counting ? 'Running...' : 'Analyze source'}</button></header>
        ${statusMessage ? `<div class="status ${statusKind}">${escapeHtml(statusMessage)}</div>` : ''}
        <div class="workspace">${renderSource(state.source, state)}<div class="flow-arrow">&rarr;</div>${renderTarget(state.target, state)}${renderAnalysis(state.analysis, state)}</div>
        ${renderProgress(state)}
        <footer>${openSqlButton || ''}<button id="execute" class="primary"${!state.analysis || state.executing || state.counting ? ' disabled' : ''}>${state.executing ? 'Migrating...' : 'Start migration'}</button></footer>
    </main>`;
    syncTableDatalist();
}

function inputValue(id: string): string {
    return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value.trim() || '';
}

function readSource(): MigrationWizardSourceState {
    const source = currentState?.source;
    if (!source) throw new Error('Source is not initialized.');
    if (source.mode === 'sql') {
        return { mode: 'sql', connectionName: inputValue('source-connection'), sql: inputValue('source-sql') };
    }
    return {
        mode: 'table',
        connectionName: inputValue('source-connection'),
        database: inputValue('source-database') || undefined,
        schema: inputValue('source-schema') || undefined,
        table: inputValue('source-table'),
    };
}

function readTarget(): MigrationWizardTargetState {
    return {
        connectionName: inputValue('target-connection'),
        database: inputValue('target-database') || undefined,
        schema: inputValue('target-schema') || undefined,
        table: inputValue('target-table'),
        appendToExistingTable: (document.getElementById('append-target') as HTMLInputElement | null)?.checked ?? false,
    };
}

function clearTargetAnalyzeTimer(): void {
    if (targetAnalyzeTimer !== undefined) {
        clearTimeout(targetAnalyzeTimer);
        targetAnalyzeTimer = undefined;
    }
}

function scheduleTargetReanalysis(): void {
    clearTargetAnalyzeTimer();

    if (!currentState?.analysis || currentState.executing || currentState.counting) {
        return;
    }

    targetAnalyzeTimer = setTimeout(() => {
        targetAnalyzeTimer = undefined;
        if (!currentState?.analysis || currentState.executing || currentState.counting) {
            return;
        }

        try {
            const target = readTarget();
            lastExecutionSucceeded = false;
            postToHost({ type: 'analyze', source: readSource(), target });
        } catch (error) {
            statusKind = 'error';
            statusMessage = error instanceof Error ? error.message : String(error);
            render();
        }
    }, 600);
}

function applyTargetConnectionDefaults(select: HTMLSelectElement): void {
    if (!currentState) return;

    currentState.target.connectionName = select.value;
    const database = getMigrationWizardTargetDatabase(currentState.connections, select.value);
    currentState.target.database = database;

    const databaseInput = document.getElementById('target-database') as HTMLInputElement | null;
    if (databaseInput) {
        databaseInput.value = database ?? '';
    }
}

document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const mode = target?.dataset.sourceMode;
    if (mode === 'table' || mode === 'sql') {
        if (currentState) currentState.source.mode = mode;
        render();
        if (mode === 'table') {
            postToHost({
                type: 'requestCatalog',
                connectionName: currentState?.source.connectionName ?? '',
                database: (document.getElementById('source-database') as HTMLInputElement | null)?.value.trim() || undefined,
            });
        }
        return;
    }
    if (target?.id === 'analyze') {
        clearTargetAnalyzeTimer();
        lastExecutionSucceeded = false;
        try {
            postToHost({ type: 'analyze', source: readSource(), target: readTarget() });
        } catch (error) {
            statusKind = 'error';
            statusMessage = error instanceof Error ? error.message : String(error);
            render();
        }
        return;
    }
    if (target?.id === 'count-rows') {
        postToHost({ type: 'countRows' });
        return;
    }
    if (target?.id === 'open-sql') {
        postToHost({ type: 'openInSqlWindow' });
        return;
    }
    if (target?.id === 'execute') {
        const ddlInput = document.getElementById('create-table-ddl') as HTMLTextAreaElement | null;
        const customCreateTableDdl = ddlInput ? ddlInput.value.trim() : undefined;
        postToHost({ type: 'execute', customCreateTableDdl });
    }
});

document.addEventListener('change', event => {
    const target = event.target as HTMLSelectElement | null;
    if (target?.id === 'target-connection') {
        applyTargetConnectionDefaults(target);
        scheduleTargetReanalysis();
        return;
    }
    if (target?.id === 'append-target') {
        scheduleTargetReanalysis();
        return;
    }
    if (target?.id === 'source-connection') {
        if (currentState) currentState.source.connectionName = target.value;
        postToHost({
            type: 'requestCatalog',
            connectionName: target.value,
            database: (document.getElementById('source-database') as HTMLInputElement | null)?.value.trim() || undefined,
        });
        render();
    }
});

document.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | null;
    if (target?.id === 'source-schema') {
        if (currentState) currentState.source.schema = target.value || undefined;
        syncTableDatalist();
        return;
    }
    if (target?.id === 'target-table' || target?.id === 'target-database' || target?.id === 'target-schema') {
        scheduleTargetReanalysis();
    }
});

window.addEventListener('message', event => {
    const message = asHostMessage(event.data) as MigrationWizardHostToWebviewMessage;
    if (message.type === 'state') {
        clearTargetAnalyzeTimer();
        currentState = message.state;
        lastExecutionSucceeded = false;
        statusMessage = message.state.error || '';
        statusKind = message.state.error ? 'error' : 'info';
    } else if (message.type === 'catalogUpdated' && currentState) {
        currentState.catalog = message.catalog;
    } else if (message.type === 'analysisUpdated' && currentState) {
        currentState.analysis = message.analysis;
        currentState.executing = false;
        lastExecutionSucceeded = false;
        statusMessage = 'Analysis complete.';
        statusKind = 'success';
    } else if (message.type === 'progress' && currentState) {
        currentState.progress = message.progress;
        if (!updateProgressDom(message.progress)) {
            render();
        }
        return;
    } else if (message.type === 'executionFinished' && currentState) {
        currentState.executing = false;
        lastExecutionSucceeded = true;
        statusMessage = `${message.message} (${message.rowsInserted.toLocaleString()} rows).`;
        statusKind = 'success';
    } else if (message.type === 'executionFailed' && currentState) {
        currentState.executing = false;
        lastExecutionSucceeded = false;
        statusMessage = message.message;
        statusKind = 'error';
    }
    render();
});

postToHost({ type: 'ready' });
