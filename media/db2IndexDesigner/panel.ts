import {
    buildDb2CreateIndexSql,
    type Db2IndexKeyColumn
} from '../../extensions/db2/src/db2DesignerDdl.js';
import type {
    Db2IndexDesignerHostToWebviewMessage,
    Db2IndexDesignerInitialContext
} from './hostContracts.js';
import { vscode } from './protocol.js';

interface KeyColumn extends Db2IndexKeyColumn {
    id: number;
}

const context = (window as unknown as { initialContext: Db2IndexDesignerInitialContext }).initialContext;
const columnNames = context.columns.map(column => column.name);
let nextKeyColumnId = 1;
let keyColumns: KeyColumn[] = columnNames.length > 0
    ? [{ id: nextKeyColumnId++, name: columnNames[0], order: 'ASC' }]
    : [];
let indexNameTouched = false;

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as T;
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

function getIndexName(): HTMLInputElement {
    return byId<HTMLInputElement>('indexName');
}

function suggestedIndexName(): string {
    const key = keyColumns[0]?.name || 'COLUMN';
    return `${context.tableName}_${key}_IDX`;
}

function appendOption(select: HTMLSelectElement | HTMLDataListElement, value: string, label = value): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

function populateStaticLists(): void {
    const tablespaces = byId<HTMLDataListElement>('tablespaces');
    context.tablespaces.forEach(tablespace => appendOption(tablespaces, tablespace));

    const includeColumns = byId<HTMLSelectElement>('includeColumns');
    columnNames.forEach(column => appendOption(includeColumns, column, column));

    const existingHint = byId('existingIndexesHint');
    if (context.existingIndexes.length === 0) {
        existingHint.textContent = 'No user indexes found.';
    } else {
        existingHint.textContent = `Existing: ${context.existingIndexes.map(index => index.name).join(', ')}`;
    }
}

function createColumnSelect(value: string, onChange: (newValue: string) => void): HTMLSelectElement {
    const select = document.createElement('select');
    columnNames.forEach(column => appendOption(select, column, column));
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

function createOrderSelect(value: 'ASC' | 'DESC', onChange: (newValue: 'ASC' | 'DESC') => void): HTMLSelectElement {
    const select = document.createElement('select');
    appendOption(select, 'ASC');
    appendOption(select, 'DESC');
    select.value = value;
    select.addEventListener('change', () => onChange(select.value as 'ASC' | 'DESC'));
    return select;
}

function createRowButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-button';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

function renderKeyColumns(): void {
    const container = byId('keyColumns');
    container.replaceChildren();
    keyColumns.forEach((keyColumn, index) => {
        const row = document.createElement('div');
        row.className = 'key-column-row';
        const ordinal = document.createElement('span');
        ordinal.className = 'ordinal';
        ordinal.textContent = String(index + 1);
        row.appendChild(ordinal);
        row.appendChild(createColumnSelect(keyColumn.name, name => {
            keyColumn.name = name;
            updateSuggestedIndexName();
            refreshDdl();
        }));
        row.appendChild(createOrderSelect(keyColumn.order, order => {
            keyColumn.order = order;
            refreshDdl();
        }));
        row.appendChild(createRowButton('Up', 'Move column up', () => moveKeyColumn(index, -1)));
        row.appendChild(createRowButton('Down', 'Move column down', () => moveKeyColumn(index, 1)));
        row.appendChild(createRowButton('Remove', 'Remove key column', () => {
            keyColumns = keyColumns.filter(column => column.id !== keyColumn.id);
            updateSuggestedIndexName();
            renderKeyColumns();
            refreshDdl();
        }));
        container.appendChild(row);
    });
    updateIncludeColumnAvailability();
}

function moveKeyColumn(index: number, delta: number): void {
    const destination = index + delta;
    if (destination < 0 || destination >= keyColumns.length) {
        return;
    }
    [keyColumns[index], keyColumns[destination]] = [keyColumns[destination], keyColumns[index]];
    renderKeyColumns();
    refreshDdl();
}

function updateSuggestedIndexName(): void {
    if (!indexNameTouched) {
        getIndexName().value = suggestedIndexName();
    }
}

function updateIncludeColumnAvailability(): void {
    const keyColumnNames = new Set(keyColumns.map(column => column.name));
    const select = byId<HTMLSelectElement>('includeColumns');
    for (const option of Array.from(select.options)) {
        option.disabled = keyColumnNames.has(option.value);
        if (option.disabled) {
            option.selected = false;
        }
    }
}

function optionalPercent(id: string, label: string): number | undefined {
    const value = byId<HTMLInputElement>(id).value.trim();
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99) {
        throw new Error(`${label} must be an integer from 0 to 99.`);
    }
    return parsed;
}

function buildDdl(): string {
    const indexName = getIndexName().value.trim();
    if (!indexName) {
        throw new Error('Enter an index name.');
    }
    if (context.existingIndexes.some(index => index.name.toUpperCase() === indexName.toUpperCase())) {
        throw new Error(`An index named ${indexName} already exists on this table.`);
    }
    const duplicateKeys = keyColumns.some((column, index) => keyColumns.findIndex(other => other.name === column.name) !== index);
    if (duplicateKeys) {
        throw new Error('A key column can only be selected once.');
    }
    const includeColumns = Array.from(byId<HTMLSelectElement>('includeColumns').selectedOptions).map(option => option.value);
    return buildDb2CreateIndexSql({
        schema: context.schema,
        tableName: context.tableName,
        indexName,
        keyColumns,
        includeColumns,
        unique: byId<HTMLInputElement>('unique').checked,
        clustered: byId<HTMLInputElement>('clustered').checked,
        reverseScans: valueOrUndefined<'allow' | 'disallow'>('reverseScans'),
        compress: valueOrUndefined<'yes' | 'no'>('compress'),
        pctFree: optionalPercent('pctFree', 'PCTFREE'),
        level2PctFree: optionalPercent('level2PctFree', 'LEVEL2 PCTFREE'),
        minPctUsed: optionalPercent('minPctUsed', 'MINPCTUSED'),
        pageSplit: valueOrUndefined<'symmetric' | 'high'>('pageSplit'),
        collectStatistics: valueOrUndefined<'sampled' | 'detailed'>('collectStatistics'),
        tablespace: byId<HTMLInputElement>('tablespace').value,
        additionalClause: byId<HTMLTextAreaElement>('additionalClause').value
    });
}

function valueOrUndefined<T extends string>(id: string): T | undefined {
    const value = byId<HTMLSelectElement>(id).value;
    return value ? value as T : undefined;
}

function refreshDdl(): void {
    updateIncludeColumnAvailability();
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        preview.value = buildDdl();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        preview.value = `-- ${message}`;
    }
}

function getExecutableDdl(): string | undefined {
    try {
        const ddl = buildDdl();
        byId<HTMLTextAreaElement>('ddlPreview').value = ddl;
        clearStatus();
        return ddl;
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
    }
}

function setExecuting(executing: boolean): void {
    const execute = byId<HTMLButtonElement>('executeDdlBtn');
    const save = byId<HTMLButtonElement>('saveAsSqlBtn');
    const copy = byId<HTMLButtonElement>('copyDdlBtn');
    execute.disabled = executing;
    save.disabled = executing;
    copy.disabled = executing;
    execute.textContent = executing ? 'Executing...' : 'Execute';
}

function handleHostMessage(message: Db2IndexDesignerHostToWebviewMessage): void {
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
            setExecuting(message.executing);
            return;
    }
}

function bindInputUpdates(): void {
    const ids = ['indexName', 'tablespace', 'unique', 'clustered', 'reverseScans', 'compress', 'pctFree', 'level2PctFree', 'minPctUsed', 'pageSplit', 'collectStatistics', 'additionalClause', 'includeColumns'];
    ids.forEach(id => {
        const element = byId<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
        element.addEventListener('input', refreshDdl);
        element.addEventListener('change', refreshDdl);
    });
    getIndexName().addEventListener('input', () => {
        indexNameTouched = true;
    });
}

function initialize(): void {
    populateStaticLists();
    getIndexName().value = suggestedIndexName();
    renderKeyColumns();
    bindInputUpdates();
    byId<HTMLButtonElement>('addKeyColumnBtn').addEventListener('click', () => {
        const available = columnNames.find(name => !keyColumns.some(column => column.name === name)) ?? columnNames[0];
        if (!available) {
            return;
        }
        keyColumns.push({ id: nextKeyColumnId++, name: available, order: 'ASC' });
        updateSuggestedIndexName();
        renderKeyColumns();
        refreshDdl();
    });
    byId<HTMLButtonElement>('executeDdlBtn').addEventListener('click', () => {
        const ddl = getExecutableDdl();
        if (ddl) {
            vscode.postMessage({ command: 'executeDDL', ddl });
        }
    });
    byId<HTMLButtonElement>('saveAsSqlBtn').addEventListener('click', () => {
        const ddl = getExecutableDdl();
        if (ddl) {
            vscode.postMessage({ command: 'saveAsSql', ddl });
        }
    });
    byId<HTMLButtonElement>('copyDdlBtn').addEventListener('click', () => {
        const ddl = getExecutableDdl();
        if (ddl) {
            vscode.postMessage({ command: 'copyDDL', ddl });
        }
    });
    refreshDdl();
}

window.addEventListener('message', (event: MessageEvent<Db2IndexDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (message && typeof message === 'object' && 'command' in message) {
        handleHostMessage(message);
    }
});

initialize();
