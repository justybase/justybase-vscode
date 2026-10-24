import type {
    BackgroundValidationProgress,
    ImportExecutionProgress,
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
    executionProgress: ImportExecutionProgress | null;
    targetEditorOpen: boolean;
    lastProgressAt: number;
}

const state: ImportWizardViewState = {
    session: null,
    isExecuting: false,
    isTransitioning: false,
    status: null,
    backgroundValidation: null,
    executionProgress: null,
    targetEditorOpen: false,
    lastProgressAt: 0,
};

function isWizardBusy(): boolean {
    return state.isExecuting || state.isTransitioning;
}

const WAITING_HINT_DELAY_MS = 3000;
window.setInterval(() => {
    if (!state.isExecuting || !state.executionProgress) {
        return;
    }
    const element = document.getElementById('execution-progress-waiting');
    if (!element) {
        return;
    }
    const idleMs = Date.now() - state.lastProgressAt;
    if (idleMs < WAITING_HINT_DELAY_MS) {
        element.textContent = '';
        return;
    }
    const seconds = Math.floor(idleMs / 1000);
    const phase = state.executionProgress.phase;
    const label = phase === 'processing'
        ? 'Waiting for database processing'
        : phase === 'transfer'
            ? 'Waiting for transfer progress'
            : 'Waiting for the current step';
    element.textContent = `${label}… ${seconds}s`;
}, 1000);

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

function formatBytes(value?: number): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit++;
    }
    return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

interface ExecutionProgressView {
    phaseLabel: string;
    percent: number;
    indeterminate: boolean;
    detailLines: string;
}

function buildExecutionProgressView(): ExecutionProgressView | null {
    const progress = state.executionProgress;
    if (!state.isExecuting || !progress) {
        return null;
    }

    const isTransfer = progress.phase === 'transfer';
    const indeterminate = !isTransfer || progress.percent === undefined;
    const percent = isTransfer && progress.percent !== undefined
        ? Math.max(0, Math.min(100, Math.round(progress.percent)))
        : 0;
    const phaseLabel = isTransfer
        ? 'Phase 1/2 · Transferring data to the database'
        : progress.phase === 'processing'
            ? 'Phase 2/2 · Database processing'
            : 'Preparing import';
    const rowDetails = isTransfer && progress.totalRows
        ? `${(progress.rowsProcessed ?? 0).toLocaleString()} / ${progress.totalRows.toLocaleString()} rows`
        : '';
    const byteDetails = progress.bytesRead !== undefined
        ? `${formatBytes(progress.bytesRead)}${progress.bytesTotal ? ` / ${formatBytes(progress.bytesTotal)}` : ''} read`
        : '';
    const loadStatus = progress.loadStatus;
    const loadDetails: string[] = [];
    if (loadStatus) {
        if (loadStatus.planId !== undefined) {
            loadDetails.push(`Plan ${loadStatus.planId}`);
        }
        if (loadStatus.rowsInserted !== undefined) {
            loadDetails.push(`${loadStatus.rowsInserted.toLocaleString()} inserted`);
        }
        if (loadStatus.rowsRejected) {
            loadDetails.push(`${loadStatus.rowsRejected.toLocaleString()} rejected`);
        }
        if (loadStatus.bytesDownloaded !== undefined) {
            loadDetails.push(`${formatBytes(loadStatus.bytesDownloaded)} downloaded`);
        }
        if (loadStatus.bytesProcessed !== undefined) {
            loadDetails.push(`${formatBytes(loadStatus.bytesProcessed)} processed`);
        }
    }
    const transferDetails = [rowDetails, byteDetails].filter(Boolean).join(' · ');
    const loadStatusDetails = loadDetails.join(' · ');
    const detailLines: string[] = [];
    if (transferDetails) {
        detailLines.push(`<div class="progress-detail-line">${escapeHtml(transferDetails)}</div>`);
    }
    if (loadStatusDetails) {
        detailLines.push(`<div class="progress-detail-line progress-detail-load">${escapeHtml(loadStatusDetails)}</div>`);
    }
    if (detailLines.length === 0) {
        detailLines.push(`<div class="progress-detail-line">${escapeHtml(progress.message || '')}</div>`);
    }

    return {
        phaseLabel,
        percent,
        indeterminate,
        detailLines: detailLines.join(''),
    };
}

function renderExecutionProgress(): string {
    const view = buildExecutionProgressView();
    if (!view) {
        return '';
    }

    return `
			<div class="execution-progress${view.indeterminate ? ' indeterminate' : ''}">
				<div class="progress-header">
					<span class="progress-spinner"></span>
					<span class="progress-label">${escapeHtml(view.phaseLabel)}</span>
					${view.indeterminate ? '' : `<span class="execution-progress-percent">${view.percent}%</span>`}
				</div>
				<div class="progress-bar-container">
					<div class="progress-bar" style="width: ${view.percent}%"></div>
				</div>
				<div class="progress-details">${view.detailLines}</div>
				<div class="progress-waiting" id="execution-progress-waiting" role="status"></div>
			</div>`;
}

/**
 * Update the existing progress panel without replacing it. Replacing the DOM
 * node restarted the spinner CSS animation on every progress message, which
 * made the indicator visibly flicker.
 */
function updateExecutionProgressPanel(): boolean {
    const container = document.querySelector<HTMLElement>('.execution-progress');
    if (!container) {
        return false;
    }

    const view = buildExecutionProgressView();
    if (!view) {
        container.remove();
        return true;
    }

    container.classList.toggle('indeterminate', view.indeterminate);

    const label = container.querySelector<HTMLElement>('.progress-label');
    if (label) {
        label.textContent = view.phaseLabel;
    }

    const percentElement = container.querySelector<HTMLElement>('.execution-progress-percent');
    if (view.indeterminate) {
        percentElement?.remove();
    } else if (percentElement) {
        percentElement.textContent = `${view.percent}%`;
    } else {
        const header = container.querySelector<HTMLElement>('.progress-header');
        if (header) {
            const span = document.createElement('span');
            span.className = 'execution-progress-percent';
            span.textContent = `${view.percent}%`;
            header.appendChild(span);
        }
    }

    const bar = container.querySelector<HTMLElement>('.progress-bar');
    if (bar) {
        bar.style.width = `${view.percent}%`;
    }

    const details = container.querySelector<HTMLElement>('.progress-details');
    if (details) {
        details.innerHTML = view.detailLines;
    }

    return true;
}

function isSelectedOption(current: string | undefined, candidate: string): boolean {
    return (current || '').toUpperCase() === candidate.toUpperCase();
}

function renderTargetBanner(session: ImportWizardState): string {
    const caps = session.targetLocationCapabilities;
    const editorOpen = state.targetEditorOpen || !session.targetLocation.tableName.trim();
    const connectionLabel =
        session.availableConnections.find(connection => connection.name === session.connectionName)?.label
        ?? session.connectionName
        ?? 'No connection';
    const includedCount = session.columns.filter(column => column.included).length;
    const targetLabel = session.targetTable?.trim() || 'Choose a destination table';

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
    const connectionOptions = session.availableConnections
        .map(connection => `<option value="${escapeHtml(connection.name)}"${connection.name === session.connectionName ? ' selected' : ''}>${escapeHtml(connection.label)}</option>`)
        .join('');

    const databaseField = caps.supportsDatabaseSelection
        ? `
					<label>Database
						<select id="target-database" ${caps.enforceActiveDatabase || isWizardBusy() ? 'disabled' : ''}>
							${databaseOptions || '<option value="">No databases available</option>'}
						</select>
					</label>`
        : '';
    const schemaField = caps.supportsSchemaSelection
        ? `
					<label>Schema
						<select id="target-schema" ${isWizardBusy() ? 'disabled' : ''}>
							${schemaOptions || '<option value="">No schemas available</option>'}
						</select>
					</label>`
        : '';

    return `
			<section class="import-target-banner${editorOpen ? ' is-editing' : ''}">
				<div class="import-target-headline">
					<span class="import-target-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"><path d="M4 5.5h16v13H4zM4 10h16M9.5 5.5v13" /></svg>
					</span>
					<div class="import-target-copy">
						<span class="import-target-label">Import target</span>
						<strong class="import-target-name" title="${escapeHtml(targetLabel)}">${escapeHtml(targetLabel)}</strong>
						<span class="import-target-meta">
							<span>${escapeHtml(connectionLabel)}</span>
							<i aria-hidden="true"></i>
							<span>${escapeHtml(session.databaseKind)}</span>
							<i aria-hidden="true"></i>
							<span>${includedCount} of ${session.columns.length} columns</span>
						</span>
					</div>
					<button id="toggle-target-editor" class="import-target-edit" aria-expanded="${editorOpen}" ${isWizardBusy() ? 'disabled' : ''}>
						${editorOpen ? 'Done' : 'Change'}
					</button>
				</div>
				<div class="import-target-fields"${editorOpen ? '' : ' hidden'}>
					<label>Connection
						<select id="target-connection" ${isWizardBusy() ? 'disabled' : ''}>${connectionOptions || '<option value="">No saved connections</option>'}</select>
					</label>
					${databaseField}
					${schemaField}
					<label>Table
						<input id="target-table-name" type="text" value="${escapeHtml(session.targetLocation.tableName)}" ${isWizardBusy() ? 'disabled' : ''} />
					</label>
					<label class="import-create-toggle">
						<input id="create-table" type="checkbox" ${session.createTable ? 'checked' : ''} ${session.canAppendToExistingTable && !isWizardBusy() ? '' : 'disabled'} />
						<span class="import-checkmark" aria-hidden="true">✓</span>
						<span><strong>Create new table</strong><small>${session.createTable ? 'A table will be created from this mapping.' : 'Rows will be added to the existing table.'}</small></span>
					</label>
					${session.canAppendToExistingTable ? '' : '<p class="import-target-note">Appending is unavailable for this database import workflow.</p>'}
				</div>
			</section>`;
}

function renderHeader(): string {
	return `
			<header class="import-workflow-header">
				<div class="import-heading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" /></svg></div>
				<div class="import-heading-copy"><h1>Import data</h1><p>Preview a file, map its columns, and write rows into the selected database.</p></div>
				<button id="close-import-top" class="import-close" aria-label="Close import dialog" ${isWizardBusy() ? 'disabled' : ''}>✕</button>
			</header>`;
}

function renderSourceCard(session: ImportWizardState): string {
	const previewOptions = [5, 10, 20]
		.map(value => `<option value="${value}"${session.previewRowCount === value ? ' selected' : ''}>${value}</option>`)
		.join('');
	const sheetOptions = session.availableSheets
		.map(sheetName => `<option value="${escapeHtml(sheetName)}"${session.sheetName === sheetName ? ' selected' : ''}>${escapeHtml(sheetName)}</option>`)
		.join('');
	return `
			<section class="card import-source-card">
				<div class="import-section-heading compact"><div><span class="import-section-number">01</span><div><h3>Source</h3><p>File, worksheet, and preview.</p></div></div></div>
				<div class="import-source-file">
					<span class="import-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.75h8l4 4V20a.75.75 0 0 1-.75.75h-10.5A.75.75 0 0 1 6 20V3.75Z" /><path d="M14 3.75v4.5h4M8.5 12h7m-7 3h7" /></svg></span>
					<div class="import-file-details">
						<div class="import-file-title" title="${escapeHtml(session.sourceName || session.fileName)}">${escapeHtml(session.sourceName || session.fileName)}</div>
						<div class="import-file-path" title="${escapeHtml(session.filePath)}">${session.sourceKind === 'clipboard' ? 'Clipboard snapshot' : escapeHtml(session.filePath)}</div>
					</div>
					<span class="import-file-type">${escapeHtml(session.fileFormat.toUpperCase())}</span>
				</div>
				<div class="import-source-options">
					${session.availableSheets.length ? `<label>Worksheet<select id="sheet-name" ${session.canChangeSheet && !isWizardBusy() ? '' : 'disabled'}>${sheetOptions}</select></label>` : ''}
					<label>Preview rows<select id="preview-row-count" ${isWizardBusy() ? 'disabled' : ''}>${previewOptions}</select></label>
				</div>
				<div class="import-source-actions">
					<button class="import-choose-button" data-source-kind="clipboard" ${isWizardBusy() ? 'disabled' : ''}>Paste clipboard</button>
					<button class="import-choose-button" data-source-kind="file" ${isWizardBusy() ? 'disabled' : ''}>${session.sourceKind === 'file' ? 'Change file' : 'Choose file'} <span aria-hidden="true">↗</span></button>
				</div>
			</section>`;
}

function renderTechnicalDetails(session: ImportWizardState): string {
    const entries: Array<{ label: string; value: string }> = [
        { label: 'Dialect', value: session.databaseKind },
        { label: 'Format', value: session.fileFormat },
        { label: 'Decimal style', value: session.decimalDelimiter },
        { label: 'Validation rows', value: String(session.validationSampleSize) },
    ];
    if (session.detectedDelimiter) {
        entries.splice(2, 0, { label: 'Delimiter', value: session.detectedDelimiter });
    }

    const bg = state.backgroundValidation;
    if (bg && bg.phase === 'complete') {
        entries.push({ label: 'Deep validation', value: `${bg.totalRows.toLocaleString()} rows` });
    }

    return `
			<dl class="metadata-grid import-technical-grid">
				${entries.map(entry => `<div><dt>${escapeHtml(entry.label)}</dt><dd>${escapeHtml(entry.value)}</dd></div>`).join('')}
			</dl>`;
}

function renderColumnEditor(session: ImportWizardState): string {
    const includedCount = session.columns.filter(column => column.included).length;
    return `
			<section class="card import-mapping">
				<div class="import-section-heading compact">
					<div><span class="import-section-number">03</span><div><h3>Columns</h3><p>Rename destinations and choose data types.</p></div></div>
					<span class="import-mapping-count">${includedCount} of ${session.columns.length} included</span>
				</div>
				<div class="import-mapping-head"><span></span><span></span><span>Source column</span><span aria-hidden="true"></span><span>Destination column</span><span>Data type</span></div>
				<div class="import-mapping-list">${session.columns.map((column, index) => {
					const typeOptions = session.typeOptions.map(typeName => `<option value="${escapeHtml(typeName)}"${column.selectedType === typeName ? ' selected' : ''}>${escapeHtml(typeName)}</option>`).join('');
					const inferredTitle = `Inferred type: ${column.inferredType}`;
					return `<div class="import-map-row ${column.included ? '' : 'is-excluded'}">
						<input aria-label="Include ${escapeHtml(column.sourceName)}" type="checkbox" class="include-toggle" data-source-index="${column.sourceIndex}" ${column.included ? 'checked' : ''} ${isWizardBusy() ? 'disabled' : ''} />
						<span class="move-buttons"><button class="move-up" data-source-index="${column.sourceIndex}" ${index === 0 || isWizardBusy() ? 'disabled' : ''} aria-label="Move ${escapeHtml(column.sourceName)} up">↑</button><button class="move-down" data-source-index="${column.sourceIndex}" ${index === session.columns.length - 1 || isWizardBusy() ? 'disabled' : ''} aria-label="Move ${escapeHtml(column.sourceName)} down">↓</button></span>
						<span class="import-source-column" title="${escapeHtml(column.sourceName)}">${escapeHtml(column.sourceName)}</span><span class="import-map-arrow" aria-hidden="true">→</span>
						<input class="target-name" id="column-name-${column.sourceIndex}" aria-label="Destination for ${escapeHtml(column.sourceName)}" data-source-index="${column.sourceIndex}" value="${escapeHtml(column.targetName)}" title="${escapeHtml(inferredTitle)}" ${isWizardBusy() ? 'disabled' : ''} />
						<select class="type-select" id="column-type-${column.sourceIndex}" aria-label="Type for ${escapeHtml(column.sourceName)}" data-source-index="${column.sourceIndex}" title="${escapeHtml(inferredTitle)}" ${isWizardBusy() ? 'disabled' : ''}>${typeOptions}</select>
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
			<section class="card import-preview-card">
				<details class="import-collapsible" data-details-key="preview" open>
					<summary class="import-collapsible-summary">
						<span class="import-section-number">02</span>
						<span class="import-collapsible-copy"><strong>Data preview</strong><small>Check the incoming values before importing.</small></span>
						<span class="import-preview-count">${session.columns.length} columns <i></i> ${session.previewRows.length} sample rows</span>
						<span class="review-chevron" aria-hidden="true">⌄</span>
					</summary>
					<div class="import-collapsible-body">
						<label class="import-headers-toggle"><input id="has-headers" type="checkbox" ${session.hasHeaders ? 'checked' : ''} ${isWizardBusy() ? 'disabled' : ''} /><span>First row contains column names</span></label>
						<div class="preview-table-wrap import-preview">
							<table class="preview-table">
								<thead><tr>${headerCells}</tr></thead>
								<tbody>${bodyRows || '<tr><td colspan="999">No preview rows available.</td></tr>'}</tbody>
							</table>
						</div>
						<div class="import-preview-footnote">Showing up to ${session.previewRowCount} rows from the selected source.</div>
					</div>
				</details>
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
			<div class="import-sql-preview">
				<div class="import-sql-toolbar">
					<span>Generated statements</span>
					<button id="refresh-sql">Refresh</button>
				</div>
				${createPreview}
				${loadSql}
				${nextSteps ? `<div class="sql-next-steps"><h3>Next steps</h3><ol>${nextSteps}</ol></div>` : ''}
			</div>`;
}

function renderReviewCard(session: ImportWizardState): string {
    const warnings = session.warnings || [];
    const warningItems = warnings
        .map(warning => `<li>${escapeHtml(warning)}</li>`)
        .join('');
    const errorCount = (session.issues || []).filter(issue => issue.severity === 'error').length;

    const bg = state.backgroundValidation;
    const validationRow =
        bg && bg.phase !== 'complete' && bg.phase !== 'cancelled'
            ? `<div class="import-validation-row"><span class="progress-spinner"></span> Deep validation ${bg.rowsProcessed.toLocaleString()} / ${bg.totalRows.toLocaleString()} rows</div>`
            : bg && bg.phase === 'complete'
                ? `<div class="import-validation-row complete">Deep validation complete · ${bg.totalRows.toLocaleString()} rows</div>`
                : '';

    return `
			<section class="card import-review-card">
				<div class="import-section-heading compact">
					<div><span class="import-section-number">04</span><div><h3>Review</h3><p>Warnings and generated SQL.</p></div></div>
					${warnings.length ? `<span class="import-review-badge">${warnings.length} warning${warnings.length === 1 ? '' : 's'}</span>` : ''}
				</div>
				${errorCount ? `<p class="import-review-errors">${errorCount} validation issue${errorCount === 1 ? '' : 's'} found in the preview.</p>` : ''}
				${validationRow}
				${warningItems ? `<ul class="import-warning-list">${warningItems}</ul>` : '<p class="import-empty-note">No warnings found.</p>'}
				<details class="import-details" data-details-key="sql">
					<summary><span>SQL preview</span><span class="import-details-hint">${session.createTable ? 'Create + load' : 'Load'}</span><span class="review-chevron" aria-hidden="true">⌄</span></summary>
					<div class="import-details-body">${renderSqlPreview(session)}</div>
				</details>
				<details class="import-details" data-details-key="technical">
					<summary><span>Technical details</span><span class="import-details-hint">${escapeHtml(session.databaseKind)}</span><span class="review-chevron" aria-hidden="true">⌄</span></summary>
					<div class="import-details-body">${renderTechnicalDetails(session)}</div>
				</details>
			</section>`;
}

function captureDetailsState(): Record<string, boolean> {
    const openState: Record<string, boolean> = {};
    document.querySelectorAll<HTMLDetailsElement>('details[data-details-key]').forEach(details => {
        const key = details.dataset.detailsKey;
        if (key) {
            openState[key] = details.open;
        }
    });
    return openState;
}

function restoreDetailsState(openState: Record<string, boolean>): void {
    document.querySelectorAll<HTMLDetailsElement>('details[data-details-key]').forEach(details => {
        const key = details.dataset.detailsKey;
        if (key && key in openState) {
            details.open = openState[key];
        }
    });
}

function captureFocusState(): { id: string; start: number | null; end: number | null } | null {
    const active = document.activeElement;
    if (
        !(active instanceof HTMLInputElement)
        && !(active instanceof HTMLTextAreaElement)
        && !(active instanceof HTMLSelectElement)
    ) {
        return null;
    }
    if (!active.id) {
        return null;
    }
    const hasSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    return {
        id: active.id,
        start: hasSelection ? active.selectionStart : null,
        end: hasSelection ? active.selectionEnd : null,
    };
}

function restoreFocusState(snapshot: { id: string; start: number | null; end: number | null } | null): void {
    if (!snapshot) {
        return;
    }
    const element = document.getElementById(snapshot.id);
    if (
        !(element instanceof HTMLInputElement)
        && !(element instanceof HTMLTextAreaElement)
        && !(element instanceof HTMLSelectElement)
    ) {
        return;
    }
    element.focus();
    if (
        snapshot.start !== null
        && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ) {
        element.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    }
}


function attachListeners(): void {
    document.querySelectorAll('[data-source-kind]').forEach(button => {
        button.addEventListener('click', () => {
            const kind = (button as HTMLElement).dataset.sourceKind;
            postToHost({ type: kind === 'clipboard' ? 'requestClipboardSource' : 'requestFileSource' });
        });
    });

    const toggleTargetEditor = getElementById('toggle-target-editor');
    toggleTargetEditor?.addEventListener('click', () => {
        state.targetEditorOpen = !state.targetEditorOpen;
        render();
        if (state.targetEditorOpen) {
            document.querySelector<HTMLElement>('.import-workflow-body')?.scrollTo({ top: 0, behavior: 'smooth' });
        }
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
        const message = state.status?.kind === 'error'
            ? state.status.message
            : 'Loading advanced import wizard...';
        app.innerHTML = `<div class="loading-state">${escapeHtml(message)}</div>`;
        return;
    }

    const session = state.session;
    const selectedColumnCount = session.columns.filter(column => column.included).length;
    const canExecute = !isWizardBusy()
        && !session.hasValidationErrors
        && selectedColumnCount > 0
        && Boolean(session.targetLocation.tableName.trim());
    const previousBody = document.querySelector<HTMLElement>('.import-workflow-body');
    const bodyScrollTop = previousBody?.scrollTop ?? 0;
    const detailsState = captureDetailsState();
    const focusState = captureFocusState();

    app.innerHTML = `
			${renderHeader()}
			<div class="import-workflow-body">
				${renderBackgroundValidationProgress()}
				${renderTargetBanner(session)}
				<div class="import-workflow-grid">
				<div class="import-main-column">
					${renderPreviewGrid(session)}
					${renderColumnEditor(session)}
				</div>
				<aside class="import-side-column">
					${renderSourceCard(session)}
					${renderReviewCard(session)}
				</aside>
			</div>
			</div>
			${renderExecutionProgress()}
			<footer class="import-workflow-footer">
				<span class="import-status ${escapeHtml(state.status?.kind || 'neutral')}" role="status" aria-live="polite"><i></i>${escapeHtml(state.status?.message || 'Review the preview and mapping before importing.')}</span>
				<button id="close-import" class="import-cancel-button" ${isWizardBusy() ? 'disabled' : ''}>Close</button>
				<button id="execute-import" class="primary import-submit-button" ${canExecute ? '' : 'disabled'}>${state.isExecuting ? '<span class="import-button-spinner"></span>Importing…' : state.isTransitioning ? 'Updating…' : 'Import data'} <span aria-hidden="true">→</span></button>
			</footer>`;

    restoreDetailsState(detailsState);
    restoreFocusState(focusState);
    const body = document.querySelector<HTMLElement>('.import-workflow-body');
    if (body) {
        body.scrollTop = bodyScrollTop;
    }

    attachListeners();
}

window.addEventListener('message', (event: MessageEvent<ImportWizardHostToWebviewMessage>) => {
    const message = asHostMessage(event.data || {});
    switch (message.type) {
        case 'sessionInitialized':
            state.status = null;
            state.backgroundValidation = null;
            state.executionProgress = null;
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
            if (state.isExecuting) {
                // The import progress panel must stay stable while rows are
                // being written; a full re-render would restart its spinner.
                return;
            }
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
            state.executionProgress = { phase: 'preparing', message: 'Starting import…' };
            state.status = { kind: 'info', message: 'Executing import...' };
            state.lastProgressAt = Date.now();
            render();
            return;
        case 'executionProgress':
            if (!state.isExecuting) {
                return;
            }
            state.executionProgress = message.progress;
            state.lastProgressAt = Date.now();
            if (!updateExecutionProgressPanel()) {
                render();
            }
            return;
        case 'executionFinished': {
            state.isExecuting = false;
            state.executionProgress = null;
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
            state.executionProgress = null;
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
