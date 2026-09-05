import { buildMysqlAlterTableSql } from '../../extensions/mysql/src/mysqlAlterTableDdl.js';
import type {
    MysqlAlterTableDesign,
    MysqlAlterTableDesignerColumn,
    MysqlAlterTableDesignerHostToWebviewMessage,
    MysqlAlterTableDesignerInitialContext,
    MysqlAlterTableDesignerOptions,
} from './hostContracts.js';
import { vscode } from './protocol.js';

const context = (window as unknown as { initialContext: MysqlAlterTableDesignerInitialContext }).initialContext;

const ENGINE_OPTIONS = ['InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE', 'BLACKHOLE', 'MERGE', 'NDB'];

const COMMON_COLUMN_TYPES = [
    'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT',
    'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'BIT(1)',
    'CHAR(10)', 'VARCHAR(255)', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'ENUM(\'a\',\'b\')', 'SET(\'a\',\'b\')',
    'BINARY(16)', 'VARBINARY(255)', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB',
    'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
    'JSON', 'GEOMETRY',
];

let contextValue: MysqlAlterTableDesignerInitialContext = context;
let columns: MysqlAlterTableDesignerColumn[] = context.columns.map(column => ({ ...column }));
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
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
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
    if (value && !list.some(candidate => identifierKey(candidate) === identifierKey(value))) {
        return [...list, value];
    }
    return list;
}

function renderOptions(): void {
    const engine = byId<HTMLSelectElement>('engine');
    const charset = byId<HTMLSelectElement>('charset');
    const autoIncrement = byId<HTMLInputElement>('autoIncrement');
    const comment = byId<HTMLInputElement>('tableComment');

    engine.replaceChildren();
    ensureIncluded(ENGINE_OPTIONS, contextValue.options.engine).forEach(value => appendOption(engine, value));
    engine.value = contextValue.options.engine;

    const charsets = ensureIncluded(contextValue.charsets, contextValue.options.charset);
    charset.replaceChildren();
    charsets.forEach(value => appendOption(charset, value));
    charset.value = contextValue.options.charset;

    renderCollations();

    autoIncrement.value = contextValue.options.autoIncrement || '';
    comment.value = contextValue.options.comment || '';
}

function collationsForCharset(charsetName: string): string[] {
    return contextValue.collations
        .filter(collation => identifierKey(collation.charset) === identifierKey(charsetName))
        .map(collation => collation.name);
}

function defaultCollationForCharset(charsetName: string): string {
    return collationsForCharset(charsetName)[0] ?? '';
}

function renderCollations(): void {
    const charset = byId<HTMLSelectElement>('charset');
    const collation = byId<HTMLSelectElement>('collation');
    const selectedCharset = charset.value;
    const collations = ensureIncluded(collationsForCharset(selectedCharset), contextValue.options.collation);
    const previousValue = collation.value;
    collation.replaceChildren();
    collations.forEach(value => appendOption(collation, value));
    if (previousValue && collations.some(candidate => candidate === previousValue)) {
        collation.value = previousValue;
    } else if (contextValue.options.collation && collations.some(candidate => candidate === contextValue.options.collation)) {
        collation.value = contextValue.options.collation;
    } else if (collations.length > 0) {
        collation.value = collations[0];
    }
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
        typeInput.placeholder = 'e.g. VARCHAR(255)';
        typeInput.setAttribute('list', 'mysqlCommonTypes');
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

        const autoCell = document.createElement('td');
        autoCell.className = 'center-cell';
        const autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = column.autoIncrement;
        autoCheckbox.title = 'AUTO_INCREMENT (column must be indexed)';
        autoCheckbox.addEventListener('change', () => {
            column.autoIncrement = autoCheckbox.checked;
            updateDDL();
        });
        autoCell.appendChild(autoCheckbox);

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

        row.append(ordinal, nameCell, typeCell, nullCell, defaultCell, autoCell, commentCell, flagsCell, actionsCell);
        tbody.appendChild(row);
    });
}

function readOptions(): MysqlAlterTableDesignerOptions {
    return {
        engine: byId<HTMLSelectElement>('engine').value,
        charset: byId<HTMLSelectElement>('charset').value,
        collation: byId<HTMLSelectElement>('collation').value,
        autoIncrement: byId<HTMLInputElement>('autoIncrement').value,
        comment: byId<HTMLInputElement>('tableComment').value,
    };
}

function buildDesign(): MysqlAlterTableDesign {
    return {
        columns: columns.map(column => ({ ...column })),
        options: readOptions(),
    };
}

function updateDDL(): void {
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        const ddl = buildMysqlAlterTableSql(contextValue, buildDesign());
        preview.value = ddl || '-- No changes detected yet.\n-- Adjust a column or a table option to preview the ALTER TABLE statement.';
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
    const datalist = byId<HTMLDataListElement>('mysqlCommonTypes');
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

function handleHostMessage(message: MysqlAlterTableDesignerHostToWebviewMessage): void {
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

window.addEventListener('message', (event: MessageEvent<MysqlAlterTableDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || !('command' in message)) {
        return;
    }
    handleHostMessage(message);
});

document.addEventListener('DOMContentLoaded', () => {
    populateCommonTypes();
    renderAll();

    byId<HTMLSelectElement>('engine').addEventListener('change', updateDDL);
    byId<HTMLSelectElement>('charset').addEventListener('change', () => {
        const charset = byId<HTMLSelectElement>('charset');
        const collation = byId<HTMLSelectElement>('collation');
        const currentCollation = collation.value;
        const currentCharset = contextValue.collations.find(candidate => candidate.name === currentCollation)?.charset ?? '';
        renderCollations();
        if (identifierKey(currentCharset) !== identifierKey(charset.value)) {
            collation.value = defaultCollationForCharset(charset.value);
        }
        updateDDL();
    });
    byId<HTMLSelectElement>('collation').addEventListener('change', () => {
        const collation = byId<HTMLSelectElement>('collation');
        const charset = byId<HTMLSelectElement>('charset');
        const collationCharset = contextValue.collations.find(candidate => candidate.name === collation.value)?.charset ?? '';
        if (collationCharset && identifierKey(collationCharset) !== identifierKey(charset.value)) {
            charset.value = collationCharset;
        }
        updateDDL();
    });
    byId<HTMLInputElement>('autoIncrement').addEventListener('input', updateDDL);
    byId<HTMLInputElement>('tableComment').addEventListener('input', updateDDL);

    byId('addColumnBtn').addEventListener('click', () => {
        const lastOrdinal = columns.reduce((max, column) => Math.max(max, column.ordinal), 0);
        columns.push({
            name: '',
            type: 'VARCHAR(255)',
            notNull: false,
            defaultValue: '',
            autoIncrement: false,
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