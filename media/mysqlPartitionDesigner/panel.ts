import {
    buildMysqlAddHashKeyPartitionSql,
    buildMysqlAddRangeListPartitionSql,
    buildMysqlCoalescePartitionSql,
    buildMysqlDropPartitionSql,
} from '../../extensions/mysql/src/mysqlDesignerDdl.js';
import type {
    MysqlDesignerPartition,
    MysqlPartitionDesignerHostToWebviewMessage,
    MysqlPartitionDesignerInitialContext,
    MysqlPartitionOperationRequest,
} from './hostContracts.js';
import { vscode } from './protocol.js';

type ActiveOperation = 'add' | 'manage';

let context = (window as unknown as { initialContext: MysqlPartitionDesignerInitialContext }).initialContext;
let activeOperation: ActiveOperation = 'add';
let selectedPartitionName: string | undefined;
let executing = false;

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

function inputValue(id: string): string {
    return byId<HTMLInputElement>(id).value.trim();
}

function isHashKeyMethod(method: MysqlPartitionDesignerInitialContext['capabilities']['partitionMethod']): boolean {
    return method === 'HASH' || method === 'LINEAR HASH' || method === 'KEY' || method === 'LINEAR KEY';
}

function topLevelPartitions(): MysqlDesignerPartition[] {
    return context.partitions.filter(partition => !partition.subpartitionName);
}

function formatBytes(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '-';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = value;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
        amount /= 1024;
        index += 1;
    }
    return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function renderPartitioningInfo(): void {
    const info = byId('partitioningInfo');
    const capabilities = context.capabilities;
    if (!capabilities.isPartitioned) {
        info.className = 'partitioning-info warning';
        info.textContent = `${capabilities.reason || 'This table is not partitioned.'} Engine: ${capabilities.engine}.`;
        return;
    }
    info.className = capabilities.reason ? 'partitioning-info warning' : 'partitioning-info';
    const expression = capabilities.partitionExpression ? ` (${capabilities.partitionExpression})` : '';
    info.textContent = `Engine: ${capabilities.engine} · ${capabilities.partitionMethod || 'UNKNOWN'}${expression}${capabilities.subpartitionMethod ? ` · SUBPARTITION BY ${capabilities.subpartitionMethod}` : ''}${capabilities.reason ? ` · ${capabilities.reason}` : ''}`;
}

function renderPartitions(): void {
    const body = byId<HTMLTableSectionElement>('partitionsBody');
    body.replaceChildren();
    const partitions = context.partitions;
    byId('partitionCount').textContent = `${topLevelPartitions().length} partition${topLevelPartitions().length === 1 ? '' : 's'}`;
    if (partitions.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.textContent = 'No partitions found.';
        row.appendChild(cell);
        body.appendChild(row);
        return;
    }

    partitions.forEach(partition => {
        const row = document.createElement('tr');
        const name = partition.subpartitionName ? `${partition.name} / ${partition.subpartitionName}` : partition.name;
        const values = [
            name,
            partition.method,
            partition.description || partition.partitionExpression || '-',
            partition.rowCount === undefined ? '-' : partition.rowCount.toLocaleString(),
            formatBytes(partition.dataLength),
            formatBytes(partition.indexLength),
        ];
        values.forEach(value => {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
        });
        const actions = document.createElement('td');
        if (!partition.subpartitionName && context.capabilities.canDropPartition && context.capabilities.dropMode === 'named') {
            const drop = document.createElement('button');
            drop.type = 'button';
            drop.className = 'row-button danger';
            drop.textContent = 'Drop';
            drop.addEventListener('click', () => {
                selectedPartitionName = partition.name;
                setActiveOperation('manage');
                refreshDdl();
            });
            actions.appendChild(drop);
        } else {
            actions.textContent = partition.subpartitionName ? 'Read-only' : 'Unavailable';
        }
        row.appendChild(actions);
        body.appendChild(row);
    });
}

function updateFormVisibility(): void {
    const method = context.capabilities.partitionMethod;
    const rangeList = method === 'RANGE' || method === 'LIST';
    const hashKey = isHashKeyMethod(method);
    byId('rangeListForm').classList.toggle('hidden', !rangeList);
    byId('hashKeyForm').classList.toggle('hidden', !hashKey);
    byId('coalesceForm').classList.toggle('hidden', !(activeOperation === 'manage' && hashKey && context.capabilities.canDropPartition));
    const addDisabled = !context.capabilities.canAddPartition || activeOperation !== 'add';
    ['addPartitionName', 'addValuesClause', 'addPartitionCount'].forEach(id => {
        byId<HTMLInputElement>(id).disabled = addDisabled;
    });
}

function setActiveOperation(operation: ActiveOperation): void {
    activeOperation = operation;
    byId('addSection').classList.toggle('hidden', operation !== 'add');
    byId('manageSection').classList.toggle('hidden', operation !== 'manage');
    document.querySelectorAll<HTMLButtonElement>('[data-operation]').forEach(button => {
        button.classList.toggle('active', button.dataset.operation === operation);
    });
    updateFormVisibility();
    updateActionAvailability();
    refreshDdl();
}

function buildRequest(): MysqlPartitionOperationRequest {
    const capabilities = context.capabilities;
    if (!capabilities.isPartitioned) {
        throw new Error(capabilities.reason || 'This table is not partitioned.');
    }
    if (activeOperation === 'add') {
        if (!capabilities.canAddPartition) {
            throw new Error(capabilities.reason || 'Adding a partition is not supported for this table.');
        }
        if (capabilities.partitionMethod === 'RANGE' || capabilities.partitionMethod === 'LIST') {
            return {
                operation: 'addRangeList',
                partitionName: inputValue('addPartitionName'),
                valuesClause: inputValue('addValuesClause'),
            };
        }
        if (isHashKeyMethod(capabilities.partitionMethod)) {
            return {
                operation: 'addHashKey',
                partitionCount: Number(inputValue('addPartitionCount')),
            };
        }
        throw new Error('This partition method is not supported for adding partitions.');
    }

    if (isHashKeyMethod(capabilities.partitionMethod)) {
        return {
            operation: 'coalesce',
            partitionCount: Number(inputValue('coalesceCount')),
        };
    }
    if (capabilities.dropMode !== 'named' || !selectedPartitionName) {
        throw new Error('Select a partition to drop first.');
    }
    return { operation: 'drop', partitionName: selectedPartitionName };
}

function buildDdl(): string {
    const request = buildRequest();
    const { schema, tableName } = context;
    switch (request.operation) {
        case 'addRangeList':
            return buildMysqlAddRangeListPartitionSql({
                schema,
                tableName,
                partitionName: request.partitionName,
                valuesClause: request.valuesClause,
                method: context.capabilities.partitionMethod === 'LIST' ? 'LIST' : 'RANGE',
            });
        case 'addHashKey':
            return buildMysqlAddHashKeyPartitionSql({ schema, tableName, partitionCount: request.partitionCount });
        case 'drop':
            return buildMysqlDropPartitionSql({ schema, tableName, partitionName: request.partitionName });
        case 'coalesce':
            return buildMysqlCoalescePartitionSql({ schema, tableName, partitionCount: request.partitionCount });
    }
}

function updateActionAvailability(): void {
    let available = false;
    try {
        buildDdl();
        available = true;
    } catch {
        available = false;
    }
    ['executeDdlBtn', 'saveAsSqlBtn', 'copyDdlBtn'].forEach(id => {
        byId<HTMLButtonElement>(id).disabled = executing || !available;
    });
}

function refreshDdl(): void {
    const preview = byId<HTMLTextAreaElement>('ddlPreview');
    try {
        preview.value = buildDdl();
    } catch (error) {
        preview.value = `-- ${error instanceof Error ? error.message : String(error)}`;
    }
    updateActionAvailability();
}

function getExecutableRequest(): MysqlPartitionOperationRequest | undefined {
    try {
        const request = buildRequest();
        byId<HTMLTextAreaElement>('ddlPreview').value = buildDdl();
        clearStatus();
        return request;
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error');
        return undefined;
    }
}

function setExecuting(value: boolean): void {
    executing = value;
    ['executeDdlBtn', 'saveAsSqlBtn', 'copyDdlBtn', 'reloadBtn'].forEach(id => {
        byId<HTMLButtonElement>(id).disabled = value;
    });
    byId<HTMLButtonElement>('executeDdlBtn').textContent = value ? 'Executing...' : 'Execute';
    if (!value) {
        updateActionAvailability();
    }
}

function applyContext(nextContext: MysqlPartitionDesignerInitialContext): void {
    context = nextContext;
    if (selectedPartitionName && !topLevelPartitions().some(partition => partition.name.toLowerCase() === selectedPartitionName!.toLowerCase())) {
        selectedPartitionName = undefined;
    }
    renderPartitioningInfo();
    renderPartitions();
    updateFormVisibility();
    refreshDdl();
}

function handleHostMessage(message: MysqlPartitionDesignerHostToWebviewMessage): void {
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
    renderPartitioningInfo();
    renderPartitions();
    updateFormVisibility();
    document.querySelectorAll<HTMLButtonElement>('[data-operation]').forEach(button => {
        button.addEventListener('click', () => setActiveOperation(button.dataset.operation as ActiveOperation));
    });
    ['addPartitionName', 'addValuesClause', 'addPartitionCount', 'coalesceCount'].forEach(id => {
        const element = byId<HTMLInputElement>(id);
        element.addEventListener('input', refreshDdl);
        element.addEventListener('change', refreshDdl);
    });
    byId<HTMLButtonElement>('reloadBtn').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
    byId<HTMLButtonElement>('executeDdlBtn').addEventListener('click', () => {
        const request = getExecutableRequest();
        if (request) vscode.postMessage({ command: 'executeOperation', request });
    });
    byId<HTMLButtonElement>('saveAsSqlBtn').addEventListener('click', () => {
        const request = getExecutableRequest();
        if (request) vscode.postMessage({ command: 'saveAsSql', request });
    });
    byId<HTMLButtonElement>('copyDdlBtn').addEventListener('click', () => {
        const request = getExecutableRequest();
        if (request) vscode.postMessage({ command: 'copyDDL', request });
    });
    setActiveOperation('add');
}

window.addEventListener('message', (event: MessageEvent<MysqlPartitionDesignerHostToWebviewMessage>) => {
    const message = event.data;
    if (message && typeof message === 'object' && 'command' in message) {
        handleHostMessage(message);
    }
});

initialize();
