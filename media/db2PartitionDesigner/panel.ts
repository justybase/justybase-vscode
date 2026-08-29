import {
    buildDb2AddPartitionSql,
    buildDb2AttachPartitionSql,
    buildDb2DetachPartitionSql,
    buildDb2DropPartitionSql,
    buildDb2SetIntegritySql,
    type Db2PartitionRangeOptions
} from '../../extensions/db2/src/db2DesignerDdl.js';
import type {
    Db2DesignerPartition,
    Db2PartitionDesignerHostToWebviewMessage,
    Db2PartitionDesignerInitialContext,
    Db2PartitionOperationRequest,
    Db2PartitionRangeDesign
} from './hostContracts.js';
import { vscode } from './protocol.js';

type ActiveOperation = 'add' | 'attach' | 'manage';
type ManageOperation = 'detach' | 'drop' | undefined;

interface PartitionPlan {
    ddl: string;
    request: Db2PartitionOperationRequest;
}

const context = (window as unknown as { initialContext: Db2PartitionDesignerInitialContext }).initialContext;
const isPartitioned = context.partitionExpressions.length > 0 || context.partitions.length > 0;
let activeOperation: ActiveOperation = 'add';
let manageOperation: ManageOperation;
let selectedPartition: Db2DesignerPartition | undefined;

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element: ${id}`);
    }
    return element as T;
}

function inputValue(id: string): string {
    return byId<HTMLInputElement>(id).value.trim();
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

function appendOption(select: HTMLDataListElement, value: string): void {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
}

function setPartitioningInfo(): void {
    const info = byId('partitioningInfo');
    if (!isPartitioned) {
        info.className = 'partitioning-info warning';
        info.textContent = 'This table is not range partitioned. Db2 does not add PARTITION BY RANGE to an existing table with ALTER TABLE, so Add and Attach are unavailable. Open the table DDL to create a partitioned replacement table.';
        return;
    }
    info.className = 'partitioning-info';
    info.textContent = `PARTITION BY RANGE (${context.partitionExpressions.join(', ')})`;
}

function formatBoundary(value: string, inclusive: boolean, opening: boolean): string {
    const marker = inclusive ? (opening ? '[' : ']') : (opening ? '(' : ')');
    return `${opening ? marker : ''}${value || (opening ? 'MINVALUE' : 'MAXVALUE')}${opening ? '' : marker}`;
}

function renderPartitions(): void {
    const body = byId<HTMLTableSectionElement>('partitionsBody');
    body.replaceChildren();
    const count = byId('partitionCount');
    count.textContent = `${context.partitions.length} partition${context.partitions.length === 1 ? '' : 's'}`;
    if (context.partitions.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.textContent = 'No partitions found.';
        row.appendChild(cell);
        body.appendChild(row);
        return;
    }
    context.partitions.forEach(partition => {
        const row = document.createElement('tr');
        const values = [
            partition.name,
            formatBoundary(partition.lowValue, partition.lowInclusive, true),
            formatBoundary(partition.highValue, partition.highInclusive, false),
            partition.tablespace || '-',
            partition.rowCount === undefined ? '-' : partition.rowCount.toLocaleString()
        ];
        values.forEach(value => {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
        });
        const actions = document.createElement('td');
        const detach = document.createElement('button');
        detach.type = 'button';
        detach.className = 'row-button';
        detach.textContent = 'Detach';
        detach.addEventListener('click', () => selectManageOperation('detach', partition));
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'row-button danger';
        drop.textContent = 'Drop';
        drop.addEventListener('click', () => selectManageOperation('drop', partition));
        actions.append(detach, drop);
        row.appendChild(actions);
        body.appendChild(row);
    });
}

function selectManageOperation(operation: Exclude<ManageOperation, undefined>, partition: Db2DesignerPartition): void {
    selectedPartition = partition;
    manageOperation = operation;
    activeOperation = 'manage';
    byId<HTMLInputElement>('detachedTableName').value = `${context.tableName}_${partition.name}_DETACHED`;
    byId('manageTitle').textContent = `${operation === 'detach' ? 'Detach' : 'Drop'} ${partition.name}`;
    byId('manageHint').textContent = operation === 'detach'
        ? 'Detach retains data in the target table.'
        : 'Drop generates a detach followed by DROP TABLE. This cannot be undone.';
    byId('manageForm').classList.remove('hidden');
    setActiveOperation('manage');
    refreshDdl();
}

function setActiveOperation(operation: ActiveOperation): void {
    const resolvedOperation = !isPartitioned && operation !== 'manage' ? 'manage' : operation;
    activeOperation = resolvedOperation;
    const sections: Record<ActiveOperation, string> = {
        add: 'addSection',
        attach: 'attachSection',
        manage: 'manageSection'
    };
    (Object.keys(sections) as ActiveOperation[]).forEach(name => {
        byId(sections[name]).classList.toggle('hidden', name !== resolvedOperation);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-operation]').forEach(button => {
        button.classList.toggle('active', button.dataset.operation === resolvedOperation);
        button.disabled = !isPartitioned && button.dataset.operation !== 'manage';
    });
    updateActionAvailability();
    refreshDdl();
}

function rangeOptions(prefix: 'add' | 'attach'): Db2PartitionRangeOptions {
    return {
        partitionName: inputValue(`${prefix}PartitionName`),
        startingFrom: inputValue(`${prefix}StartingFrom`),
        startingInclusive: byId<HTMLSelectElement>(`${prefix}StartingInclusive`).value === 'inclusive',
        endingAt: inputValue(`${prefix}EndingAt`),
        endingInclusive: byId<HTMLSelectElement>(`${prefix}EndingInclusive`).value === 'inclusive',
        tablespace: prefix === 'add' ? inputValue('addTablespace') : undefined,
        indexTablespace: prefix === 'add' ? inputValue('addIndexTablespace') : undefined,
        longTablespace: prefix === 'add' ? inputValue('addLongTablespace') : undefined
    };
}

function rangeDesign(prefix: 'add' | 'attach'): Db2PartitionRangeDesign {
    return rangeOptions(prefix);
}

function buildPlan(): PartitionPlan {
    if (activeOperation === 'add') {
        if (!isPartitioned) {
            throw new Error('This operation requires an existing Db2 range-partitioned table.');
        }
        const range = rangeDesign('add');
        const sql = buildDb2AddPartitionSql({
            schema: context.schema,
            tableName: context.tableName,
            ...range
        });
        return {
            ddl: sql,
            request: { operation: 'add', range }
        };
    }
    if (activeOperation === 'attach') {
        if (!isPartitioned) {
            throw new Error('This operation requires an existing Db2 range-partitioned table.');
        }
        const range = rangeDesign('attach');
        const attachRange = {
            partitionName: range.partitionName,
            startingFrom: range.startingFrom,
            startingInclusive: range.startingInclusive,
            endingAt: range.endingAt,
            endingInclusive: range.endingInclusive
        };
        const sql = buildDb2AttachPartitionSql({
            schema: context.schema,
            tableName: context.tableName,
            sourceSchema: requireValue(inputValue('attachSourceSchema'), 'Source schema'),
            sourceTable: requireValue(inputValue('attachSourceTable'), 'Source table'),
            ...attachRange
        });
        const statements = [sql];
        if (byId<HTMLInputElement>('runSetIntegrity').checked) {
            statements.push(buildDb2SetIntegritySql(context.schema, context.tableName));
        }
        return {
            ddl: statements.join('\n\n'),
            request: {
                operation: 'attach',
                range: attachRange,
                sourceSchema: inputValue('attachSourceSchema'),
                sourceTable: inputValue('attachSourceTable'),
                runSetIntegrity: byId<HTMLInputElement>('runSetIntegrity').checked
            }
        };
    }
    if (!manageOperation || !selectedPartition) {
        throw new Error('Select a partition action first.');
    }
    const options = {
        schema: context.schema,
        tableName: context.tableName,
        partitionName: selectedPartition.name,
        detachedSchema: context.schema,
        detachedTable: requireValue(inputValue('detachedTableName'), 'Detached table name')
    };
    const statements = manageOperation === 'detach'
        ? [buildDb2DetachPartitionSql(options)]
        : buildDb2DropPartitionSql(options);
    return {
        ddl: statements.join('\n\n'),
        request: {
            operation: manageOperation,
            partitionName: selectedPartition.name,
            detachedSchema: context.schema,
            detachedTable: requireValue(inputValue('detachedTableName'), 'Detached table')
        }
    };
}

function requireValue(value: string, label: string): string {
    if (!value) {
        throw new Error(`${label} is required.`);
    }
    return value;
}

function refreshDdl(): void {
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        preview.value = buildPlan().ddl;
    } catch (error) {
        preview.value = `-- ${error instanceof Error ? error.message : String(error)}`;
    }
}

function getPlanOrShowError(): PartitionPlan | undefined {
    try {
        const plan = buildPlan();
        byId<HTMLTextAreaElement>('ddlPreview').value = plan.ddl;
        clearStatus();
        return plan;
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
    }
}

function setExecuting(executing: boolean): void {
    const execute = byId<HTMLButtonElement>('executeDdlBtn');
    const save = byId<HTMLButtonElement>('saveAsSqlBtn');
    const copy = byId<HTMLButtonElement>('copyDdlBtn');
    const unavailable = !hasAvailableOperation();
    execute.disabled = executing || unavailable;
    save.disabled = executing || unavailable;
    copy.disabled = executing || unavailable;
    execute.textContent = executing ? 'Executing...' : 'Execute';
}

function hasAvailableOperation(): boolean {
    if (!isPartitioned) {
        return false;
    }
    return activeOperation === 'add'
        || activeOperation === 'attach'
        || Boolean(activeOperation === 'manage' && manageOperation && selectedPartition);
}

function updateActionAvailability(): void {
    const unavailable = !hasAvailableOperation();
    byId<HTMLButtonElement>('executeDdlBtn').disabled = unavailable;
    byId<HTMLButtonElement>('saveAsSqlBtn').disabled = unavailable;
    byId<HTMLButtonElement>('copyDdlBtn').disabled = unavailable;
}

function handleHostMessage(message: Db2PartitionDesignerHostToWebviewMessage): void {
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

function bindUpdates(): void {
    const ids = [
        'addPartitionName', 'addStartingFrom', 'addEndingAt', 'addStartingInclusive', 'addEndingInclusive',
        'addTablespace', 'addIndexTablespace', 'addLongTablespace', 'attachPartitionName', 'attachSourceSchema',
        'attachSourceTable', 'attachStartingFrom', 'attachEndingAt', 'attachStartingInclusive', 'attachEndingInclusive',
        'runSetIntegrity', 'detachedTableName'
    ];
    ids.forEach(id => {
        const element = byId<HTMLInputElement | HTMLSelectElement>(id);
        element.addEventListener('input', refreshDdl);
        element.addEventListener('change', refreshDdl);
    });
}

function initialize(): void {
    const tablespaces = byId<HTMLDataListElement>('tablespaces');
    context.tablespaces.forEach(tablespace => appendOption(tablespaces, tablespace));
    byId<HTMLInputElement>('attachSourceSchema').value = context.schema;
    setPartitioningInfo();
    renderPartitions();
    bindUpdates();
    document.querySelectorAll<HTMLButtonElement>('[data-operation]').forEach(button => {
        button.addEventListener('click', () => setActiveOperation(button.dataset.operation as ActiveOperation));
    });
    byId<HTMLButtonElement>('executeDdlBtn').addEventListener('click', () => {
        const plan = getPlanOrShowError();
        if (plan) {
            vscode.postMessage({ command: 'executeOperation', request: plan.request });
        }
    });
    byId<HTMLButtonElement>('saveAsSqlBtn').addEventListener('click', () => {
        const plan = getPlanOrShowError();
        if (plan) {
            vscode.postMessage({ command: 'saveAsSql', request: plan.request });
        }
    });
    byId<HTMLButtonElement>('copyDdlBtn').addEventListener('click', () => {
        const plan = getPlanOrShowError();
        if (plan) {
            vscode.postMessage({ command: 'copyDDL', request: plan.request });
        }
    });
    setActiveOperation('add');
}

window.addEventListener('message', (event: MessageEvent<Db2PartitionDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (message && typeof message === 'object' && 'command' in message) {
        handleHostMessage(message);
    }
});

initialize();
