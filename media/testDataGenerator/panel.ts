import type {
    ColumnGenerationConfig,
    ColumnStrategyState,
    DataGenerationConfig,
    TestDataGeneratorBootstrapState,
    TestDataGeneratorWebviewToHostMessage,
} from './hostContracts.js';
import { postToHost } from './protocol.js';
import { escapeHtml, quoteIdentifier } from './utils.js';

console.log('window.testDataGeneratorState:', (window as unknown as { testDataGeneratorState?: TestDataGeneratorBootstrapState }).testDataGeneratorState);
const state: TestDataGeneratorBootstrapState = (window as unknown as { testDataGeneratorState?: TestDataGeneratorBootstrapState }).testDataGeneratorState || { connectionName: '', database: '', schema: '', table: '', columns: [] };

let dom: ReturnType<typeof getDomElements> = {} as ReturnType<typeof getDomElements>;
const columnStrategies = new Map<string, ColumnStrategyState>();

interface DetectedColumnStrategy {
    type: ColumnGenerationConfig['strategy'];
    params: Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
    return value === null || value === undefined ? fallback : String(value);
}

function getDomElements(): {
    rowCount: HTMLInputElement | null;
    batchSize: HTMLInputElement | null;
    useTransaction: HTMLInputElement | null;
    columnsTableBody: HTMLElement | null;
    generatePreviewBtn: HTMLElement | null;
    previewInfo: HTMLElement | null;
    sqlPreview: HTMLElement | null;
    copyToClipboardBtn: HTMLElement | null;
    openInEditorBtn: HTMLElement | null;
    generateAndExecuteBtn: HTMLElement | null;
} {
    return {
        rowCount: document.getElementById('rowCount') as HTMLInputElement | null,
        batchSize: document.getElementById('batchSize') as HTMLInputElement | null,
        useTransaction: document.getElementById('useTransaction') as HTMLInputElement | null,
        columnsTableBody: document.getElementById('columnsTableBody'),
        generatePreviewBtn: document.getElementById('generatePreviewBtn'),
        previewInfo: document.getElementById('previewInfo'),
        sqlPreview: document.getElementById('sqlPreview'),
        copyToClipboardBtn: document.getElementById('copyToClipboardBtn'),
        openInEditorBtn: document.getElementById('openInEditorBtn'),
        generateAndExecuteBtn: document.getElementById('generateAndExecuteBtn'),
    };
}

function initialize(): void {
    console.log('Initializing Test Data Generator...');
    dom = getDomElements();
    console.log('DOM elements:', Object.keys(dom));
    renderColumnsTable();
    bindEvents();
    console.log('Test Data Generator initialized successfully');
}

function renderColumnsTable(): void {
    if (!dom.columnsTableBody) return;

    if (!state.columns || state.columns.length === 0) {
        dom.columnsTableBody.innerHTML = '<tr><td colspan="4" class="no-data">No columns found</td></tr>';
        return;
    }

    dom.columnsTableBody.innerHTML = state.columns.map((col, index) => {
        // Auto-detect strategy based on column type
        const strategy = detectStrategy(col.type);
        columnStrategies.set(col.name, {
            strategy: strategy.type,
            params: strategy.params
        });

        return `
            <tr data-column="${escapeHtml(col.name)}">
                <td class="col-name">${escapeHtml(col.name)}</td>
                <td class="col-type" title="${escapeHtml(col.fullType || col.type)}">${escapeHtml(col.type)}</td>
                <td class="col-strategy">
                    <select class="strategy-select" data-column="${escapeHtml(col.name)}">
                        <option value="random" ${strategy.type === 'random' ? 'selected' : ''}>Random</option>
                        <option value="sequence" ${strategy.type === 'sequence' ? 'selected' : ''}>Sequence</option>
                        <option value="faker" ${strategy.type === 'faker' ? 'selected' : ''}>Fake Data</option>
                        <option value="fixed" ${strategy.type === 'fixed' ? 'selected' : ''}>Fixed Value</option>
                        <option value="null" ${strategy.type === 'null' ? 'selected' : ''}>NULL</option>
                    </select>
                </td>
                <td class="col-params">
                    ${renderParams(col.name, strategy.type, strategy.params, col.type)}
                </td>
            </tr>
        `;
    }).join('');

    // Bind strategy change handlers
    document.querySelectorAll('.strategy-select').forEach(select => {
        select.addEventListener('change', handleStrategyChange);
    });

    // Bind param change handlers
    bindParamHandlers();
}

function detectStrategy(columnType: string): DetectedColumnStrategy {
    const upperType = columnType.toUpperCase();

    if (upperType.includes('SERIAL') || upperType.includes('INT') && upperType.includes('IDENTITY')) {
        return { type: 'sequence', params: { start: 1, step: 1 } };
    }

    if (upperType.includes('INT') && !upperType.includes('BIGINT')) {
        return { type: 'random', params: { min: 1, max: 1000000 } };
    }

    if (upperType.includes('BIGINT')) {
        return { type: 'random', params: { min: 1, max: 9007199254740991 } };
    }

    if (upperType.includes('DECIMAL') || upperType.includes('NUMERIC') || upperType.includes('FLOAT') || upperType.includes('DOUBLE') || upperType.includes('REAL')) {
        return { type: 'random', params: { min: 0, max: 1000, precision: 2 } };
    }

    if (upperType.includes('DATE') && !upperType.includes('TIME')) {
        return { type: 'random', params: {} };
    }

    if (upperType.includes('TIMESTAMP') || upperType.includes('TIME')) {
        return { type: 'random', params: {} };
    }

    if (upperType.includes('BOOL')) {
        return { type: 'random', params: {} };
    }

    if (upperType.includes('UUID')) {
        return { type: 'random', params: {} };
    }

    if (upperType.includes('VARCHAR') || upperType.includes('CHAR') || upperType.includes('TEXT')) {
        return { type: 'faker', params: { category: 'STRING' } };
    }

    return { type: 'random', params: { length: 20 } };
}

function renderParams(
    columnName: string,
    strategy: string,
    params: Record<string, unknown> | undefined,
    columnType: string,
): string {
    const upperType = columnType.toUpperCase();

    switch (strategy) {
        case 'random':
            if (upperType.includes('INT') || upperType.includes('SERIAL')) {
                return `
                    <div class="param-row">
                        <label>Min:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="min" value="${params?.min ?? 1}">
                        <label>Max:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="max" value="${params?.max ?? 1000000}">
                    </div>
                `;
            }
            if (upperType.includes('FLOAT') || upperType.includes('DOUBLE') || upperType.includes('DECIMAL') || upperType.includes('NUMERIC') || upperType.includes('REAL')) {
                return `
                    <div class="param-row">
                        <label>Min:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="min" value="${params?.min ?? 0}">
                        <label>Max:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="max" value="${params?.max ?? 1000}">
                        <label>Precision:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="precision" value="${params?.precision ?? 2}">
                    </div>
                `;
            }
            if (upperType.includes('VARCHAR') || upperType.includes('CHAR') || upperType.includes('TEXT')) {
                return `
                    <div class="param-row">
                        <label>Length:</label>
                        <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="length" value="${params?.length ?? 20}">
                    </div>
                `;
            }
            return '<span class="no-params">No params needed</span>';

        case 'sequence':
            return `
                <div class="param-row">
                    <label>Start:</label>
                    <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="start" value="${params?.start ?? 1}">
                    <label>Step:</label>
                    <input type="number" class="param-input" data-column="${escapeHtml(columnName)}" data-param="step" value="${params?.step ?? 1}">
                </div>
            `;

        case 'faker':
            return `
                <div class="param-row">
                    <label>Category:</label>
                    <select class="param-select" data-column="${escapeHtml(columnName)}" data-param="category">
                        <option value="STRING" ${params?.category === 'STRING' ? 'selected' : ''}>Random String</option>
                        <option value="NAME" ${params?.category === 'NAME' ? 'selected' : ''}>Full Name</option>
                        <option value="FIRST_NAME" ${params?.category === 'FIRST_NAME' ? 'selected' : ''}>First Name</option>
                        <option value="LAST_NAME" ${params?.category === 'LAST_NAME' ? 'selected' : ''}>Last Name</option>
                        <option value="EMAIL" ${params?.category === 'EMAIL' ? 'selected' : ''}>Email</option>
                        <option value="PHONE" ${params?.category === 'PHONE' ? 'selected' : ''}>Phone</option>
                        <option value="CITY" ${params?.category === 'CITY' ? 'selected' : ''}>City</option>
                        <option value="ADDRESS" ${params?.category === 'ADDRESS' ? 'selected' : ''}>Address</option>
                        <option value="DEPARTMENT" ${params?.category === 'DEPARTMENT' ? 'selected' : ''}>Department</option>
                        <option value="PRODUCT" ${params?.category === 'PRODUCT' ? 'selected' : ''}>Product</option>
                    </select>
                </div>
            `;

        case 'fixed':
            return `
                <div class="param-row">
                    <label>Value:</label>
                    <input type="text" class="param-input" data-column="${escapeHtml(columnName)}" data-param="value" value="${escapeHtml(asString(params?.value))}">
                </div>
            `;

        case 'null':
            return '<span class="no-params">Will insert NULL</span>';

        default:
            return '';
    }
}

function handleStrategyChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
        return;
    }

    const columnName = target.dataset.column;
    const strategy = target.value;
    if (!columnName) {
        return;
    }

    const col = state.columns.find(c => c.name === columnName);

    if (col) {
        const defaultParams = detectStrategy(col.type).params;
        columnStrategies.set(columnName, { strategy, params: defaultParams });

        // Re-render params for this row
        const row = target.closest('tr');
        const paramsCell = row?.querySelector('.col-params');
        if (paramsCell) {
            paramsCell.innerHTML = renderParams(columnName, strategy, defaultParams, col.type);
        }

        bindParamHandlers();
    }
}

function bindParamHandlers(): void {
    document.querySelectorAll('.param-input, .param-select').forEach(input => {
        // Remove existing listeners to avoid duplicates
        const parent = input.parentNode;
        if (!parent) return;
        const newInput = input.cloneNode(true);
        parent.replaceChild(newInput, input);

        newInput.addEventListener('change', handleParamChange);
        newInput.addEventListener('input', handleParamChange);
    });
}

function handleParamChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
        return;
    }

    const columnName = target.dataset.column;
    const paramName = target.dataset.param;
    if (!columnName || !paramName) {
        return;
    }

    const value = target instanceof HTMLInputElement && target.type === 'number'
        ? Number(target.value)
        : target.value;

    const currentConfig = columnStrategies.get(columnName);
    if (currentConfig) {
        currentConfig.params = currentConfig.params || {};
        currentConfig.params[paramName] = value;
        columnStrategies.set(columnName, currentConfig);
    }
}

function bindEvents(): void {
    if (!dom.generatePreviewBtn) {
        console.error('Generate Preview button not found');
        return;
    }

    dom.generatePreviewBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        generatePreview();
    });

    dom.copyToClipboardBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sql = dom.sqlPreview?.textContent;
        if (sql && !sql.includes('Click "Generate Preview"')) {
            postToHost({ command: 'copyToClipboard', sql });
        }
    });

    dom.openInEditorBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sql = dom.sqlPreview?.textContent;
        if (sql && !sql.includes('Click "Generate Preview"')) {
            postToHost({ command: 'openInEditor', sql });
        }
    });

    dom.generateAndExecuteBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const config = getGenerationConfig();
        postToHost({ command: 'generateData', config });
    });

    console.log('Event listeners bound successfully');
}

function getGenerationConfig(): DataGenerationConfig {
    const columns: ColumnGenerationConfig[] = state.columns.map(col => {
        const config = columnStrategies.get(col.name) || { strategy: 'random', params: {} };
        return {
            name: col.name,
            type: col.type,
            strategy: config.strategy as ColumnGenerationConfig['strategy'],
            params: config.params || {},
        };
    });

    return {
        rowCount: parseInt(dom.rowCount?.value ?? '', 10) || 1000,
        batchSize: parseInt(dom.batchSize?.value ?? '', 10) || 500,
        useTransaction: Boolean(dom.useTransaction?.checked),
        columns,
    };
}

function generatePreview(): void {
    console.log('generatePreview called');
    const config = getGenerationConfig();
    console.log('Config:', config);
    const qualifiedTable = `${quoteIdentifier(state.database)}.${quoteIdentifier(state.schema)}.${quoteIdentifier(state.table)}`;
    console.log('Table:', qualifiedTable);

    let sql = '';

    if (config.useTransaction) {
        sql += 'BEGIN;\n\n';
    }

    const columnNames = config.columns.map(c => quoteIdentifier(c.name)).join(', ');
    const batches = Math.min(3, Math.ceil(config.rowCount / config.batchSize));

    for (let batch = 0; batch < batches; batch++) {
        const startRow = batch * config.batchSize;
        const endRow = Math.min(startRow + config.batchSize, batch === batches - 1 ? Math.min(config.rowCount, 100) : config.batchSize);

        for (let rowIdx = startRow; rowIdx < endRow; rowIdx++) {
            const rowValues = config.columns.map(col => generateValuePreview(col, rowIdx));
            sql += `INSERT INTO ${qualifiedTable} (${columnNames}) VALUES (${rowValues.join(', ')});\n`;
        }

        sql += '\n';
    }

    if (config.rowCount > 100) {
        const remainingBatches = Math.ceil((config.rowCount - 100) / config.batchSize);
        sql += `-- ... ${config.rowCount - 100} more rows in ${remainingBatches} batch(es) ...\n\n`;
    }

    if (config.useTransaction) {
        sql += 'COMMIT;';
    }

    dom.sqlPreview && (dom.sqlPreview.textContent = sql);
    dom.previewInfo && (dom.previewInfo.textContent = `Preview: ${Math.min(config.rowCount, 100)} rows shown`);
}

function generateValuePreview(column: ColumnGenerationConfig, rowIndex: number): string {
    const { strategy, type, params = {} } = column;

    switch (strategy) {
        case 'null':
            return 'NULL';

        case 'fixed':
            return escapeSqlValue(params.value, type);

        case 'sequence': {
            const start = asNumber(params.start, 1);
            const step = asNumber(params.step, 1);
            return String(start + rowIndex * step);
        }

        case 'faker':
            return generateFakerPreview(asString(params.category, 'STRING'), type);

        case 'random':
        default:
            return generateRandomPreview(type, params);
    }
}

function generateRandomPreview(type: string, params: Record<string, unknown>): string {
    const upperType = type.toUpperCase();

    if (upperType.includes('INT') || upperType.includes('SERIAL') || upperType.includes('NUMERIC') || upperType.includes('DECIMAL')) {
        const min = asNumber(params.min, 1);
        const max = asNumber(params.max, 1000000);
        return String(Math.floor(Math.random() * (max - min + 1)) + min);
    }

    if (upperType.includes('FLOAT') || upperType.includes('DOUBLE') || upperType.includes('REAL')) {
        const min = asNumber(params.min, 0);
        const max = asNumber(params.max, 1000);
        const precision = asNumber(params.precision, 2);
        const value = Math.random() * (max - min) + min;
        return value.toFixed(precision);
    }

    if (upperType.includes('DATE') && !upperType.includes('TIME')) {
        const start = new Date('2020-01-01').getTime();
        const end = new Date('2025-12-31').getTime();
        const randomDate = new Date(start + Math.random() * (end - start));
        return `'${randomDate.toISOString().split('T')[0]}'`;
    }

    if (upperType.includes('TIMESTAMP') || upperType.includes('TIME')) {
        const start = new Date('2020-01-01').getTime();
        const end = new Date('2025-12-31').getTime();
        const randomDate = new Date(start + Math.random() * (end - start));
        return `'${randomDate.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23)}'`;
    }

    if (upperType.includes('BOOL')) {
        return Math.random() > 0.5 ? 'TRUE' : 'FALSE';
    }

    if (upperType.includes('UUID')) {
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        return `'${uuid}'`;
    }

    const length = asNumber(params.length, 20);
    return `'${generateRandomString(length)}'`;
}

function getMaxLengthFromType(type: string): number {
    if (!type) return 255;
    // Match patterns like VARCHAR(17), CHAR(10), NATIONAL CHARACTER VARYING(17)
    const match = type.match(/\((\d+)\)/);
    return match ? parseInt(match[1], 10) : 255;
}

function fitStringToLength(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength);
}

function generateFakerPreview(category: string, type: string): string {
    const upperCategory = (category || 'STRING').toUpperCase();
    const maxLength = getMaxLengthFromType(type);

    const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia'];
    const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'];
    const departments = ['Sales', 'Marketing', 'Engineering', 'HR', 'Finance'];

    switch (upperCategory) {
        case 'NAME': {
            const name = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
            return `'${fitStringToLength(name, maxLength)}'`;
        }
        case 'FIRST_NAME': {
            const fname = firstNames[Math.floor(Math.random() * firstNames.length)];
            return `'${fitStringToLength(fname, maxLength)}'`;
        }
        case 'LAST_NAME': {
            const lname = lastNames[Math.floor(Math.random() * lastNames.length)];
            return `'${fitStringToLength(lname, maxLength)}'`;
        }
        case 'EMAIL': {
            const fname = firstNames[Math.floor(Math.random() * firstNames.length)].toLowerCase();
            const lname = lastNames[Math.floor(Math.random() * lastNames.length)].toLowerCase();
            const email = `${fname}.${lname}@example.com`;
            return `'${fitStringToLength(email, maxLength)}'`;
        }
        case 'PHONE': {
            const phone = `(${Math.floor(Math.random() * 900) + 100}) ${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`;
            return `'${fitStringToLength(phone, maxLength)}'`;
        }
        case 'CITY': {
            const city = cities[Math.floor(Math.random() * cities.length)];
            return `'${fitStringToLength(city, maxLength)}'`;
        }
        case 'DEPARTMENT': {
            const dept = departments[Math.floor(Math.random() * departments.length)];
            return `'${fitStringToLength(dept, maxLength)}'`;
        }
        case 'ADDRESS': {
            const addr = `${Math.floor(Math.random() * 9000) + 100} Main St`;
            return `'${fitStringToLength(addr, maxLength)}'`;
        }
        case 'PRODUCT': {
            const product = `Widget-${Math.floor(Math.random() * 90000) + 10000}`;
            return `'${fitStringToLength(product, maxLength)}'`;
        }
        case 'STRING':
        default:
            return `'${generateRandomString(Math.min(20, maxLength))}'`;
    }
}

function generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function escapeSqlValue(value: unknown, type: string): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    const upperType = type.toUpperCase();

    if (upperType.includes('INT') || upperType.includes('FLOAT') || upperType.includes('DOUBLE') ||
        upperType.includes('NUMERIC') || upperType.includes('DECIMAL') || upperType.includes('REAL') ||
        upperType.includes('SERIAL') || upperType.includes('BOOL')) {
        return String(value);
    }

    const strValue = String(value).replace(/'/g, "''");
    return `'${strValue}'`;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded - Initializing Test Data Generator');
    initialize();
});

// Also try immediate initialization in case DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    console.log('DOM already ready - Initializing Test Data Generator');
    setTimeout(initialize, 0);
}
