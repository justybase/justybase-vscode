import {
    buildMysqlCreateIndexSql,
    type MysqlIndexKeyColumn,
} from '../../extensions/mysql/src/mysqlDesignerDdl.js';
import type {
    MysqlDesignerColumn,
    MysqlIndexDesign,
    MysqlIndexDesignerHostToWebviewMessage,
    MysqlIndexDesignerInitialContext,
} from './hostContracts.js';
import { vscode } from './protocol.js';

interface KeyColumn extends MysqlIndexKeyColumn {
    id: number;
}

let context = (window as unknown as { initialContext: MysqlIndexDesignerInitialContext }).initialContext;
let columns = [...context.columns].sort((left, right) => left.ordinal - right.ordinal);
let nextKeyColumnId = 1;
let keyColumns: KeyColumn[] = [];
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

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
    }
    return trimmed.toLowerCase();
}

function appendOption(select: HTMLSelectElement, value: string): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
}

function suggestedIndexName(): string {
    return `${context.tableName}_${keyColumns[0]?.name || 'COLUMN'}_IDX`;
}

function updateHeader(): void {
    byId('engineName').textContent = context.engine;
    byId('descendingHint').textContent = context.supportsDescendingIndexes
        ? 'DESC is available for this InnoDB table.'
        : 'Only ASC is available for this table and server combination.';
    byId('existingIndexesHint').textContent = `${context.existingIndexes.length} index${context.existingIndexes.length === 1 ? '' : 'es'}`;
}

function renderExistingIndexes(): void {
    const body = byId<HTMLTableSectionElement>('existingIndexesBody');
    body.replaceChildren();
    if (context.existingIndexes.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = 'No indexes found.';
        row.appendChild(cell);
        body.appendChild(row);
        return;
    }

    context.existingIndexes.forEach(index => {
        const row = document.createElement('tr');
        const parts = index.parts.map(part => {
            const name = part.expression || part.name || '(expression)';
            const prefix = part.prefixLength === undefined ? '' : `(${part.prefixLength})`;
            return `${name}${prefix} ${part.order}`;
        });
        const properties = [
            index.isPrimary ? 'PRIMARY' : undefined,
            index.isUnique ? 'UNIQUE' : undefined,
            index.isVisible === false ? 'INVISIBLE' : undefined,
            index.cardinality === undefined ? undefined : `cardinality ${index.cardinality.toLocaleString()}`,
        ].filter((property): property is string => Boolean(property));
        [index.name, parts.join(', ') || '-', index.indexType, properties.join(', ') || '-'].forEach(value => {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
        });
        const actions = document.createElement('td');
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'row-button danger';
        drop.textContent = 'Drop';
        drop.disabled = index.isPrimary;
        drop.title = index.isPrimary ? 'The PRIMARY index cannot be dropped here.' : `Drop ${index.name}`;
        drop.addEventListener('click', () => vscode.postMessage({ command: 'dropIndex', indexName: index.name }));
        actions.appendChild(drop);
        row.appendChild(actions);
        body.appendChild(row);
    });
}

function columnMatches(column: MysqlDesignerColumn, query: string): boolean {
    return !query || `${column.name} ${column.type} ${column.description}`.toLowerCase().includes(query.toLowerCase());
}

function appendBadge(parent: HTMLElement, text: string): void {
    const badge = document.createElement('span');
    badge.className = 'column-badge';
    badge.textContent = text;
    parent.appendChild(badge);
}

function toggleKeyColumn(name: string, selected: boolean): void {
    const existing = keyColumns.find(column => identifierKey(column.name) === identifierKey(name));
    if (selected && !existing) {
        keyColumns.push({ id: nextKeyColumnId++, name, order: 'ASC' });
    } else if (!selected) {
        keyColumns = keyColumns.filter(column => identifierKey(column.name) !== identifierKey(name));
    }
    if (!indexNameTouched) {
        byId<HTMLInputElement>('indexName').value = suggestedIndexName();
    }
    renderAvailableColumns();
    renderKeyColumns();
    refreshDdl();
}

function renderAvailableColumns(): void {
    const container = byId('availableColumns');
    const query = byId<HTMLInputElement>('columnSearch').value.trim().toLowerCase();
    const selectedNames = new Set(keyColumns.map(column => identifierKey(column.name)));
    container.replaceChildren();
    const visibleColumns = columns.filter(column => columnMatches(column, query));
    if (visibleColumns.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'field-hint';
        empty.textContent = 'No columns match the filter.';
        container.appendChild(empty);
        return;
    }

    visibleColumns.forEach(column => {
        const row = document.createElement('label');
        row.className = 'available-column';
        row.title = column.description || column.name;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedNames.has(identifierKey(column.name));
        checkbox.addEventListener('change', () => toggleKeyColumn(column.name, checkbox.checked));
        const name = document.createElement('strong');
        name.textContent = column.name;
        const type = document.createElement('span');
        type.className = 'column-type';
        type.textContent = column.type || 'Unknown type';
        const badges = document.createElement('span');
        badges.className = 'column-badges';
        if (column.isPrimaryKey) appendBadge(badges, 'PK');
        if (column.isForeignKey) appendBadge(badges, 'FK');
        if (column.notNull) appendBadge(badges, 'NOT NULL');
        const text = document.createElement('span');
        text.className = 'column-picker-text';
        text.append(name, type, badges);
        row.append(checkbox, text);
        container.appendChild(row);
    });
}

function createOrderSelect(value: 'ASC' | 'DESC', onChange: (order: 'ASC' | 'DESC') => void): HTMLSelectElement {
    const select = document.createElement('select');
    appendOption(select, 'ASC');
    if (context.supportsDescendingIndexes) {
        appendOption(select, 'DESC');
    }
    select.value = context.supportsDescendingIndexes ? value : 'ASC';
    select.setAttribute('aria-label', 'Sort direction');
    select.addEventListener('change', () => onChange(select.value as 'ASC' | 'DESC'));
    return select;
}

function createRowButton(text: string, title: string, onClick: () => void, danger = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'row-button danger' : 'row-button';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

function renderKeyColumns(): void {
    const container = byId('keyColumns');
    container.replaceChildren();
    if (keyColumns.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-selection';
        empty.textContent = 'No key columns selected yet.';
        container.appendChild(empty);
    }
    keyColumns.forEach((keyColumn, index) => {
        const metadata = columns.find(column => identifierKey(column.name) === identifierKey(keyColumn.name));
        const row = document.createElement('div');
        row.className = 'key-column-row';
        const ordinal = document.createElement('span');
        ordinal.className = 'ordinal';
        ordinal.textContent = String(index + 1);
        const name = document.createElement('span');
        name.className = 'selected-column-name';
        name.textContent = keyColumn.name;
        const type = document.createElement('span');
        type.className = 'column-type selected-column-type';
        type.textContent = metadata?.type || 'Unknown type';
        row.append(ordinal, name, type, createOrderSelect(keyColumn.order, order => {
            keyColumn.order = order;
            refreshDdl();
        }));
        row.append(
            createRowButton('Up', 'Move column up', () => moveKeyColumn(index, -1)),
            createRowButton('Down', 'Move column down', () => moveKeyColumn(index, 1)),
            createRowButton('Remove', 'Remove key column', () => toggleKeyColumn(keyColumn.name, false), true),
        );
        container.appendChild(row);
    });
}

function moveKeyColumn(index: number, delta: number): void {
    const destination = index + delta;
    if (destination < 0 || destination >= keyColumns.length) {
        return;
    }
    [keyColumns[index], keyColumns[destination]] = [keyColumns[destination], keyColumns[index]];
    renderKeyColumns();
    renderAvailableColumns();
    refreshDdl();
}

function getDesign(): MysqlIndexDesign {
    const indexName = byId<HTMLInputElement>('indexName').value.trim();
    if (!indexName) {
        throw new Error('Enter an index name.');
    }
    if (context.existingIndexes.some(index => identifierKey(index.name) === identifierKey(indexName))) {
        throw new Error(`An index named ${indexName} already exists on this table.`);
    }
    if (keyColumns.length === 0) {
        throw new Error('Select at least one index column.');
    }
    return {
        indexName,
        keyColumns: keyColumns.map(({ name, order }) => ({ name, order })),
        unique: byId<HTMLInputElement>('unique').checked,
    };
}

function buildDdl(): string {
    const design = getDesign();
    return buildMysqlCreateIndexSql({
        schema: context.schema,
        tableName: context.tableName,
        indexName: design.indexName,
        keyColumns: design.keyColumns,
        unique: design.unique,
        allowDescending: context.supportsDescendingIndexes,
    });
}

function refreshDdl(): void {
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        preview.value = buildDdl();
    } catch (error) {
        preview.value = `-- ${error instanceof Error ? error.message : String(error)}`;
    }
}

function getExecutableDesign(): MysqlIndexDesign | undefined {
    try {
        const design = getDesign();
        byId<HTMLTextAreaElement>('ddlPreview').value = buildDdl();
        clearStatus();
        return design;
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
    }
}

function setExecuting(executing: boolean): void {
    ['executeDdlBtn', 'saveAsSqlBtn', 'copyDdlBtn', 'reloadBtn'].forEach(id => {
        byId<HTMLButtonElement>(id).disabled = executing;
    });
    byId<HTMLButtonElement>('executeDdlBtn').textContent = executing ? 'Executing...' : 'Execute';
}

function applyContext(nextContext: MysqlIndexDesignerInitialContext): void {
    context = nextContext;
    columns = [...context.columns].sort((left, right) => left.ordinal - right.ordinal);
    const available = new Set(columns.map(column => identifierKey(column.name)));
    keyColumns = keyColumns.filter(column => available.has(identifierKey(column.name)));
    updateHeader();
    renderExistingIndexes();
    renderAvailableColumns();
    renderKeyColumns();
    refreshDdl();
}

function handleHostMessage(message: MysqlIndexDesignerHostToWebviewMessage): void {
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
        case 'setContext':
            applyContext(message.context);
            return;
    }
}

function initialize(): void {
    updateHeader();
    byId<HTMLInputElement>('indexName').value = suggestedIndexName();
    renderAvailableColumns();
    renderKeyColumns();
    renderExistingIndexes();
    byId<HTMLInputElement>('columnSearch').addEventListener('input', renderAvailableColumns);
    byId<HTMLInputElement>('indexName').addEventListener('input', () => {
        indexNameTouched = true;
        refreshDdl();
    });
    ['unique'].forEach(id => byId(id).addEventListener('change', refreshDdl));
    byId<HTMLButtonElement>('reloadBtn').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
    byId<HTMLButtonElement>('executeDdlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) vscode.postMessage({ command: 'executeDesign', design });
    });
    byId<HTMLButtonElement>('saveAsSqlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) vscode.postMessage({ command: 'saveAsSql', design });
    });
    byId<HTMLButtonElement>('copyDdlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) vscode.postMessage({ command: 'copyDDL', design });
    });
    refreshDdl();
}

window.addEventListener('message', (event: MessageEvent<MysqlIndexDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (message && typeof message === 'object' && 'command' in message) {
        handleHostMessage(message);
    }
});

initialize();
