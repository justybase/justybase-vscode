/** @jest-environment jsdom */

interface VsCodeApiMock {
    postMessage: jest.Mock;
    getState: jest.Mock;
    setState: jest.Mock;
}

const originalAddEventListener = window.addEventListener.bind(window);
let api: VsCodeApiMock;
let messageListeners: Array<(event: MessageEvent<unknown>) => void>;

function dispatch(message: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: message });
    messageListeners.forEach((listener) => listener(event));
}

function column(
    sourceIndex: number,
    sourceName: string,
    targetName: string,
    included = true,
) {
    return {
        sourceIndex,
        sourceName,
        targetName,
        defaultTargetName: sourceName,
        included,
        order: sourceIndex,
        inferredType: 'BIGINT',
        selectedType: 'BIGINT',
        overrideMode: 'inferred' as const,
    };
}

function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'harness-session',
        filePath: '/tmp/import.csv',
        sourceKind: 'file',
        sourceName: 'import.csv',
        fileName: 'import.csv',
        fileFormat: 'csv',
        sheetName: undefined,
        availableSheets: [],
        canChangeSheet: false,
        connectionName: 'NZ',
        availableConnections: [],
        databaseKind: 'netezza',
        hasHeaders: true,
        createTable: false,
        canAppendToExistingTable: true,
        canMapExistingTableColumns: true,
        existingTable: {
            status: 'ready',
            columns: [
                { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
                { name: 'NAME', dataType: 'NVARCHAR(20)', nullable: true, hasDefault: false },
            ],
        },
        invalidRowMode: 'abort',
        targetTable: 'ADMIN.TARGET',
        targetLocation: { schema: 'ADMIN', tableName: 'TARGET' },
        targetLocationCapabilities: {
            supportsDatabaseSelection: false,
            supportsSchemaSelection: true,
            enforceActiveDatabase: false,
        },
        availableDatabases: [],
        availableSchemas: ['ADMIN'],
        previewRowCount: 10,
        validationSampleSize: 10,
        detectedDelimiter: ',',
        decimalDelimiter: '.',
        sourceHeaders: ['id', 'name'],
        columns: [column(0, 'id', 'ID'), column(1, 'name', 'NAME')],
        previewRows: [['1', 'Alpha']],
        issues: [],
        warnings: [],
        hasValidationErrors: false,
        executionPlan: {
            mode: 'direct',
            createTableSql: '',
            loadSql: '',
            warnings: [],
        },
        typeOptions: ['BIGINT', 'NVARCHAR(20)'],
        ...overrides,
    };
}

describe('import wizard panel existing-table mapping', () => {
    beforeEach(async () => {
        jest.resetModules();
        messageListeners = [];
        document.body.innerHTML = '<div id="app" class="import-wizard-root"></div>';
        api = {
            postMessage: jest.fn(),
            getState: jest.fn(),
            setState: jest.fn(),
        };
        (globalThis as Record<string, unknown>).acquireVsCodeApi = () => api;
        jest.spyOn(window, 'addEventListener').mockImplementation(
            (type, listener, options) => {
                if (type === 'message' && typeof listener === 'function') {
                    messageListeners.push(listener as (event: MessageEvent<unknown>) => void);
                    return;
                }
                originalAddEventListener(type, listener, options);
            },
        );

        await import('../importWizard/panel.js');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
    });

    it('renders the catalog mapping, marks required targets, and gates execution', () => {
        dispatch({ type: 'sessionInitialized', state: baseState() });

        expect(document.querySelector('.import-existing-target-panel')).not.toBeNull();
        expect(document.querySelectorAll('.import-existing-map-row')).toHaveLength(2);
        expect(document.querySelector('.import-mapping-count')?.textContent).toBe('2 of 2 mapped');
        expect(document.querySelector<HTMLButtonElement>('#execute-import')?.disabled).toBe(false);

        const idSelect = document.querySelector<HTMLSelectElement>('select[data-source-index="0"]');
        expect(idSelect?.value).toBe('ID');
        expect(idSelect?.textContent).toContain('required');
    });

    it('shows unmapped required targets and posts mapping, reload, and invalid-row messages', () => {
        dispatch({
            type: 'sessionInitialized',
            state: baseState({
                existingTable: {
                    status: 'ready',
                    columns: [
                        { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
                        { name: 'Required Note', dataType: 'NVARCHAR(50)', nullable: false, hasDefault: false },
                    ],
                },
                columns: [column(0, 'id', 'ID'), column(1, 'note', 'note', false)],
            }),
        });

        expect(document.querySelector('.import-existing-target-error')?.textContent)
            .toContain('Required Note');
        expect(document.querySelector<HTMLButtonElement>('#execute-import')?.disabled).toBe(true);

        const noteSelect = document.querySelector<HTMLSelectElement>('select[data-source-index="1"]');
        if (!noteSelect) {
            throw new Error('missing note select');
        }
        noteSelect.value = 'Required Note';
        noteSelect.dispatchEvent(new Event('change'));

        document.querySelector<HTMLSelectElement>('#invalid-row-mode')!.value = 'skip';
        document.querySelector<HTMLSelectElement>('#invalid-row-mode')!
            .dispatchEvent(new Event('change'));
        document.querySelector<HTMLButtonElement>('#reload-target-columns')!.click();

        expect(api.postMessage).toHaveBeenCalledWith({
            type: 'mapColumnToTarget',
            sourceIndex: 1,
            targetName: 'Required Note',
        });
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'setInvalidRowMode', mode: 'skip' });
        expect(api.postMessage).toHaveBeenCalledWith({ type: 'reloadTargetColumns' });
    });

    it('allows sample validation errors only when invalid rows are skipped', () => {
        dispatch({
            type: 'sessionInitialized',
            state: baseState({ hasValidationErrors: true }),
        });
        expect(document.querySelector<HTMLButtonElement>('#execute-import')?.disabled).toBe(true);

        dispatch({
            type: 'sessionInitialized',
            state: baseState({ hasValidationErrors: true, invalidRowMode: 'skip' }),
        });
        expect(document.querySelector<HTMLSelectElement>('#invalid-row-mode')?.value).toBe('skip');
        expect(document.querySelector<HTMLButtonElement>('#execute-import')?.disabled).toBe(false);
    });

    it('renders idle, loading, and error catalog states with a disabled reload button', () => {
        dispatch({
            type: 'sessionInitialized',
            state: baseState({
                targetLocation: { schema: 'ADMIN', tableName: '' },
                existingTable: { status: 'idle', columns: [] },
            }),
        });
        expect(document.querySelector('.import-mapping-note')?.textContent)
            .toContain('Choose a destination table');
        expect(document.querySelector<HTMLButtonElement>('#reload-target-columns')?.disabled).toBe(true);

        dispatch({
            type: 'sessionInitialized',
            state: baseState({ existingTable: { status: 'loading', columns: [] } }),
        });
        expect(document.querySelector('.import-mapping-note')?.textContent)
            .toContain('Loading target columns');

        dispatch({
            type: 'sessionInitialized',
            state: baseState({
                existingTable: { status: 'error', columns: [], error: 'Catalog unavailable' },
            }),
        });
        expect(document.querySelector('.import-mapping-note')?.textContent)
            .toContain('Catalog unavailable');
        expect(document.querySelector<HTMLButtonElement>('#reload-target-columns')?.disabled).toBe(false);
    });
});
