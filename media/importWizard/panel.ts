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
    status: { kind: string; message: string } | null;
    backgroundValidation: BackgroundValidationProgress | null;
}

const state: ImportWizardViewState = {
    session: null,
    isExecuting: false,
    status: null,
    backgroundValidation: null,
};

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

function renderStatus(): string {
    if (!state.status) {
        return '';
    }

    return `<div class="status-banner status-${escapeHtml(state.status.kind)}">${escapeHtml(state.status.message)}</div>`;
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
						<select id="target-database" ${caps.enforceActiveDatabase ? 'disabled' : ''}>
							${databaseOptions || '<option value="">No databases available</option>'}
						</select>
					</label>`
        : '';
    const schemaField = caps.supportsSchemaSelection
        ? `
					<label>
						Schema
						<select id="target-schema">
							${schemaOptions || '<option value="">No schemas available</option>'}
						</select>
					</label>`
        : '';

    return `
			<section class="card target-location-panel">
				<h2>Target location</h2>
				<div class="target-location-fields">
					${databaseField}
					${schemaField}
					<label>
						Table
						<input id="target-table-name" type="text" value="${escapeHtml(session.targetLocation.tableName)}" />
					</label>
				</div>
				<p class="muted target-qualified-name">Qualified target: <code>${escapeHtml(session.targetTable)}</code></p>
			</section>`;
}

function renderHeader(session: ImportWizardState): string {
    const previewOptions = [5, 10, 20]
        .map(
            value =>
                `<option value="${value}"${session.previewRowCount === value ? ' selected' : ''}>${value}</option>`,
        )
        .join('');
    const sheetOptions = session.availableSheets
        .map(
            sheetName =>
                `<option value="${escapeHtml(sheetName)}"${session.sheetName === sheetName ? ' selected' : ''}>${escapeHtml(sheetName)}</option>`,
        )
        .join('');

    const bg = state.backgroundValidation;
    const isValidationInProgress =
        bg && bg.phase !== 'complete' && bg.phase !== 'cancelled';
    const validationWarningIcon = isValidationInProgress
        ? '<span class="validation-in-progress-icon" title="Background validation in progress. Issues may be found.">&#9888;</span>'
        : '';

    return `
			<section class="wizard-header card">
				<div>
					<h1>Advanced Import Wizard</h1>
					<p>${escapeHtml(session.fileName)}</p>
				</div>
				<div class="header-metadata">
					<label>
						Preview rows
						<select id="preview-row-count">${previewOptions}</select>
					</label>
					<label>
						Sheet
						<select id="sheet-name" ${session.canChangeSheet ? '' : 'disabled'}>
							${sheetOptions || '<option value="">N/A</option>'}
						</select>
					</label>
					<button id="execute-import" class="primary" ${state.isExecuting || session.hasValidationErrors ? 'disabled' : ''}>
						${state.isExecuting ? 'Executing...' : 'Execute Import'}${validationWarningIcon}
					</button>
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
			<section class="card inspector-panel">
				<h2>Source details</h2>
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
			</section>`;
}

function renderColumnEditor(session: ImportWizardState): string {
    const rows = session.columns
        .map((column, index) => {
            const typeOptions = session.typeOptions
                .map(
                    typeName =>
                        `<option value="${escapeHtml(typeName)}"${column.selectedType === typeName ? ' selected' : ''}>${escapeHtml(typeName)}</option>`,
                )
                .join('');
            return `
					<tr class="${column.included ? '' : 'is-excluded'}">
						<td><input type="checkbox" class="include-toggle" data-source-index="${column.sourceIndex}" ${column.included ? 'checked' : ''} /></td>
						<td class="move-buttons">
							<button class="move-up" data-source-index="${column.sourceIndex}" ${index === 0 ? 'disabled' : ''}>&#8593;</button>
							<button class="move-down" data-source-index="${column.sourceIndex}" ${index === session.columns.length - 1 ? 'disabled' : ''}>&#8595;</button>
						</td>
						<td><span class="source-name">${escapeHtml(column.sourceName)}</span></td>
						<td><input class="target-name" data-source-index="${column.sourceIndex}" value="${escapeHtml(column.targetName)}" /></td>
						<td><span class="type-badge ${column.overrideMode === 'user' ? 'badge-user' : 'badge-inferred'}">${escapeHtml(column.inferredType)}</span></td>
						<td>
							<select class="type-select" data-source-index="${column.sourceIndex}">
								${typeOptions}
							</select>
						</td>
					</tr>`;
        })
        .join('');

    return `
			<section class="card columns-panel">
				<div class="panel-heading">
					<h2>Column mapping</h2>
					<button id="refresh-sql">Refresh SQL Preview</button>
				</div>
				<table class="columns-table">
					<thead>
						<tr>
							<th>Use</th>
							<th>Order</th>
							<th>Source</th>
							<th>Target</th>
							<th>Inferred</th>
							<th>Selected</th>
						</tr>
					</thead>
					<tbody>${rows}</tbody>
				</table>
			</section>`;
}

function renderPreviewGrid(session: ImportWizardState): string {
    const issueMap = buildIssueMap(session);
    const headerCells = session.columns
        .map(
            column =>
                `<th class="${column.included ? '' : 'is-excluded'}">${escapeHtml(column.targetName)}</th>`,
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
			<section class="card preview-panel">
				<h2>Preview</h2>
				<div class="preview-table-wrap">
					<table class="preview-table">
						<thead><tr>${headerCells}</tr></thead>
						<tbody>${bodyRows || '<tr><td colspan="999">No preview rows available.</td></tr>'}</tbody>
					</table>
				</div>
			</section>`;
}

function renderSqlPreview(session: ImportWizardState): string {
    const createSql = escapeHtml(session.executionPlan.createTableSql || '');
    const loadSql = session.executionPlan.loadSql
        ? `<div class="sql-card"><div class="sql-card-header"><h3>Load SQL</h3><div class="sql-actions"><button data-open-kind="load">Open</button><button data-copy-kind="load">Copy</button></div></div><pre>${escapeHtml(session.executionPlan.loadSql)}</pre></div>`
        : '<div class="sql-card"><div class="sql-card-header"><h3>Load SQL</h3><div class="sql-actions"><button data-open-kind="plan">Open Plan</button><button data-copy-kind="plan">Copy Plan</button></div></div><pre>No direct load SQL preview is available for this execution mode.</pre></div>';
    const nextSteps = (session.executionPlan.nextSteps || [])
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');

    return `
			<section class="card sql-panel">
				<div class="panel-heading">
					<h2>SQL Preview</h2>
					<div class="sql-actions">
						<button data-open-kind="create">Open CREATE</button>
						<button data-copy-kind="create">Copy CREATE</button>
					</div>
				</div>
				<div class="sql-card"><pre>${createSql}</pre></div>
				${loadSql}
				${nextSteps ? `<div class="sql-next-steps"><h3>Next steps</h3><ol>${nextSteps}</ol></div>` : ''}
			</section>`;
}

function attachListeners(): void {
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
}

function render(): void {
    if (!app) return;

    if (!state.session) {
        app.innerHTML =
            '<div class="loading-state">Loading advanced import wizard...</div>';
        return;
    }

    const session = state.session;
    app.innerHTML = `
			${renderStatus()}
			${renderBackgroundValidationProgress()}
			${renderHeader(session)}
			${renderTargetLocation(session)}
			<div class="wizard-layout">
				<div class="wizard-main">
					${renderColumnEditor(session)}
					${renderPreviewGrid(session)}
				</div>
				<div class="wizard-side">
					${renderInspector(session)}
					${renderSqlPreview(session)}
				</div>
			</div>`;

    attachListeners();
}

window.addEventListener('message', event => {
    const message = asHostMessage(event.data || {});
    switch (message.type) {
        case 'sessionInitialized':
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
        case 'executionFinished':
            state.isExecuting = false;
            state.status = {
                kind: 'success',
                message: message.result?.message || 'Import finished.',
            };
            render();
            return;
        case 'executionFailed':
            state.isExecuting = false;
            state.status = {
                kind: 'error',
                message: message.message || 'Import failed.',
            };
            render();
            return;
    }
});

render();
postToHost({ type: 'ready' });
