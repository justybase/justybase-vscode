/**
 * Structure tab: object properties or table comment, column list with inline
 * comment editing, and add/drop column. Tables are editable; views and
 * procedures render the same layout read-only.
 */
import type { EditDataMetadata, EditDataPanelWebviewToHostMessage } from './hostContracts.js';
import { classifyType, typeBadge } from './state.js';
import { confirmDialog } from './dialog.js';
import { escapeHtml } from './utils.js';

const COMMON_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'BYTEINT', 'NUMERIC(18,2)', 'DOUBLE PRECISION', 'REAL',
    'VARCHAR(255)', 'NVARCHAR(255)', 'CHAR(1)', 'DATE', 'TIMESTAMP', 'TIME', 'BOOLEAN',
];

const BADGE_CLASS: Record<string, string> = { number: 'tn', text: 'tt', date: 'td', bool: 'tb2', other: 'to' };

const TRASH = '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>';

export interface StructureOptions {
    /** Tables are editable; everything else is inspected read-only. */
    readOnly?: boolean;
    objectKind?: 'table' | 'view' | 'procedure';
}

function flag(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

function typeCell(formatType: string): string {
    const family = classifyType(formatType);
    const badge = typeBadge(formatType);
    return `${badge ? `<span class="tb ${BADGE_CLASS[family]}">${escapeHtml(badge)}</span>` : ''}<span>${escapeHtml(formatType)}</span>`;
}

function wireFilter(container: HTMLElement): void {
    const filter = container.querySelector<HTMLInputElement>('#structFilter');
    const empty = container.querySelector<HTMLElement>('#structEmpty');
    filter?.addEventListener('input', () => {
        const needle = filter.value.trim().toLowerCase();
        let visible = 0;
        container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-name]').forEach(tr => {
            const show = !needle || (tr.dataset.name ?? '').includes(needle);
            tr.hidden = !show;
            if (show) visible++;
        });
        if (empty) empty.hidden = visible > 0;
    });
}

/** Procedures expose catalog properties and positional arguments, not columns. */
function renderProcedureStructure(container: HTMLElement, metadata: EditDataMetadata): void {
    const properties = metadata.properties ?? [];
    const args = metadata.arguments ?? [];

    const propertyRows = properties.map(property => `<div class="struct-property">
            <dt>${escapeHtml(property.label)}</dt>
            <dd>${escapeHtml(property.value || '—')}</dd>
        </div>`).join('');

    const argRows = args.map((arg, index) => `<tr data-name="${escapeHtml(arg.type.toLowerCase())}">
            <td class="gutter">${arg.position || index + 1}</td>
            <td class="col-type">${typeCell(arg.type)}</td>
        </tr>`).join('');

    container.innerHTML = `
        <section class="struct-section">
            <div class="section-head">
                <h3>Definition</h3>
            </div>
            <dl class="struct-properties">${propertyRows}</dl>
        </section>
        <section class="struct-section struct-section--grow">
            <div class="section-head">
                <h3>Arguments <span class="count">${args.length}</span></h3>
                <input type="search" id="structFilter" class="section-filter" spellcheck="false" placeholder="Filter arguments…">
            </div>
            <div class="struct-grid-wrap">
                ${args.length === 0
                    ? '<div class="empty-state">This procedure has no arguments.</div>'
                    : `<table class="struct-grid struct-grid--compact">
                    <colgroup><col style="width:44px"><col></colgroup>
                    <thead><tr><th class="gutter-head">#</th><th>Data type</th></tr></thead>
                    <tbody>${argRows}</tbody>
                </table>`}
                <div id="structEmpty" class="grid-empty" hidden>No arguments match the filter</div>
            </div>
        </section>`;

    wireFilter(container);
}

function renderColumnStructure(
    container: HTMLElement,
    metadata: EditDataMetadata,
    post: (message: EditDataPanelWebviewToHostMessage) => void,
    showError: (message: string) => void,
    objectKind: 'table' | 'view',
    readOnly: boolean,
): void {
    const columns = metadata.columns;
    let savedComment = metadata.tableComment || '';

    const rows = columns.map((col, index) => {
        const defaultValue = col.COLDEFAULT
            ? `<span class="val-default">${escapeHtml(col.COLDEFAULT)}</span>`
            : '<span class="val-null">—</span>';
        const name = escapeHtml(col.ATTNAME);
        const keys = `${flag(col.IS_PK) ? '<span class="key-mark pk" title="Primary key">PK</span>' : ''}${flag(col.IS_FK) ? '<span class="key-mark fk" title="Foreign key">FK</span>' : ''}`;
        const comment = col.DESCRIPTION
            ? `<span class="col-comment-readonly" title="${escapeHtml(col.DESCRIPTION)}">${escapeHtml(col.DESCRIPTION)}</span>`
            : '<span class="val-null">—</span>';
        return `<tr data-name="${name.toLowerCase()}">
            <td class="gutter">${index + 1}</td>
            <td class="col-name"><span class="col-name__text">${name}</span>${keys}</td>
            <td class="col-type">${typeCell(col.FORMAT_TYPE)}</td>
            <td class="center">${flag(col.IS_NOT_NULL) ? '<span class="check" title="NOT NULL">✓</span>' : ''}</td>
            <td>${defaultValue}</td>
            <td class="comment-cell">${readOnly
                ? comment
                : `<input type="text" class="inline-edit col-comment" spellcheck="false"
                data-col="${name}" data-saved="${escapeHtml(col.DESCRIPTION || '')}"
                value="${escapeHtml(col.DESCRIPTION || '')}" placeholder="Add comment…" title="Enter to save, Escape to revert">`}</td>
            ${readOnly ? '' : `<td class="row-actions"><button type="button" class="icon-only ghost danger-hover drop-col-btn" data-col="${name}" title="Drop column ${name}">${TRASH}</button></td>`}
        </tr>`;
    }).join('');

    const commentHeading = objectKind === 'view' ? 'View comment' : 'Table comment';
    const commentPlaceholder = objectKind === 'view'
        ? 'Describe what this view contains…'
        : 'Describe what this table contains…';

    container.innerHTML = `
        <section class="struct-section">
            <div class="section-head">
                <h3>${commentHeading}</h3>
                ${readOnly ? '' : `<span class="toolbar-spacer"></span>
                <button type="button" id="revertTableCommentBtn" hidden>Revert</button>
                <button type="button" id="saveTableCommentBtn" class="primary" disabled>Save comment</button>`}
            </div>
            <textarea id="tableCommentBox" class="comment-box${readOnly ? ' is-readonly' : ''}" rows="2" spellcheck="false"${readOnly ? ' readonly' : ''} placeholder="${commentPlaceholder}">${escapeHtml(savedComment)}</textarea>
        </section>
        <section class="struct-section struct-section--grow">
            <div class="section-head">
                <h3>Columns <span class="count">${columns.length}</span></h3>
                <input type="search" id="structFilter" class="section-filter" spellcheck="false" placeholder="Filter columns…">
                ${readOnly ? '' : `<span class="toolbar-spacer"></span>
                <button type="button" id="showAddColumnBtn">${PLUS}<span>Add column</span></button>`}
            </div>
            <div class="struct-grid-wrap">
                <table class="struct-grid">
                    <colgroup><col style="width:44px"><col style="width:26%"><col style="width:20%"><col style="width:76px"><col style="width:14%"><col>${readOnly ? '' : '<col style="width:40px">'}</colgroup>
                    <thead><tr>
                        <th class="gutter-head">#</th><th>Name</th><th>Type</th><th class="center">Not null</th><th>Default</th><th>Comment</th>${readOnly ? '' : '<th></th>'}
                    </tr></thead>
                    <tbody>${rows}</tbody>
                    ${readOnly ? '' : `<tbody id="addColumnRow" hidden>
                        <tr class="add-row">
                            <td class="gutter">+</td>
                            <td><input type="text" id="newColName" class="inline-edit boxed" spellcheck="false" placeholder="COLUMN_NAME"></td>
                            <td><input type="text" id="newColType" class="inline-edit boxed" spellcheck="false" placeholder="VARCHAR(255)" list="columnTypeList"></td>
                            <td colspan="4" class="add-row__actions">
                                <button type="button" id="cancelAddColBtn">Cancel</button>
                                <button type="button" id="addColBtn" class="primary">Add column</button>
                            </td>
                        </tr>
                    </tbody>`}
                </table>
                <datalist id="columnTypeList">${COMMON_TYPES.map(t => `<option value="${t}"></option>`).join('')}</datalist>
                <div id="structEmpty" class="grid-empty" hidden>No columns match the filter</div>
            </div>
        </section>`;

    if (readOnly) {
        wireFilter(container);
        return;
    }

    // Table comment
    const commentBox = container.querySelector<HTMLTextAreaElement>('#tableCommentBox');
    const saveComment = container.querySelector<HTMLButtonElement>('#saveTableCommentBtn');
    const revertComment = container.querySelector<HTMLButtonElement>('#revertTableCommentBtn');
    const syncComment = () => {
        const dirty = (commentBox?.value ?? '') !== savedComment;
        if (saveComment) saveComment.disabled = !dirty;
        if (revertComment) revertComment.hidden = !dirty;
        commentBox?.classList.toggle('dirty', dirty);
    };
    commentBox?.addEventListener('input', syncComment);
    commentBox?.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            saveComment?.click();
        }
    });
    saveComment?.addEventListener('click', () => {
        const comment = commentBox?.value ?? '';
        post({ command: 'updateTableComment', comment });
        savedComment = comment;
        metadata.tableComment = comment;
        syncComment();
    });
    revertComment?.addEventListener('click', () => {
        if (commentBox) commentBox.value = savedComment;
        syncComment();
    });

    // Column comments
    container.querySelectorAll<HTMLInputElement>('.col-comment').forEach(input => {
        const sync = () => input.classList.toggle('dirty', input.value !== (input.dataset.saved ?? ''));
        input.addEventListener('input', sync);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') input.blur();
            if (event.key === 'Escape') {
                input.value = input.dataset.saved ?? '';
                sync();
                input.blur();
            }
        });
        input.addEventListener('blur', () => {
            const column = input.dataset.col;
            if (!column || input.value === (input.dataset.saved ?? '')) return;
            post({ command: 'updateColumnComment', column, comment: input.value });
            input.dataset.saved = input.value;
            const meta = columns.find(c => c.ATTNAME === column);
            if (meta) meta.DESCRIPTION = input.value;
            sync();
        });
    });

    // Drop column (confirmation rendered in-webview; window.confirm is blocked)
    container.querySelectorAll<HTMLButtonElement>('.drop-col-btn').forEach(button => {
        button.addEventListener('click', async () => {
            const column = button.dataset.col;
            if (!column) return;
            const ok = await confirmDialog({
                title: `Drop column ${column}?`,
                message: `ALTER TABLE … DROP COLUMN ${column} permanently removes the column and its data. This cannot be undone.`,
                confirmLabel: 'Drop column',
                danger: true,
            });
            if (ok) post({ command: 'dropColumn', column });
        });
    });

    wireFilter(container);

    // Add column
    const addRow = container.querySelector<HTMLElement>('#addColumnRow');
    const nameInput = container.querySelector<HTMLInputElement>('#newColName');
    const typeInput = container.querySelector<HTMLInputElement>('#newColType');
    const showAdd = (show: boolean) => {
        if (addRow) addRow.hidden = !show;
        if (show) nameInput?.focus();
    };
    container.querySelector('#showAddColumnBtn')?.addEventListener('click', () => showAdd(true));
    container.querySelector('#cancelAddColBtn')?.addEventListener('click', () => showAdd(false));
    const submitAdd = () => {
        const name = nameInput?.value.trim() ?? '';
        const type = typeInput?.value.trim() ?? '';
        if (!name || !type) {
            showError('Column name and type are required.');
            (name ? typeInput : nameInput)?.focus();
            return;
        }
        post({ command: 'addColumn', name, type });
    };
    container.querySelector('#addColBtn')?.addEventListener('click', submitAdd);
    [nameInput, typeInput].forEach(input => input?.addEventListener('keydown', event => {
        if (event.key === 'Enter') submitAdd();
        if (event.key === 'Escape') showAdd(false);
    }));
}

export function renderStructure(
    container: HTMLElement,
    metadata: EditDataMetadata | null,
    post: (message: EditDataPanelWebviewToHostMessage) => void,
    showError: (message: string) => void,
    options: StructureOptions = {},
): void {
    if (!metadata) {
        container.innerHTML = '<div class="empty-state">No metadata available</div>';
        return;
    }

    const objectKind = metadata.objectKind ?? options.objectKind ?? 'table';
    if (objectKind === 'procedure') {
        renderProcedureStructure(container, metadata);
        return;
    }

    renderColumnStructure(
        container,
        metadata,
        post,
        showError,
        objectKind === 'view' ? 'view' : 'table',
        options.readOnly === true || objectKind !== 'table',
    );
}
