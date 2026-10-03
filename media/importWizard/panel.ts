import type {
    BackgroundValidationProgress,
    ImportWizardHostToWebviewMessage,
    ImportWizardPreviewKind,
    ImportWizardState,
    ImportWizardWebviewToHostMessage,
} from './hostContracts.js';
import {
    eventTargetAsInput,
    eventTargetAsSelect,
    getElementById,
} from './dom.js';
import { postToHost, asHostMessage } from './protocol.js';
import { escapeHtml } from './utils.js';

const app = getElementById('app');

interface ImportWizardViewState {
    session: ImportWizardState | null;
    isExecuting: boolean;
    isTransitioning: boolean;
    status: { kind: string; message: string } | null;
    backgroundValidation: BackgroundValidationProgress | null;
}

const state: ImportWizardViewState = {
    session: null,
    isExecuting: false,
    isTransitioning: false,
    status: null,
    backgroundValidation: null,
};

function isWizardBusy(): boolean {
    return state.isExecuting || state.isTransitioning;
}

function buildIssueMap(session: ImportWizardState): Map<string, ImportWizardState['issues'][number]> {
    const issueMap = new Map<string, ImportWizardState['issues'][number]>();
    for (const issue of session.issues || []) {
        issueMap.set(`${issue.rowIndex}:${issue.columnIndex}`, issue);
    }
    return issueMap;
}

function moveColumn(sourceIndex: number, direction: number): void {
    if (!state.session) {
        return;
    }

    const ordered = [...state.session.columns];
    const currentIndex = ordered.findIndex(
        column => column.sourceIndex === sourceIndex,
    );
    if (currentIndex < 0) {
        return;
    }

    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= ordered.length) {
        return;
    }

    const [column] = ordered.splice(currentIndex, 1);
    ordered.splice(targetIndex, 0, column);
    postToHost({
        type: 'reorderColumns',
        orderedSourceIndexes: ordered.map(item => item.sourceIndex),
    });
}

function renderBackgroundValidationProgress(): string {
    const bg = state.backgroundValidation;
    if (!bg || bg.phase === 'complete' || bg.phase === 'cancelled') {
        return '';
    }

    const progress =
        bg.totalRows > 0
            ? Math.round((bg.rowsProcessed / bg.totalRows) * 100)
            : 0;
    const phaseLabel =
        bg.phase === 'reading' ? 'Reading data...' : 'Validating rows...';
    const issuesLabel =
        bg.issuesFound > 0
            ? ` (${bg.issuesFound} issue${bg.issuesFound > 1 ? 's' : ''} found)`
            : '';

    return `
			<div class="background-validation-progress">
				<div class="progress-header">
					<span class="progress-spinner"></span>
					<span class="progress-label">${phaseLabel}${issuesLabel}</span>
				</div>
				<div class="progress-bar-container">
					<div class="progress-bar" style="width: ${progress}%"></div>
				</div>
				<div class="progress-details">
					Row ${bg.rowsProcessed.toLocaleString()} of ${bg.totalRows.toLocaleString()}
				</div>
			</div>`;
}

function isSelectedOption(current: string | undefined, candidate: string): boolean {
    return (current || '').toUpperCase() === candidate.toUpperCase();
}

function renderTargetLocation(session: ImportWizardState): string {
    const caps = session.targetLocationCapabilities;
    const databaseOptions = session.availableDatabases
        .map(
            database =>
                `<option value="${escapeHtml(database)}"${isSelectedOption(session.targetLocation.database, database) ? ' selected' : ''}>${escapeHtml(database)}</option>`,
        )
        .join('');
    const schemaOptions = session.availableSchemas
        .map(
            schema =>
                `<option value="${escapeHtml(schema)}"${isSelectedOption(session.targetLocation.schema, schema) ? ' selected' : ''}>${escapeHtml(schema)}</option>`,
        )
        .join('');

    const databaseField = caps.supportsDatabaseSelection
        ? `
					<label>
						Database
						<select id="target-database" ${caps.enforceActiveDatabase || isWizardBusy() ? 'disabled' : ''}>
							${databaseOptions || '<option value="">No databases available</option>'}
						</select>
					</label>`
        : '';
    const schemaField = caps.supportsSchemaSelection
        ? `
					<label>
						Schema
						<select id="target-schema" ${isWizardBusy() ? 'disabled' : ''}>
							${schemaOptions || '<option value="">No schemas available</option>'}
						</select>
					</label>`
        : '';
    const connectionOptions = session.availableConnections
        .map(connection => `<option value="${escapeHtml(connection.name)}"${connection.name === session.connectionName ? ' selected' : ''}>${escapeHtml(connection.label)}</option>`)
        .join('');

    return `
			<section class="card target-location-panel import-destination-card">
				<div class="import-section-heading compact"><div><span class="import-section-number">02</span><div><h3>Destination</h3><p>Choose where the rows will be written.</p></div></div></div>
				<div class="target-location-fields import-destination-fields">
				<label>Connection<select id="target-connection" ${isWizardBusy() ? 'disabled' : ''}>${connectionOptions || '<option value="">No saved connections</option>'}</select></label>
					${databaseField}
					${schemaField}
					<label>
						Table
						<input id="target-table-name" type="text" value="${escapeHtml(session.targetLocation.tableName)}" ${isWizardBusy() ? 'disabled' : ''} />
					</label>
				</div>
				<label class="import-create-toggle"><input id="create-table" type="checkbox" ${session.createTable ? 'checked' : ''} ${session.canAppendToExistingTable && !isWizardBusy() ? '' : 'disabled'} /><span class="import-checkmark" aria-hidden="true">✓</span><span><strong>Create new table</strong><small>${session.createTable ? 'A table will be created from this mapping.' : 'Rows will be added to the existing table.'}</small></span></label>
				${session.canAppendToExistingTable ? '' : '<p class="muted">Appending is unavailable for this database import workflow.</p>'}
				<div class="import-destination-summary"><span class="import-destination-dot" aria-hidden="true"></span><small>Import target</small><strong>${escapeHtml(session.targetTable || 'Complete destination details')}</strong></div>
			</section>`;
}

function renderHeader(): string {
	return `
			<header class="import-workflow-header">
				<div class="import-heading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg></div>
				<div class="import-heading-copy"><h1>Import data</h1><p>Preview a file, map its columns, and write rows into the selected database.</p></div>
				<button id="close-import-top" class="import-close" aria-label="Close import dialog" ${isWizardBusy() ? 'disabled' : ''}>✕</button>
				<ol class="import-steps" aria-label="Import workflow">
					<li class="complete"><span class="import-step-number">1</span><span class="import-step-label">Source</span><span class="import-step-connector" aria-hidden="true"></span></li>
					<li class="complete"><span class="import-step-number">2</span><span class="import-step-label">Destination</span><span class="import-step-connector" aria-hidden="true"></span></li>
					<li class="current"><span class="import-step-number">3</span><span class="import-step-label">Review</span></li>
				</ol>
			</header>`;
}

function renderHeaderSource(session: ImportWizardState): string {
	const previewOptions = [5, 10, 20]
		.map(value => `<option value="${value}"${session.previewRowCount === value ? ' selected' : ''}>${value}</option>`)
		.join('');
	const sheetOptions = session.availableSheets
		.map(sheetName => `<option value="${escapeHtml(sheetName)}"${session.sheetName === sheetName ? ' selected' : ''}>${escapeHtml(sheetName)}</option>`)
		.join('');
	return `
			<section class="import-source-panel" aria-labelledby="import-source-title">
				<div class="import-section-heading"><div><span class="import-section-number">01</span><div><h3 id="import-source-title">Source file</h3><p>Select a spreadsheet, delimited text file, or clipboard data.</p></div></div>
					<span class="import-ready-badge"><span></span>Ready to preview</span>
				</div>
				<div class="import-source-content">
					<div class="import-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.75h8l4 4V20a.75.75 0 0 1-.75.75h-10.5A.75.75 0 0 1 6 20V3.75Z" /><path d="M14 3.75v4.5h4M8.5 12h7m-7 3h7" /></svg></div>
					<div class="import-file-details"><div class="import-file-title">${escapeHtml(session.sourceName || session.fileName)}</div><div class="import-file-path">${session.sourceKind === 'clipboard' ? 'Clipboard snapshot' : escapeHtml(session.filePath)}</div></div>
					<span class="import-file-type">${escapeHtml(session.fileFormat.toUpperCase())}</span>
					<div class="import-source-actions"><button class="import-choose-button" data-source-kind="clipboard" ${isWizardBusy() ? 'disabled' : ''}>Paste clipboard</button><button class="import-choose-button" data-source-kind="file" ${isWizardBusy() ? 'disabled' : ''}>${session.sourceKind === 'file' ? 'Change file' : 'Choose file'} <span aria-hidden="true">↗</span></button></div>
				</div>
				<div class="import-source-options">
					<label>Preview rows<select id="preview-row-count" ${isWizardBusy() ? 'disabled' : ''}>${previewOptions}</select></label>
					${session.availableSheets.length ? `<label class="import-sheet-control"><span>Worksheet</span><select id="sheet-name" ${session.canChangeSheet && !isWizardBusy() ? '' : 'disabled'}>${sheetOptions}</select></label>` : ''}
				</div>
			</section>`;
}

function renderInspector(session: ImportWizardState): string {
    const warningItems = (session.warnings || [])
        .map(warning => `<li>${escapeHtml(warning)}</li>`)
        .join('');

    const bg = state.backgroundValidation;
    const bgStatusHtml =
        bg && bg.phase !== 'complete' && bg.phase !== 'cancelled'
            ? `
				<div><dt>Deep validation</dt><dd class="validation-active">In progress (${bg.rowsProcessed}/${bg.totalRows})</dd></div>
			`
            : bg && bg.phase === 'complete'
              ? `<div><dt>Deep Validation</dt><dd class="validation-complete">Complete (${bg.totalRows.toLocaleString()} rows)</dd></div>`
              : '';

    return `
			<div class="inspector-panel">
				<h3>Source details</h3>
				<dl class="metadata-grid">
					<div><dt>Dialect</dt><dd>${escapeHtml(session.databaseKind)}</dd></div>
					<div><dt>Format</dt><dd>${escapeHtml(session.fileFormat)}</dd></div>
					<div><dt>Delimiter</dt><dd>${escapeHtml(session.detectedDelimiter || '(not applicable)')}</dd></div>
					<div><dt>Decimal style</dt><dd>${escapeHtml(session.decimalDelimiter)}</dd></div>
					<div><dt>Validation rows</dt><dd>${escapeHtml(String(session.validationSampleSize))}</dd></div>
					${bgStatusHtml}
					<div><dt>Columns</dt><dd>${escapeHtml(String(session.columns.length))}</dd></div>
				</dl>
				<h3>Warnings</h3>
				${warningItems ? `<ul class="warning-list">${warningItems}</ul>` : '<p class="muted">No warnings.</p>'}
			</div>`;
}

function renderColumnEditor(session: ImportWizardState): string {
    return `
			<section class="card columns-panel import-card import-mapping">
				<div class="import-section-heading compact">
					<div><span class="import-section-number">03</span><div><h3>Column mapping</h3><p>Choose destination names and data types.</p></div></div>
					<span class="import-mapping-count">${session.columns.filter(column => column.included).length} of ${session.columns.length} columns</span>
				</div>
				<div class="import-mapping-head"><span>Use</span><span>Order</span><span>Source column</span><span aria-hidden="true"></span><span>Destination column</span><span>Inferred type</span><span>Data type</span></div>
				<div class="import-mapping-list">${session.columns.map((column, index) => {
					const typeOptions = session.typeOptions.map(typeName => `<option value="${escapeHtml(typeName)}"${column.selectedType === typeName ? ' selected' : ''}>${escapeHtml(typeName)}</option>`).join('');
					return `<div class="import-map-row ${column.included ? '' : 'is-excluded'}">
						<input aria-label="Include ${escapeHtml(column.sourceName)}" type="checkbox" class="include-toggle" data-source-index="${column.sourceIndex}" ${column.included ? 'checked' : ''} ${isWizardBusy() ? 'disabled' : ''} />
						<span class="move-buttons"><button class="move-up" data-source-index="${column.sourceIndex}" ${index === 0 || isWizardBusy() ? 'disabled' : ''} aria-label="Move ${escapeHtml(column.sourceName)} up">↑</button><button class="move-down" data-source-index="${column.sourceIndex}" ${index === session.columns.length - 1 || isWizardBusy() ? 'disabled' : ''} aria-label="Move ${escapeHtml(column.sourceName)} down">↓</button></span>
						<span class="import-source-column" title="${escapeHtml(column.sourceName)}">${escapeHtml(column.sourceName)}</span><span class="import-map-arrow" aria-hidden="true">→</span>
						<input class="target-name" aria-label="Destination for ${escapeHtml(column.sourceName)}" data-source-index="${column.sourceIndex}" value="${escapeHtml(column.targetName)}" ${isWizardBusy() ? 'disabled' : ''} />
						<span class="type-badge ${column.overrideMode === 'user' ? 'badge-user' : 'badge-inferred'}">${escapeHtml(column.inferredType)}</span>
						<select class="type-select" aria-label="Type for ${escapeHtml(column.sourceName)}" data-source-index="${column.sourceIndex}" ${isWizardBusy() ? 'disabled' : ''}>${typeOptions}</select>
					</div>`;
				}).join('') || '<div class="import-no-columns">All source columns are excluded. Re-enable at least one column to continue.</div>'}</div>
			</section>`;
}

function renderPreviewGrid(session: ImportWizardState): string {
    const issueMap = buildIssueMap(session);
    const headerCells = session.columns
        .map(
            column =>
                `<th class="${column.included ? '' : 'is-excluded'}">${escapeHtml(column.sourceName)}</th>`,
        )
        .join('');
    const bodyRows = session.previewRows
        .map((row, rowIndex) => {
            const cells = session.columns
                .map((column, columnIndex) => {
                    const issue = issueMap.get(`${rowIndex}:${columnIndex}`);
                    const value = row[columnIndex] ?? '';
                    const classes = [
                        column.included ? '' : 'is-excluded',
                        issue ? 'has-issue' : '',
                    ]
                        .filter(Boolean)
                        .join(' ');
                    const title = issue ? ` title="${escapeHtml(issue.message)}"` : '';
                    return `<td class="${classes}"${title}>${escapeHtml(value)}</td>`;
                })
                .join('');
            return `<tr>${cells}</tr>`;
        })
        .join('');

    return `
			<section class="card preview-panel import-card import-preview-card">
				<div class="import-section-heading compact"><div><span class="import-section-number">02</span><div><h3>Data preview</h3><p>Check the incoming values before importing.</p></div></div><span class="import-preview-count">${session.columns.length} columns <i></i> ${session.previewRows.length} sample rows</span></div>
				<label class="import-headers-toggle"><input id="has-headers" type="checkbox" ${session.hasHeaders ? 'checked' : ''} ${isWizardBusy() ? 'disabled' : ''} /><span>First row contains column names</span></label>
				<div class="preview-table-wrap import-preview">
					<table class="preview-table">
						<thead><tr>${headerCells}</tr></thead>
						<tbody>${bodyRows || '<tr><td colspan="999">No preview rows available.</td></tr>'}</tbody>
					</table>
				</div>
				<div class="import-preview-footnote">Showing up to ${session.previewRowCount} rows from the selected source.</div>
			</section>`;
}

function renderSqlPreview(session: ImportWizardState): string {
    const createSql = escapeHtml(session.executionPlan.createTableSql || '');
    const createPreview = session.createTable
        ? `<div class="sql-card"><div class="sql-card-header"><h3>Create table</h3><div class="sql-actions"><button data-open-kind="create">Open</button><button data-copy-kind="create">Copy</button></div></div><pre>${createSql}</pre></div>`
        : '<p class="muted">The selected target table will be used as-is. This import will not execute CREATE TABLE.</p>';
    const loadSql = session.executionPlan.loadSql
        ? `<div class="sql-card"><div class="sql-card-header"><h3>Load SQL</h3><div class="sql-actions"><button data-open-kind="load">Open</button><button data-copy-kind="load">Copy</button></div></div><pre>${escapeHtml(session.executionPlan.loadSql)}</pre></div>`
        : '<div class="sql-card"><div class="sql-card-header"><h3>Load SQL</h3><div class="sql-actions"><button data-open-kind="plan">Open Plan</button><button data-copy-kind="plan">Copy Plan</button></div></div><pre>No direct load SQL preview is available for this execution mode.</pre></div>';
    const nextSteps = (session.executionPlan.nextSteps || [])
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');

    return `
			<section class="sql-panel">
				<div class="import-section-heading compact">
					<div><h3>Import plan</h3></div>
					<button id="refresh-sql">Refresh SQL Preview</button>
				</div>
				${createPreview}
				${loadSql}
				${nextSteps ? `<div class="sql-next-steps"><h3>Next steps</h3><ol>${nextSteps}</ol></div>` : ''}
			</section>`;
}

function attachListeners(): void {
    document.querySelectorAll('[data-source-kind]').forEach(button => {
        button.addEventListener('click', () => {
            const kind = (button as HTMLElement).dataset.sourceKind;
            postToHost({ type: kind === 'clipboard' ? 'requestClipboardSource' : 'requestFileSource' });
        });
    });

    const previewSelect = getElementById<HTMLSelectElement>('preview-row-count');
    previewSelect?.addEventListener('change', event => {
        const target = eventTargetAsSelect(event);
        postToHost({
            type: 'setPreviewRowCount',
            previewRowCount: Number(target?.value),
        });
    });

    const sheetSelect = getElementById<HTMLSelectElement>('sheet-name');
    sheetSelect?.addEventListener('change', event => {
        const target = eventTargetAsSelect(event);
        postToHost({ type: 'setSheet', sheetName: target?.value });
    });

    const hasHeaders = getElementById<HTMLInputElement>('has-headers');
    hasHeaders?.addEventListener('change', event => {
        const target = eventTargetAsInput(event);
        postToHost({ type: 'setHasHeaders', hasHeaders: Boolean(target?.checked) });
    });

    const createTable = getElementById<HTMLInputElement>('create-table');
    createTable?.addEventListener('change', event => {
        const target = eventTargetAsInput(event);
        postToHost({ type: 'setCreateTable', createTable: Boolean(target?.checked) });
    });

    const connection = getElementById<HTMLSelectElement>('target-connection');
    connection?.addEventListener('change', event => {
        const target = eventTargetAsSelect(event);
        postToHost({ type: 'setConnection', connectionName: target?.value ?? '' });
    });

    document.querySelectorAll('.target-name').forEach(input => {
        input.addEventListener('change', event => {
            const target = eventTargetAsInput(event);
            const sourceIndex = Number(target?.dataset.sourceIndex);
            postToHost({
                type: 'renameColumn',
                sourceIndex,
                targetName: target?.value ?? '',
            });
        });
    });

    document.querySelectorAll('.include-toggle').forEach(checkbox => {
        checkbox.addEventListener('change', event => {
            const target = eventTargetAsInput(event);
            const sourceIndex = Number(target?.dataset.sourceIndex);
            postToHost({
                type: 'toggleColumn',
                sourceIndex,
                included: target?.checked,
            });
        });
    });

    document.querySelectorAll('.type-select').forEach(select => {
        select.addEventListener('change', event => {
            const target = eventTargetAsSelect(event);
            const sourceIndex = Number(target?.dataset.sourceIndex);
            postToHost({
                type: 'setColumnType',
                sourceIndex,
                selectedType: target?.value ?? '',
            });
        });
    });

    document.querySelectorAll('.move-up').forEach(button => {
        button.addEventListener('click', () =>
            moveColumn(Number((button as HTMLElement).dataset.sourceIndex), -1),
        );
    });

    document.querySelectorAll('.move-down').forEach(button => {
        button.addEventListener('click', () =>
            moveColumn(Number((button as HTMLElement).dataset.sourceIndex), 1),
        );
    });

    document.querySelectorAll('[data-open-kind]').forEach(button => {
        button.addEventListener('click', () =>
            postToHost({
                type: 'openSqlPreview',
                kind: (button as HTMLElement).dataset.openKind as ImportWizardPreviewKind | undefined,
            }),
        );
    });

    document.querySelectorAll('[data-copy-kind]').forEach(button => {
        button.addEventListener('click', () =>
            postToHost({
                type: 'copySql',
                kind: (button as HTMLElement).dataset.copyKind as ImportWizardPreviewKind | undefined,
            }),
        );
    });

    const refreshSql = getElementById('refresh-sql');
    refreshSql?.addEventListener('click', () =>
        postToHost({ type: 'requestSqlPreview' }),
    );

    const executeImport = getElementById('execute-import');
    executeImport?.addEventListener('click', () =>
        postToHost({ type: 'executeImport' }),
    );

    const targetDatabase = getElementById<HTMLSelectElement>('target-database');
    targetDatabase?.addEventListener('change', event => {
        const target = eventTargetAsSelect(event);
        postToHost({ type: 'setTargetDatabase', database: target?.value });
    });

    const targetSchema = getElementById<HTMLSelectElement>('target-schema');
    targetSchema?.addEventListener('change', event => {
        const target = eventTargetAsSelect(event);
        postToHost({ type: 'setTargetSchema', schema: target?.value });
    });

    const targetTableName = getElementById<HTMLInputElement>('target-table-name');
    targetTableName?.addEventListener('change', event => {
        const target = eventTargetAsInput(event);
        postToHost({
            type: 'setTargetTableName',
            tableName: target?.value ?? '',
        });
    });

    const close = getElementById('close-import');
    close?.addEventListener('click', () => postToHost({ type: 'closeWizard' }));
    const closeTop = getElementById('close-import-top');
    closeTop?.addEventListener('click', () => postToHost({ type: 'closeWizard' }));
}

function render(): void {
    if (!app) return;

    if (!state.session) {
        app.innerHTML =
            '<div class="loading-state">Loading advanced import wizard...</div>';
        return;
    }

    const session = state.session;
    const selectedColumnCount = session.columns.filter(column => column.included).length;
    const canExecute = !isWizardBusy()
        && !session.hasValidationErrors
        && selectedColumnCount > 0
        && Boolean(session.targetLocation.tableName.trim());
    app.innerHTML = `
			${renderHeader()}
			<div class="import-workflow-body">
				${renderBackgroundValidationProgress()}
				${renderHeaderSource(session)}
				<div class="import-workflow-grid">
				<div class="import-main-column">
					${renderPreviewGrid(session)}
					${renderColumnEditor(session)}
				</div>
				<aside class="import-side-column">
					${renderTargetLocation(session)}
					<details class="card import-review-details" open>
						<summary><span>Review details</span><span class="review-chevron" aria-hidden="true">⌄</span></summary>
						<div class="import-review-content">
						${renderInspector(session)}
						${renderSqlPreview(session)}
						</div>
					</details>
				</aside>
			</div>
			</div>
			<footer class="import-workflow-footer">
				<span class="import-status ${escapeHtml(state.status?.kind || 'neutral')}" role="status" aria-live="polite"><i></i>${escapeHtml(state.status?.message || 'Review the preview and mapping before importing.')}</span>
				<button id="close-import" class="import-cancel-button" ${isWizardBusy() ? 'disabled' : ''}>Close</button>
				<button id="execute-import" class="primary import-submit-button" ${canExecute ? '' : 'disabled'}>${state.isExecuting ? '<span class="import-button-spinner"></span>Importing…' : state.isTransitioning ? 'Updating…' : 'Import data'} <span aria-hidden="true">→</span></button>
			</footer>`;

    attachListeners();
}

window.addEventListener('message', (event: MessageEvent<ImportWizardHostToWebviewMessage>) => {
    const message = asHostMessage(event.data || {});
    switch (message.type) {
        case 'sessionInitialized':
            state.status = null;
            state.backgroundValidation = null;
            state.session = message.state;
            render();
            return;
        case 'previewUpdated':
            state.session = message.state;
            render();
            return;
        case 'validationUpdated':
            if (!state.session) {
                return;
            }
            state.session.issues = message.issues || [];
            state.session.warnings = message.warnings || [];
            state.session.hasValidationErrors = Boolean(message.hasValidationErrors);
            render();
            return;
        case 'sqlPreviewUpdated':
            if (!state.session) {
                return;
            }
            state.session.executionPlan = message.executionPlan;
            render();
            return;
        case 'backgroundValidationProgress':
            state.backgroundValidation = message.progress;
            if (message.summary && state.session) {
                state.session.issues = message.summary.issues || [];
                state.session.warnings = message.summary.warnings || [];
                state.session.hasValidationErrors = message.summary.hasErrors || false;
            }
            render();
            return;
        case 'executionStarted':
            state.isExecuting = true;
            state.status = { kind: 'info', message: 'Executing import...' };
            render();
            return;
        case 'executionFinished': {
            state.isExecuting = false;
            const failed = message.result?.success === false;
            state.status = {
                kind: failed ? 'error' : 'success',
                message: message.result?.message || (failed ? 'Import finished with errors.' : 'Import finished.'),
            };
            render();
            return;
        }
        case 'executionFailed':
            state.isExecuting = false;
            state.status = {
                kind: 'error',
                message: message.message || 'Import failed.',
            };
            render();
            return;
        case 'sessionTransitionStarted':
            state.isTransitioning = true;
            render();
            return;
        case 'sessionTransitionFinished':
            state.isTransitioning = false;
            render();
            return;
    }
});

render();
postToHost({ type: 'ready' } satisfies ImportWizardWebviewToHostMessage);
