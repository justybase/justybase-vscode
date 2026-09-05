import {
    buildPostgresqlCreateIndexSql,
    POSTGRESQL_INDEX_METHODS,
} from '../../extensions/postgresql/src/postgresqlIndexDdl.js';
import type {
    PostgresqlAlterTableDesignerColumn,
    PostgresqlIndexDesign,
    PostgresqlIndexDesignerHostToWebviewMessage,
    PostgresqlIndexDesignerInitialContext,
    PostgresqlIndexPart,
} from './hostContracts.js';
import { vscode } from './protocol.js';

interface KeyColumn extends PostgresqlIndexPart {
    id: number;
}

let context = (window as unknown as { initialContext: PostgresqlIndexDesignerInitialContext }).initialContext;
let columns = [...context.columns].sort((left, right) => left.ordinal - right.ordinal);
let nextKeyColumnId = 1;
let keyColumns: KeyColumn[] = [];
let includeColumns: string[] = [];
let indexNameTouched = false;

const INCLUDE_INDEX_METHODS = new Set<PostgresqlIndexDesign['method']>(['btree', 'gist', 'spgist']);

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
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase();
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
    return `${context.tableName}_${keyColumns[0]?.name || 'COLUMN'}_idx`;
}

function updateHeader(): void {
    byId('methodHint').textContent = POSTGRESQL_INDEX_METHODS.join(', ');
    byId('existingIndexesHint').textContent = `${context.existingIndexes.length} index${context.existingIndexes.length === 1 ? '' : 'es'}`;

    const tablespace = byId<HTMLSelectElement>('tablespace');
    const previousTablespace = tablespace.value;
    tablespace.replaceChildren();
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '(table default)';
    tablespace.appendChild(defaultOption);
    context.tablespaces.forEach(value => appendOption(tablespace, value));
    if (previousTablespace && context.tablespaces.includes(previousTablespace)) {
        tablespace.value = previousTablespace;
    }
}

function renderExistingIndexes(): void {
    const body = byId<HTMLTableSectionElement>('existingIndexesBody');
    body.replaceChildren();
    if (context.existingIndexes.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.textContent = 'No indexes found.';
        row.appendChild(cell);
        body.appendChild(row);
        return;
    }

    context.existingIndexes.forEach(index => {
        const row = document.createElement('tr');
        const keyParts = index.keyParts.map(part => `${part.name} ${part.order} NULLS ${part.nulls}`);
        const properties = [
            index.isPrimary ? 'PRIMARY' : undefined,
            index.isUnique ? 'UNIQUE' : undefined,
            index.tablespace ? `tablespace ${index.tablespace}` : undefined,
            index.predicate ? 'partial' : undefined,
        ].filter((property): property is string => Boolean(property));
        [index.name, keyParts.join(', ') || '-', index.includeParts.join(', ') || '-', index.method, properties.join(', ') || '-'].forEach(value => {
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
        drop.title = index.isPrimary ? 'The PRIMARY KEY index cannot be dropped here.' : `Drop ${index.name}`;
        drop.addEventListener('click', () => vscode.postMessage({ command: 'dropIndex', indexName: index.name }));
        actions.appendChild(drop);
        row.appendChild(actions);
        body.appendChild(row);
    });
}

function columnMatches(column: PostgresqlAlterTableDesignerColumn, query: string): boolean {
    return !query || `${column.name} ${column.type} ${column.comment}`.toLowerCase().includes(query.toLowerCase());
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
        keyColumns.push({ id: nextKeyColumnId++, name, order: 'ASC', nulls: 'LAST' });
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

function toggleIncludeColumn(name: string, selected: boolean): void {
    if (selected && !includeColumns.some(column => identifierKey(column) === identifierKey(name))) {
        includeColumns.push(name);
    } else if (!selected) {
        includeColumns = includeColumns.filter(column => identifierKey(column) !== identifierKey(name));
    }
    renderAvailableColumns();
    renderIncludeColumns();
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
        row.title = column.comment || column.name;
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

    const includeHeading = document.createElement('p');
    includeHeading.className = 'field-hint';
    includeHeading.textContent = 'Check a column to make it a key column. Use the INCLUDE list below for included (covering) columns.';
    container.appendChild(includeHeading);
}

function createOrderSelect(value: 'ASC' | 'DESC', onChange: (order: 'ASC' | 'DESC') => void): HTMLSelectElement {
    const select = document.createElement('select');
    appendOption(select, 'ASC');
    appendOption(select, 'DESC');
    select.value = value;
    select.setAttribute('aria-label', 'Sort direction');
    select.addEventListener('change', () => onChange(select.value as 'ASC' | 'DESC'));
    return select;
}

function createNullsSelect(value: 'FIRST' | 'LAST', onChange: (nulls: 'FIRST' | 'LAST') => void): HTMLSelectElement {
    const select = document.createElement('select');
    appendOption(select, 'LAST');
    appendOption(select, 'FIRST');
    select.value = value;
    select.setAttribute('aria-label', 'NULLS position');
    select.addEventListener('change', () => onChange(select.value as 'FIRST' | 'LAST'));
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
    const method = byId<HTMLSelectElement>('method').value as PostgresqlIndexDesign['method'];
    const supportsOrdering = method === 'btree';
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
        row.append(
            ordinal,
            name,
            type,
            createOrderSelect(keyColumn.order, order => {
                keyColumn.order = order;
                refreshDdl();
            }),
            createNullsSelect(keyColumn.nulls, nulls => {
                keyColumn.nulls = nulls;
                refreshDdl();
            }),
        );
        const selects = row.querySelectorAll<HTMLSelectElement>('select');
        selects.forEach(select => { select.disabled = !supportsOrdering; });
        row.append(
            createRowButton('Up', 'Move column up', () => moveKeyColumn(index, -1)),
            createRowButton('Down', 'Move column down', () => moveKeyColumn(index, 1)),
            createRowButton('Remove', 'Remove key column', () => toggleKeyColumn(keyColumn.name, false), true),
        );
        container.appendChild(row);
    });
}

function applyMethodRestrictions(): void {
    const method = byId<HTMLSelectElement>('method').value as PostgresqlIndexDesign['method'];
    const unique = byId<HTMLInputElement>('unique');
    const supportsOrdering = method === 'btree';
    unique.disabled = !supportsOrdering;
    if (!supportsOrdering) {
        unique.checked = false;
        keyColumns.forEach(column => {
            column.order = 'ASC';
            column.nulls = 'LAST';
        });
    }
    if (!INCLUDE_INDEX_METHODS.has(method)) {
        includeColumns = [];
    }
    renderKeyColumns();
    renderIncludeColumns();
}

function renderIncludeColumns(): void {
    const container = byId('includeColumns');
    container.replaceChildren();
    if (includeColumns.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-selection';
        empty.textContent = 'No INCLUDE columns selected.';
        container.appendChild(empty);
    }
    includeColumns.forEach((name, index) => {
        const metadata = columns.find(column => identifierKey(column.name) === identifierKey(name));
        const row = document.createElement('div');
        row.className = 'key-column-row';
        const ordinal = document.createElement('span');
        ordinal.className = 'ordinal';
        ordinal.textContent = String(index + 1);
        const columnName = document.createElement('span');
        columnName.className = 'selected-column-name';
        columnName.textContent = name;
        const type = document.createElement('span');
        type.className = 'column-type selected-column-type';
        type.textContent = metadata?.type || 'Unknown type';
        row.append(
            ordinal,
            columnName,
            type,
            createRowButton('Up', 'Move column up', () => moveIncludeColumn(index, -1)),
            createRowButton('Down', 'Move column down', () => moveIncludeColumn(index, 1)),
            createRowButton('Remove', 'Remove INCLUDE column', () => toggleIncludeColumn(name, false), true),
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

function moveIncludeColumn(index: number, delta: number): void {
    const destination = index + delta;
    if (destination < 0 || destination >= includeColumns.length) {
        return;
    }
    [includeColumns[index], includeColumns[destination]] = [includeColumns[destination], includeColumns[index]];
    renderIncludeColumns();
    refreshDdl();
}

function getDesign(): PostgresqlIndexDesign {
    const indexName = byId<HTMLInputElement>('indexName').value.trim();
    if (!indexName) {
        throw new Error('Enter an index name.');
    }
    if (context.existingIndexes.some(index => identifierKey(index.name) === identifierKey(indexName))) {
        throw new Error(`An index named ${indexName} already exists on this table.`);
    }
    if (keyColumns.length === 0) {
        throw new Error('Select at least one key column.');
    }
    return {
        indexName,
        method: byId<HTMLSelectElement>('method').value as PostgresqlIndexDesign['method'],
        unique: byId<HTMLInputElement>('unique').checked,
        keyColumns: keyColumns.map(({ name, order, nulls }) => ({ name, order, nulls })),
        includeColumns: [...includeColumns],
        predicate: byId<HTMLInputElement>('predicate').value,
        tablespace: byId<HTMLSelectElement>('tablespace').value,
    };
}

function buildDdl(): string {
    const design = getDesign();
    return buildPostgresqlCreateIndexSql({
        schema: context.schema,
        tableName: context.tableName,
        design,
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

function getExecutableDesign(): PostgresqlIndexDesign | undefined {
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

function applyContext(nextContext: PostgresqlIndexDesignerInitialContext): void {
    context = nextContext;
    columns = [...context.columns].sort((left, right) => left.ordinal - right.ordinal);
    const available = new Set(columns.map(column => identifierKey(column.name)));
    keyColumns = keyColumns.filter(column => available.has(identifierKey(column.name)));
    includeColumns = includeColumns.filter(name => available.has(identifierKey(name)));
    updateHeader();
    renderExistingIndexes();
    renderAvailableColumns();
    renderKeyColumns();
    renderIncludeColumns();
    refreshDdl();
}

function handleHostMessage(message: PostgresqlIndexDesignerHostToWebviewMessage): void {
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
    POSTGRESQL_INDEX_METHODS.forEach(method => appendOption(byId<HTMLSelectElement>('method'), method));
    byId<HTMLSelectElement>('method').value = 'btree';
    renderAvailableColumns();
    renderKeyColumns();
    renderIncludeColumns();
    renderExistingIndexes();
    byId<HTMLInputElement>('columnSearch').addEventListener('input', renderAvailableColumns);
    byId<HTMLInputElement>('indexName').addEventListener('input', () => {
        indexNameTouched = true;
        refreshDdl();
    });
    byId('unique').addEventListener('change', refreshDdl);
    byId('method').addEventListener('change', () => {
        applyMethodRestrictions();
        refreshDdl();
    });
    byId<HTMLSelectElement>('tablespace').addEventListener('change', refreshDdl);
    byId<HTMLInputElement>('predicate').addEventListener('input', refreshDdl);
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

window.addEventListener('message', (event: MessageEvent<PostgresqlIndexDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (message && typeof message === 'object' && 'command' in message) {
        handleHostMessage(message);
    }
});

initialize();
