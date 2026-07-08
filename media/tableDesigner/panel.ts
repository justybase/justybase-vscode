import type {
    TableDesignerColumn,
    TableDesignerHostToWebviewMessage,
    TableDesignerInitialContext,
    TableDesignerWebviewToHostMessage,
} from './hostContracts.js';
import { eventTargetAsHtmlElement, eventTargetAsInput, getElementById } from './dom.js';
import { postToHost } from './protocol.js';

const context = (
    window as unknown as { initialContext: TableDesignerInitialContext }
).initialContext;
const isSqlite = context.databaseKind === 'sqlite';
const isDb2 = context.databaseKind === 'db2';
const isNetezzaDialect = !isSqlite && !isDb2;
const SQLITE_RESERVED_KEYWORDS = new Set(context.sqliteKeywords || []);
const DB2_RESERVED_KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'AS', 'BY', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CURRENT', 'DATE',
    'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RIGHT', 'SCHEMA',
    'SELECT', 'SET', 'TABLE', 'TIME', 'TIMESTAMP', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALUES', 'VIEW',
    'WHERE',
]);

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
        executeBtn.disabled = executing;
        executeBtn.textContent = executing ? 'Executing…' : 'Execute Table Creation';
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

const DEFAULT_DATA_TYPES = [
    'INTEGER', 'BIGINT', 'SMALLINT', 'BYTEINT',
    'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE PRECISION',
    'CHARACTER', 'VARCHAR', 'NCHAR', 'NVARCHAR',
    'DATE', 'TIME', 'TIMESTAMP', 'INTERVAL',
    'BOOLEAN', 'JSON', 'JSONB',
];
const SQLITE_DATA_TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'];

function getDataTypes(): string[] {
    return isSqlite ? SQLITE_DATA_TYPES : DEFAULT_DATA_TYPES;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function formatIdentifier(identifier: string): string {
    const value = (identifier || '').trim();
    if (!value) {
        return value;
    }

    if (isSqlite) {
        const simpleIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
        if (simpleIdentifier && !SQLITE_RESERVED_KEYWORDS.has(value.toUpperCase())) {
            return value;
        }
    } else if (isDb2) {
        const db2SimpleIdentifier = /^[A-Z_][A-Z0-9_]*$/.test(value);
        if (db2SimpleIdentifier && !DB2_RESERVED_KEYWORDS.has(value.toUpperCase())) {
            return value;
        }
    } else {
        return quoteIdentifier(value);
    }

    return quoteIdentifier(value);
}

function buildTargetPath(tableName: string): string {
    if (isSqlite) {
        const catalog = context.schemaName || context.dbName;
        return catalog ? `${formatIdentifier(catalog)}.${formatIdentifier(tableName)}` : formatIdentifier(tableName);
    }
    if (isDb2) {
        const schema = (context.schemaName || '').trim();
        return schema ? `${formatIdentifier(schema)}.${formatIdentifier(tableName)}` : formatIdentifier(tableName);
    }
    return `${quoteIdentifier(context.dbName)}.${quoteIdentifier(context.schemaName)}.${quoteIdentifier(tableName)}`;
}

function updateDialectUi(): void {
    const organizeSection = getElementById('organizeSection');
    const organizeNoneLabel = getElementById('organizeNoneLabel');

    document.querySelectorAll('.distribution-column').forEach(element => {
        element.classList.toggle('hidden', !isNetezzaDialect);
    });

    if (organizeSection) {
        organizeSection.classList.toggle('hidden', !isNetezzaDialect);
    }
    if (organizeNoneLabel) {
        organizeNoneLabel.classList.toggle('hidden', !isNetezzaDialect);
    }

    const tableTypeSelect = getElementById<HTMLSelectElement>('tableType');
    if ((isSqlite || isDb2) && tableTypeSelect) {
        tableTypeSelect.innerHTML = `
            <option value="PERMANENT">PERMANENT</option>
            <option value="TEMP">TEMP</option>
            <option value="TEMPORARY">TEMPORARY</option>
        `;
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
            type: isSqlite ? 'TEXT' : 'VARCHAR',
            length: isSqlite ? '' : '255',
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
        postToHost({ command: 'executeDDL', ddl });
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

    if (!isNetezzaDialect) {
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

    let tableName = tableNameInput.value.trim();
    if (!tableName) tableName = isSqlite ? 'new_table' : 'NEW_TABLE';

    const tableType = tableTypeSelect.value;
    const ifNotExists = ifNotExistsInput.checked;
    const organizeNone = organizeNoneInput.checked;
    const organizeColumnsValue = organizeColumnsInput.value.trim();
    const tableConstraintsValue = tableConstraintsInput.value.trim();

    const createPrefix = tableType === 'PERMANENT' ? 'CREATE TABLE' : `CREATE ${tableType} TABLE`;
    const ifNotExistsClause = ifNotExists ? ' IF NOT EXISTS' : '';
    let ddl = `${createPrefix}${ifNotExistsClause} ${buildTargetPath(tableName)} (\n`;

    const pkColumns: string[] = [];
    const distributeColumns: string[] = [];

    const colDefs = columns.map(col => {
        let def = `    ${formatIdentifier(col.name || 'UNNAMED')} ${col.type}`;

        if (col.length && ['VARCHAR', 'NVARCHAR', 'CHARACTER', 'NCHAR', 'NUMERIC', 'DECIMAL'].includes(col.type)) {
            def += `(${col.length})`;
        }

        if (col.defaultValue) {
            const isString = ['VARCHAR', 'NVARCHAR', 'CHARACTER', 'NCHAR', 'DATE', 'TIME', 'TIMESTAMP'].includes(col.type);
            const isFunction = col.defaultValue.toUpperCase().includes('()') || col.defaultValue.toUpperCase() === 'CURRENT_DATE' || col.defaultValue.toUpperCase() === 'CURRENT_TIMESTAMP';

            if (isString && !col.defaultValue.startsWith("'") && !isFunction) {
                def += ` DEFAULT '${col.defaultValue}'`;
            } else {
                def += ` DEFAULT ${col.defaultValue}`;
            }
        }

        if (col.notNull) {
            def += ' NOT NULL';
        }

        if (col.pk) {
            pkColumns.push(col.name || 'UNNAMED');
        }

        if (col.distribute) {
            distributeColumns.push(col.name || 'UNNAMED');
        }

        return def;
    });

    ddl += colDefs.join(',\n');

    if (pkColumns.length > 0) {
        ddl += `,\n    PRIMARY KEY (${pkColumns.map(column => formatIdentifier(column)).join(', ')})`;
    }

    const tableConstraints = tableConstraintsValue
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    tableConstraints.forEach(constraint => {
        ddl += `,\n    ${constraint}`;
    });

    ddl += '\n)';

    if (isNetezzaDialect && distributeColumns.length > 0) {
        ddl += ` DISTRIBUTE ON ("${distributeColumns.join('", "')}")`;
    } else if (isNetezzaDialect) {
        ddl += ' DISTRIBUTE ON RANDOM';
    }

    if (isNetezzaDialect && organizeNone) {
        ddl += ' ORGANIZE ON NONE';
    } else if (isNetezzaDialect && organizeColumnsValue) {
        const organizeColumns = organizeColumnsValue
            .split(',')
            .map(col => col.trim())
            .filter(col => col.length > 0);
        if (organizeColumns.length > 0) {
            ddl += ` ORGANIZE ON ("${organizeColumns.join('", "')}")`;
        }
    }

    ddl += ';';

    ddlPreview.value = ddl;
}
