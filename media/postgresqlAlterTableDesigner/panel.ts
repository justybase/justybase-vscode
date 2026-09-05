import { buildPostgresqlAlterTableSql } from '../../extensions/postgresql/src/postgresqlAlterTableDdl.js';
import type {
    PostgresqlAlterTableDesign,
    PostgresqlAlterTableDesignerColumn,
    PostgresqlAlterTableDesignerHostToWebviewMessage,
    PostgresqlAlterTableDesignerInitialContext,
    PostgresqlAlterTableDesignerOptions,
} from './hostContracts.js';
import { vscode } from './protocol.js';

const context = (window as unknown as { initialContext: PostgresqlAlterTableDesignerInitialContext }).initialContext;

const COMMON_COLUMN_TYPES = [
    'integer', 'bigint', 'smallint', 'numeric(10,2)', 'real', 'double precision',
    'character varying(255)', 'varchar(255)', 'character(10)', 'text',
    'date', 'time', 'timestamp without time zone', 'timestamp with time zone',
    'interval', 'boolean', 'uuid', 'jsonb', 'bytea',
];

let contextValue: PostgresqlAlterTableDesignerInitialContext = context;
let columns: PostgresqlAlterTableDesignerColumn[] = context.columns.map(column => ({ ...column }));
let originalNames = new Set(context.columns.map(column => identifierKey(column.name)));

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as T;
}

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase();
    }
    return trimmed.toLowerCase();
}

function setStatus(text: string, variant: 'error' | 'info'): void {
    const banner = byId('statusBanner');
    banner.textContent = text;
    banner.className = `status-banner ${variant}`;
}

function clearStatus(): void {
    const banner = byId('statusBanner');
    banner.textContent = '';
    banner.className = 'status-banner hidden';
}

function appendOption(select: HTMLSelectElement, value: string): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
}

function ensureIncluded(list: string[], value: string): string[] {
    if (value && !list.some(candidate => candidate === value)) {
        return [...list, value];
    }
    return list;
}

function renderOptions(): void {
    const tablespace = byId<HTMLSelectElement>('tablespace');
    const fillfactor = byId<HTMLInputElement>('fillfactor');
    const comment = byId<HTMLInputElement>('tableComment');

    const tablespaces = ensureIncluded(contextValue.tablespaces, contextValue.options.tablespace);
    tablespace.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '(database default)';
    tablespace.appendChild(defaultOption);
    tablespaces.forEach(value => appendOption(tablespace, value));
    tablespace.value = contextValue.options.tablespace;

    fillfactor.value = contextValue.options.fillfactor || '';
    comment.value = contextValue.options.comment || '';
}

function appendBadge(parent: HTMLElement, text: string): void {
    const badge = document.createElement('span');
    badge.className = 'column-badge';
    badge.textContent = text;
    parent.appendChild(badge);
}

function renderColumns(): void {
    const tbody = byId<HTMLTableSectionElement>('columnsBody');
    tbody.replaceChildren();

    columns.forEach((column, index) => {
        const row = document.createElement('tr');
        const isOriginal = originalNames.has(identifierKey(column.name));
        const isPrimary = column.isPrimaryKey;

        const ordinal = document.createElement('td');
        ordinal.className = 'ordinal';
        ordinal.textContent = String(index + 1);

        const nameCell = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = column.name;
        nameInput.placeholder = 'column_name';
        nameInput.readOnly = isOriginal;
        nameInput.title = isOriginal ? 'Existing column names are read-only in the Alter Table Designer.' : '';
        nameInput.addEventListener('input', () => {
            column.name = nameInput.value;
            updateDDL();
        });
        nameCell.appendChild(nameInput);

        const typeCell = document.createElement('td');
        const typeInput = document.createElement('input');
        typeInput.type = 'text';
        typeInput.value = column.type;
        typeInput.placeholder = 'e.g. character varying(120)';
        typeInput.setAttribute('list', 'postgresqlCommonTypes');
        typeInput.addEventListener('input', () => {
            column.type = typeInput.value;
            updateDDL();
        });
        typeCell.appendChild(typeInput);

        const nullCell = document.createElement('td');
        nullCell.className = 'center-cell';
        const nullCheckbox = document.createElement('input');
        nullCheckbox.type = 'checkbox';
        nullCheckbox.checked = !column.notNull;
        nullCheckbox.title = 'Allow NULL';
        nullCheckbox.addEventListener('change', () => {
            column.notNull = !nullCheckbox.checked;
            updateDDL();
        });
        nullCell.appendChild(nullCheckbox);

        const defaultCell = document.createElement('td');
        const defaultInput = document.createElement('input');
        defaultInput.type = 'text';
        defaultInput.value = column.defaultValue;
        defaultInput.placeholder = 'none';
        defaultInput.addEventListener('input', () => {
            column.defaultValue = defaultInput.value;
            updateDDL();
        });
        defaultCell.appendChild(defaultInput);

        const commentCell = document.createElement('td');
        const commentInput = document.createElement('input');
        commentInput.type = 'text';
        commentInput.value = column.comment;
        commentInput.placeholder = 'comment';
        commentInput.addEventListener('input', () => {
            column.comment = commentInput.value;
            updateDDL();
        });
        commentCell.appendChild(commentInput);

        const flagsCell = document.createElement('td');
        flagsCell.className = 'column-badges';
        if (column.isPrimaryKey) appendBadge(flagsCell, 'PK');
        if (column.isForeignKey) appendBadge(flagsCell, 'FK');

        const actionsCell = document.createElement('td');
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'row-button danger';
        deleteButton.textContent = 'Remove';
        deleteButton.disabled = isPrimary;
        deleteButton.title = isPrimary
            ? 'The PRIMARY KEY column cannot be dropped from the Alter Table Designer.'
            : `Remove ${column.name} from the design`;
        deleteButton.addEventListener('click', () => {
            columns = columns.filter(candidate => candidate !== column);
            updateDDL();
            renderColumns();
        });
        actionsCell.appendChild(deleteButton);

        row.append(ordinal, nameCell, typeCell, nullCell, defaultCell, commentCell, flagsCell, actionsCell);
        tbody.appendChild(row);
    });
}

function readOptions(): PostgresqlAlterTableDesignerOptions {
    return {
        tablespace: byId<HTMLSelectElement>('tablespace').value,
        fillfactor: byId<HTMLInputElement>('fillfactor').value,
        comment: byId<HTMLInputElement>('tableComment').value,
    };
}

function buildDesign(): PostgresqlAlterTableDesign {
    return {
        columns: columns.map(column => ({ ...column })),
        options: readOptions(),
    };
}

function updateDDL(): void {
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        const ddl = buildPostgresqlAlterTableSql(contextValue, buildDesign());
        preview.value = ddl || '-- No changes detected yet.\n-- Adjust a column or a table option to preview the ALTER TABLE statements.';
    } catch (error) {
        preview.value = `-- ${error instanceof Error ? error.message : String(error)}`;
    }
}

function validateDesign(): string | null {
    if (columns.length === 0) {
        return 'The table must have at least one column.';
    }
    for (const column of columns) {
        if (!column.name.trim()) {
            return 'Every column needs a name before executing DDL.';
        }
        if (!column.type.trim()) {
            return `Column "${column.name}" needs a data type before executing DDL.`;
        }
    }
    return null;
}

function populateCommonTypes(): void {
    const datalist = byId<HTMLDataListElement>('postgresqlCommonTypes');
    COMMON_COLUMN_TYPES.forEach(type => {
        const option = document.createElement('option');
        option.value = type;
        datalist.appendChild(option);
    });
}

function resetDesignFromContext(): void {
    columns = contextValue.columns.map(column => ({ ...column }));
    originalNames = new Set(contextValue.columns.map(column => identifierKey(column.name)));
}

function renderAll(): void {
    renderOptions();
    renderColumns();
    updateDDL();
}

function handleHostMessage(message: PostgresqlAlterTableDesignerHostToWebviewMessage): void {
    switch (message.command) {
        case 'setError':
            setStatus(message.text, 'error');
            return;
        case 'setInfo':
            setStatus(message.text, 'info');
            return;
        case 'clearStatus':
            clearStatus();
            return;
        case 'setExecuting':
            byId<HTMLButtonElement>('executeDdlBtn').disabled = message.executing;
            byId<HTMLButtonElement>('executeDdlBtn').textContent = message.executing ? 'Executing…' : 'Execute';
            return;
        case 'setContext':
            contextValue = message.context;
            resetDesignFromContext();
            renderAll();
            return;
    }
}

window.addEventListener('message', (event: MessageEvent<PostgresqlAlterTableDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || !('command' in message)) {
        return;
    }
    handleHostMessage(message);
});

document.addEventListener('DOMContentLoaded', () => {
    populateCommonTypes();
    renderAll();

    byId<HTMLSelectElement>('tablespace').addEventListener('change', updateDDL);
    byId<HTMLInputElement>('fillfactor').addEventListener('input', updateDDL);
    byId<HTMLInputElement>('tableComment').addEventListener('input', updateDDL);

    byId('addColumnBtn').addEventListener('click', () => {
        const lastOrdinal = columns.reduce((max, column) => Math.max(max, column.ordinal), 0);
        columns.push({
            name: '',
            type: 'character varying(255)',
            notNull: false,
            defaultValue: '',
            comment: '',
            ordinal: lastOrdinal + 1,
            isPrimaryKey: false,
            isForeignKey: false,
        });
        renderColumns();
        updateDDL();
    });

    byId('executeDdlBtn').addEventListener('click', () => {
        clearStatus();
        const validationError = validateDesign();
        if (validationError) {
            setStatus(validationError, 'error');
            return;
        }
        vscode.postMessage({ command: 'executeDesign', design: buildDesign() });
    });

    byId('copyDdlBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'copyDDL', design: buildDesign() });
    });

    byId('saveAsSqlBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'saveAsSql', design: buildDesign() });
    });

    byId('reloadBtn').addEventListener('click', () => {
        vscode.postMessage({ command: 'reload' });
    });
});