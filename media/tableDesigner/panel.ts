import {
    buildTableDesignerCreateSql,
    getTableDesignerContainerDisplay,
    getTableDesignerProfile,
    type TableDesignerCreateInput,
} from '../../src/views/tableDesignerDdl.js';
import {
    getDatabaseDesignerCapabilities,
    resolveDatabaseDesignerCapabilities,
} from '../../packages/contracts/src/database/designerCapabilities.js';
import type {
    TableDesignerColumn,
    TableDesignerHostToWebviewMessage,
    TableDesignerInitialContext,
    TableDesignerWebviewToHostMessage,
} from './hostContracts.js';
import { eventTargetAsHtmlElement, eventTargetAsInput, getElementById } from './dom.js';
import { postToHost } from './protocol.js';
import { getDesignerCapability, isDesignerOperationSupported } from '../shared/designerCapability.js';

const context = (
    window as unknown as { initialContext: TableDesignerInitialContext }
).initialContext;
const profile = getTableDesignerProfile(context.databaseKind);
const baseDesignerCapabilities = getDatabaseDesignerCapabilities(context.databaseKind);
const designerCapabilities = resolveDatabaseDesignerCapabilities(baseDesignerCapabilities, {
    databaseKind: baseDesignerCapabilities.kind,
    readOnly: context.readOnly,
    runtimeAvailable: context.runtimeAvailable,
});
const tableCapability = getDesignerCapability(designerCapabilities, 'table');
const canCreateTable = isDesignerOperationSupported(designerCapabilities, 'table', 'create');

let columns: TableDesignerColumn[] = [
    { id: 1, name: 'ID', type: 'INTEGER', length: '', notNull: true, pk: true, distribute: false, defaultValue: '' },
];
let nextId = 2;

function showStatusBanner(text: string, variant: 'error' | 'info' = 'error'): void {
    const banner = getElementById('statusBanner');
    if (!banner) {
        return;
    }
    banner.textContent = text;
    banner.classList.remove('hidden', 'error', 'info');
    banner.classList.add(variant);
}

function clearStatusBanner(): void {
    const banner = getElementById('statusBanner');
    if (!banner) {
        return;
    }
    banner.textContent = '';
    banner.classList.add('hidden');
    banner.classList.remove('error', 'info');
}

function setExecutingState(executing: boolean): void {
    const executeBtn = getElementById<HTMLButtonElement>('executeDdlBtn');
    const saveBtn = getElementById<HTMLButtonElement>('saveAsSqlBtn');
    if (executeBtn) {
        executeBtn.disabled = executing || !canCreateTable;
        executeBtn.textContent = executing ? 'Executing…' : 'Execute Table Creation';
        if (!canCreateTable) {
            executeBtn.title = tableCapability.reason ?? 'Table creation is not available for this database kind.';
        }
    }
    if (saveBtn) {
        saveBtn.disabled = executing;
    }
}

function validateDesign(): string | null {
    const tableName = getElementById<HTMLInputElement>('tableName')?.value.trim() ?? '';
    if (!tableName) {
        return 'Enter a table name before executing DDL.';
    }

    if (columns.length === 0) {
        return 'Add at least one column before executing DDL.';
    }

    const unnamedColumns = columns.filter((column) => !(column.name || '').trim());
    if (unnamedColumns.length > 0) {
        return 'Every column needs a name before executing DDL.';
    }

    const untypedColumns = columns.filter((column) => !(column.type || '').trim());
    if (untypedColumns.length > 0) {
        return `Column "${untypedColumns[0].name}" needs a data type before executing DDL.`;
    }

    return null;
}

function updateEmptyColumnsState(): void {
    const emptyState = getElementById('columnsEmptyState');
    const columnsBody = getElementById('columnsBody');
    if (!emptyState || !columnsBody) {
        return;
    }
    const isEmpty = columns.length === 0;
    emptyState.classList.toggle('hidden', !isEmpty);
    columnsBody.classList.toggle('hidden', isEmpty);
}

function handleHostMessage(message: TableDesignerHostToWebviewMessage): void {
    switch (message.command) {
        case 'setError':
            showStatusBanner(message.text, 'error');
            return;
        case 'clearError':
            clearStatusBanner();
            return;
        case 'setExecuting':
            setExecutingState(message.executing);
            return;
    }
}

window.addEventListener('message', (event: MessageEvent<TableDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object' || !('command' in message)) {
        return;
    }
    handleHostMessage(message);
});

function getDataTypes(): readonly string[] {
    return profile.dataTypes;
}

function updateDialectUi(): void {
    const organizeSection = getElementById('organizeSection');
    const organizeNoneLabel = getElementById('organizeNoneLabel');
    const ifNotExistsLabel = getElementById('ifNotExistsLabel');

    if (!canCreateTable) {
        showStatusBanner(tableCapability.reason ?? 'Table creation is not available for this database kind.', 'info');
    }

    document.querySelectorAll('.distribution-column').forEach(element => {
        element.classList.toggle('hidden', !profile.supportsDistribution);
    });

    if (organizeSection) {
        organizeSection.classList.toggle('hidden', !profile.supportsOrganize);
    }
    if (organizeNoneLabel) {
        organizeNoneLabel.classList.toggle('hidden', !profile.supportsOrganize);
    }
    if (ifNotExistsLabel) {
        ifNotExistsLabel.classList.toggle('hidden', !profile.supportsIfNotExists);
    }

    const targetDisplay = getElementById('targetDisplay');
    if (targetDisplay) {
        targetDisplay.textContent = getTableDesignerContainerDisplay(
            context.databaseKind,
            context.dbName,
            context.schemaName || undefined,
        );
    }

    const tableTypeSelect = getElementById<HTMLSelectElement>('tableType');
    if (tableTypeSelect) {
        const previousValue = tableTypeSelect.value;
        tableTypeSelect.innerHTML = '';
        profile.tableTypeOptions.forEach(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            tableTypeSelect?.appendChild(element);
        });
        if (previousValue && profile.tableTypeOptions.some(option => option.value === previousValue)) {
            tableTypeSelect.value = previousValue;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    updateDialectUi();
    renderColumns();
    syncOrganizeControls();
    updateDDL();
    updateEmptyColumnsState();

    getElementById('addColumnBtn')?.addEventListener('click', () => {
        columns.push({
            id: nextId++,
            name: `COLUMN_${columns.length + 1}`,
            type: profile.newColumnType,
            length: profile.newColumnLength,
            notNull: false,
            pk: false,
            distribute: false,
            defaultValue: '',
        });
        renderColumns();
        updateDDL();
        updateEmptyColumnsState();
    });

    getElementById<HTMLInputElement>('tableName')?.addEventListener('input', updateDDL);
    getElementById<HTMLSelectElement>('tableType')?.addEventListener('change', updateDDL);
    getElementById<HTMLInputElement>('ifNotExists')?.addEventListener('change', updateDDL);
    getElementById<HTMLInputElement>('organizeColumns')?.addEventListener('input', updateDDL);
    getElementById<HTMLTextAreaElement>('tableConstraints')?.addEventListener('input', updateDDL);
    getElementById<HTMLInputElement>('organizeNone')?.addEventListener('change', () => {
        syncOrganizeControls();
        updateDDL();
    });

    getElementById('executeDdlBtn')?.addEventListener('click', () => {
        clearStatusBanner();
        const validationError = validateDesign();
        if (validationError) {
            showStatusBanner(validationError, 'error');
            return;
        }
        const ddl = getElementById<HTMLTextAreaElement>('ddlPreview')?.value ?? '';
        postToHost({ command: 'executeDDL', ddl } satisfies TableDesignerWebviewToHostMessage);
    });

    getElementById('saveAsSqlBtn')?.addEventListener('click', () => {
        const ddl = getElementById<HTMLTextAreaElement>('ddlPreview')?.value ?? '';
        postToHost({ command: 'saveAsSql', ddl });
    });
});

function syncOrganizeControls(): void {
    const organizeNone = getElementById<HTMLInputElement>('organizeNone');
    const organizeColumnsInput = getElementById<HTMLInputElement>('organizeColumns');
    if (!organizeNone || !organizeColumnsInput) return;

    organizeColumnsInput.disabled = organizeNone.checked;
    if (organizeNone.checked) {
        organizeColumnsInput.value = '';
    }
}

function renderColumns(): void {
    const tbody = getElementById('columnsBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    columns.forEach(col => {
        const tr = document.createElement('tr');
        const dataTypes = getDataTypes();

        tr.innerHTML = `
            <td style="cursor: ns-resize; text-align: center;">☰</td>
            <td><input type="text" class="col-name" data-id="${col.id}" value="${col.name}" /></td>
            <td>
                <select class="col-type" data-id="${col.id}">
                    ${dataTypes.map(t => `<option value="${t}" ${t === col.type ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </td>
            <td><input type="text" class="col-length" data-id="${col.id}" value="${col.length}" placeholder="e.g. 255 or 10,2" /></td>
            <td style="text-align: center;"><input type="checkbox" class="col-notnull" data-id="${col.id}" ${col.notNull ? 'checked' : ''} /></td>
            <td style="text-align: center;"><input type="checkbox" class="col-pk" data-id="${col.id}" ${col.pk ? 'checked' : ''} /></td>
            <td class="distribution-column" style="text-align: center;"><input type="checkbox" class="col-distribute" data-id="${col.id}" ${col.distribute ? 'checked' : ''} /></td>
            <td><input type="text" class="col-default" data-id="${col.id}" value="${col.defaultValue}" /></td>
            <td style="text-align: center;">
                <button class="action-btn delete" data-id="${col.id}" title="Remove Column">✖</button>
            </td>
        `;

        tbody.appendChild(tr);
    });

    if (!profile.supportsDistribution) {
        document.querySelectorAll('.distribution-column').forEach(element => element.classList.add('hidden'));
    }

    document.querySelectorAll('.col-name').forEach(el => el.addEventListener('input', e => updateCol(e, 'name')));
    document.querySelectorAll('.col-type').forEach(el => el.addEventListener('change', e => updateCol(e, 'type')));
    document.querySelectorAll('.col-length').forEach(el => el.addEventListener('input', e => updateCol(e, 'length')));
    document.querySelectorAll('.col-notnull').forEach(el => el.addEventListener('change', e => updateCol(e, 'notNull', true)));
    document.querySelectorAll('.col-pk').forEach(el => el.addEventListener('change', e => updateCol(e, 'pk', true)));
    document.querySelectorAll('.col-distribute').forEach(el => el.addEventListener('change', e => updateCol(e, 'distribute', true)));
    document.querySelectorAll('.col-default').forEach(el => el.addEventListener('input', e => updateCol(e, 'defaultValue')));

    document.querySelectorAll('.action-btn.delete').forEach(el => el.addEventListener('click', e => {
        const currentTarget = eventTargetAsHtmlElement(e);
        const id = parseInt(currentTarget?.getAttribute('data-id') ?? '', 10);
        columns = columns.filter(c => c.id !== id);
        renderColumns();
        updateDDL();
        updateEmptyColumnsState();
    }));

    updateEmptyColumnsState();
}

function updateCol(
    e: Event,
    field: keyof Pick<TableDesignerColumn, 'name' | 'type' | 'length' | 'notNull' | 'pk' | 'distribute' | 'defaultValue'>,
    isCheckbox = false,
): void {
    const target = eventTargetAsInput(e);
    const id = parseInt(target?.getAttribute('data-id') ?? '', 10);
    const value = isCheckbox ? Boolean(target?.checked) : (target?.value ?? '');
    const col = columns.find(c => c.id === id);
    if (!col) return;

    if (field === 'notNull') col.notNull = Boolean(value);
    else if (field === 'pk') col.pk = Boolean(value);
    else if (field === 'distribute') col.distribute = Boolean(value);
    else if (field === 'name') col.name = String(value);
    else if (field === 'type') col.type = String(value);
    else if (field === 'length') col.length = String(value);
    else if (field === 'defaultValue') col.defaultValue = String(value);

    if (field === 'pk' && value === true) {
        col.notNull = true;
        renderColumns();
    }
    updateDDL();
}

function updateDDL(): void {
    const tableNameInput = getElementById<HTMLInputElement>('tableName');
    const tableTypeSelect = getElementById<HTMLSelectElement>('tableType');
    const ifNotExistsInput = getElementById<HTMLInputElement>('ifNotExists');
    const organizeNoneInput = getElementById<HTMLInputElement>('organizeNone');
    const organizeColumnsInput = getElementById<HTMLInputElement>('organizeColumns');
    const tableConstraintsInput = getElementById<HTMLTextAreaElement>('tableConstraints');
    const ddlPreview = getElementById<HTMLTextAreaElement>('ddlPreview');

    if (!tableNameInput || !tableTypeSelect || !ifNotExistsInput || !organizeNoneInput || !organizeColumnsInput || !tableConstraintsInput || !ddlPreview) {
        return;
    }

    const input: TableDesignerCreateInput = {
        databaseKind: context.databaseKind,
        readOnly: context.readOnly,
        runtimeAvailable: context.runtimeAvailable,
        dbName: context.dbName,
        schemaName: context.schemaName || undefined,
        tableName: tableNameInput.value,
        tableType: tableTypeSelect.value,
        ifNotExists: ifNotExistsInput.checked,
        columns: columns.map(column => ({
            name: column.name,
            type: column.type,
            length: column.length,
            notNull: column.notNull,
            pk: column.pk,
            defaultValue: column.defaultValue,
        })),
        distributeColumns: columns.filter(column => column.distribute).map(column => column.name),
        organizeNone: organizeNoneInput.checked,
        organizeColumns: organizeColumnsInput.value.split(','),
        tableConstraints: tableConstraintsInput.value.split('\n'),
    };

    try {
        ddlPreview.value = buildTableDesignerCreateSql(input);
    } catch (error) {
        ddlPreview.value = `-- ${error instanceof Error ? error.message : String(error)}`;
    }
}
