import {
    buildDb2CreateIndexSql,
    type Db2CreateIndexDdlOptions,
    type Db2IndexKeyColumn
} from '../../extensions/db2/src/db2DesignerDdl.js';
import type {
    Db2DesignerColumn,
    Db2IndexDesign,
    Db2IndexDesignerHostToWebviewMessage,
    Db2IndexDesignerInitialContext
} from './hostContracts.js';
import { vscode } from './protocol.js';

interface KeyColumn extends Db2IndexKeyColumn {
    id: number;
}

const context = (window as unknown as { initialContext: Db2IndexDesignerInitialContext }).initialContext;
const columns = [...context.columns].sort((left, right) => left.ordinal - right.ordinal);
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
    columns.forEach(column => appendOption(includeColumns, column.name, `${column.name} (${column.type})`));

    const existingHint = byId('existingIndexesHint');
    if (context.existingIndexes.length === 0) {
        existingHint.textContent = 'No user indexes found.';
    } else {
        existingHint.textContent = `Existing: ${context.existingIndexes.map(index => index.name).join(', ')}`;
    }
}

function columnMatches(column: Db2DesignerColumn, query: string): boolean {
    if (!query) {
        return true;
    }
    const searchable = `${column.name} ${column.type} ${column.description}`.toLowerCase();
    return searchable.includes(query.toLowerCase());
}

function renderAvailableColumns(): void {
    const container = byId('availableColumns');
    const query = byId<HTMLInputElement>('columnSearch').value.trim();
    const selectedNames = new Set(keyColumns.map(column => column.name.toUpperCase()));
    const visibleColumns = columns.filter(column => columnMatches(column, query));
    container.replaceChildren();

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
        checkbox.checked = selectedNames.has(column.name.toUpperCase());
        checkbox.setAttribute('aria-label', `Use ${column.name} as an index key`);
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

function appendBadge(parent: HTMLElement, text: string): void {
    const badge = document.createElement('span');
    badge.className = 'column-badge';
    badge.textContent = text;
    parent.appendChild(badge);
}

function toggleKeyColumn(name: string, selected: boolean): void {
    const existing = keyColumns.find(column => column.name.toUpperCase() === name.toUpperCase());
    if (selected && !existing) {
        keyColumns.push({ id: nextKeyColumnId++, name, order: 'ASC' });
    } else if (!selected) {
        keyColumns = keyColumns.filter(column => column.name.toUpperCase() !== name.toUpperCase());
    }
    updateSuggestedIndexName();
    renderAvailableColumns();
    renderKeyColumns();
    refreshDdl();
}

function createOrderSelect(value: 'ASC' | 'DESC', onChange: (newValue: 'ASC' | 'DESC') => void): HTMLSelectElement {
    const select = document.createElement('select');
    appendOption(select, 'ASC');
    appendOption(select, 'DESC');
    select.value = value;
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
        const metadata = columns.find(column => column.name.toUpperCase() === keyColumn.name.toUpperCase());
        const row = document.createElement('div');
        row.className = 'key-column-row';

        const ordinal = document.createElement('span');
        ordinal.className = 'ordinal';
        ordinal.textContent = String(index + 1);

        const name = document.createElement('span');
        name.className = 'selected-column-name';
        name.textContent = keyColumn.name;
        name.title = metadata?.description || keyColumn.name;

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
            createRowButton('Remove', 'Remove key column', () => toggleKeyColumn(keyColumn.name, false), true)
        );
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
    renderAvailableColumns();
    updateSuggestedIndexName();
    refreshDdl();
}

function updateSuggestedIndexName(): void {
    if (!indexNameTouched) {
        getIndexName().value = suggestedIndexName();
    }
}

function updateIncludeColumnAvailability(): void {
    const keyColumnNames = new Set(keyColumns.map(column => column.name.toUpperCase()));
    const select = byId<HTMLSelectElement>('includeColumns');
    for (const option of Array.from(select.options)) {
        option.disabled = keyColumnNames.has(option.value.toUpperCase());
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

function valueOrUndefined<T extends string>(id: string): T | undefined {
    const value = byId<HTMLSelectElement>(id).value;
    return value ? value as T : undefined;
}

function getDesign(): Db2IndexDesign {
    const indexName = getIndexName().value.trim();
    if (!indexName) {
        throw new Error('Enter an index name.');
    }
    if (context.existingIndexes.some(index => index.name.toUpperCase() === indexName.toUpperCase())) {
        throw new Error(`An index named ${indexName} already exists on this table.`);
    }
    const duplicateKeys = keyColumns.some((column, index) => keyColumns.findIndex(other =>
        other.name.toUpperCase() === column.name.toUpperCase()
    ) !== index);
    if (duplicateKeys) {
        throw new Error('A key column can only be selected once.');
    }

    return {
        indexName,
        keyColumns: keyColumns.map(({ name, order }) => ({ name, order })),
        includeColumns: Array.from(byId<HTMLSelectElement>('includeColumns').selectedOptions).map(option => option.value),
        unique: byId<HTMLInputElement>('unique').checked,
        clustered: byId<HTMLInputElement>('clustered').checked,
        reverseScans: valueOrUndefined<'allow' | 'disallow'>('reverseScans'),
        compress: valueOrUndefined<'yes' | 'no'>('compress'),
        pctFree: optionalPercent('pctFree', 'PCTFREE'),
        level2PctFree: optionalPercent('level2PctFree', 'LEVEL2 PCTFREE'),
        minPctUsed: optionalPercent('minPctUsed', 'MINPCTUSED'),
        pageSplit: valueOrUndefined<'symmetric' | 'high'>('pageSplit'),
        collectStatistics: valueOrUndefined<'sampled' | 'detailed'>('collectStatistics'),
        tablespace: byId<HTMLInputElement>('tablespace').value.trim() || undefined,
        additionalClause: byId<HTMLTextAreaElement>('additionalClause').value.trim() || undefined
    };
}

function buildDdl(): string {
    const design = getDesign();
    const options: Db2CreateIndexDdlOptions = {
        schema: context.schema,
        tableName: context.tableName,
        ...design,
        keyColumns: design.keyColumns
    };
    return buildDb2CreateIndexSql(options);
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

function getExecutableDesign(): Db2IndexDesign | undefined {
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
    const ids = [
        'indexName', 'tablespace', 'unique', 'clustered', 'reverseScans', 'compress', 'pctFree',
        'level2PctFree', 'minPctUsed', 'pageSplit', 'collectStatistics', 'additionalClause', 'includeColumns'
    ];
    ids.forEach(id => {
        const element = byId<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
        element.addEventListener('input', refreshDdl);
        element.addEventListener('change', refreshDdl);
    });
    getIndexName().addEventListener('input', () => {
        indexNameTouched = true;
    });
    byId<HTMLInputElement>('columnSearch').addEventListener('input', renderAvailableColumns);
}

function initialize(): void {
    populateStaticLists();
    getIndexName().value = suggestedIndexName();
    renderAvailableColumns();
    renderKeyColumns();
    bindInputUpdates();
    byId<HTMLButtonElement>('executeDdlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) {
            vscode.postMessage({ command: 'executeDesign', design });
        }
    });
    byId<HTMLButtonElement>('saveAsSqlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) {
            vscode.postMessage({ command: 'saveAsSql', design });
        }
    });
    byId<HTMLButtonElement>('copyDdlBtn').addEventListener('click', () => {
        const design = getExecutableDesign();
        if (design) {
            vscode.postMessage({ command: 'copyDDL', design });
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
