import { createTabularDataImporter } from '../import/tabularDataImporter';
import { getImportWizardAdapter } from '../import/wizard/adapters';
import { ImportWizardService } from '../import/wizard/ImportWizardService';
import type { ImportColumnOptions, ImportResult } from '../import/dataImporter';

jest.mock('../import/tabularDataImporter', () => ({
    createTabularDataImporter: jest.fn(),
}));

jest.mock('../import/wizard/adapters', () => ({
    getImportWizardAdapter: jest.fn(),
}));

describe('ImportWizardService', () => {
    const executeMock = jest.fn<Promise<ImportResult>, [unknown]>();
    const fakeAdapter = {
        kind: 'postgresql' as const,
        normalizeTargetColumnName: jest.fn((name: string) => name.trim().toLowerCase()),
        getSupportedTypeOptions: jest.fn(() => ['BIGINT', 'VARCHAR(255)', 'DATE']),
        mapInferredType: jest.fn((typeName: string) => typeName.toUpperCase()),
        validateTypeOverride: jest.fn(() => []),
        buildCreateTableSql: jest.fn((input: { targetTable: string; columns: Array<{ columnName: string; dataType: string }> }) =>
            `CREATE TABLE ${input.targetTable} (${input.columns.map((column) => `${column.columnName} ${column.dataType}`).join(', ')})`,
        ),
        buildLoadSql: jest.fn(() => 'LOAD PREVIEW SQL'),
        buildExecutionPlan: jest.fn((input: { targetTable: string; columns: Array<{ columnName: string; dataType: string }> }) => ({
            mode: 'direct' as const,
            createTableSql: `CREATE TABLE ${input.targetTable} (${input.columns.map((column) => `${column.columnName} ${column.dataType}`).join(', ')})`,
            loadSql: 'LOAD PREVIEW SQL',
            warnings: [],
        })),
        execute: executeMock,
        getExecutionMode: jest.fn(() => 'direct' as const),
    };

    const importerState = {
        selectedSheet: 'Sheet1',
        appliedOptions: undefined as ImportColumnOptions | undefined,
    };

    const fakeImporter = {
        getAvailableSheetNames: jest.fn(async () => ['Sheet1', 'Sheet2']),
        getSelectedSheet: jest.fn(() => importerState.selectedSheet),
        setSelectedSheet: jest.fn((sheetName?: string) => {
            importerState.selectedSheet = sheetName || 'Sheet1';
        }),
        analyzeDataTypes: jest.fn(async () => []),
        getSampleRows: jest.fn(async (limit: number) => [['1', 'Alice'], ['2', 'Bob']].slice(0, limit)),
        getSourceHeaders: jest.fn(() => ['ID', 'NAME']),
        getColumnMappings: jest.fn(() => [
            { sourceColumn: 'ID', targetColumn: 'id', dataType: 'BIGINT' },
            { sourceColumn: 'NAME', targetColumn: 'name', dataType: 'VARCHAR(255)' },
        ]),
        applyColumnOptions: jest.fn((options?: ImportColumnOptions) => {
            importerState.appliedOptions = options;
        }),
        getEffectiveColumnDescriptors: jest.fn(() => {
            const selectedColumnIndexes = importerState.appliedOptions?.selectedColumnIndexes || [0, 1];
            const names = ['id', 'name'];
            const types = ['BIGINT', 'VARCHAR(255)'];
            return selectedColumnIndexes.map((index) => ({
                sourceIndex: index,
                columnName: importerState.appliedOptions?.columnNameOverrides?.[index] || names[index],
                dataType: importerState.appliedOptions?.forcedColumnTypes?.[index] || types[index],
            }));
        }),
        getCsvDelimiter: jest.fn(() => ','),
        getDecimalDelimiter: jest.fn(() => '.'),
        updateTargetTable: jest.fn(),
        getDelegate: jest.fn(() => ({})),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        importerState.selectedSheet = 'Sheet1';
        importerState.appliedOptions = undefined;
        executeMock.mockResolvedValue({ success: true, message: 'Import finished.' });
        (createTabularDataImporter as jest.Mock).mockReturnValue(fakeImporter);
        (getImportWizardAdapter as jest.Mock).mockReturnValue(fakeAdapter);
    });

    it('creates an initial session state with preview rows and SQL preview', async () => {
        const service = new ImportWizardService();
        const state = await service.createSession({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            connectionName: 'WAREHOUSE',
            previewRowCount: 2,
            validationSampleSize: 10,
        });

        expect(state.fileName).toBe('orders.csv');
        expect(state.availableSheets).toEqual(['Sheet1', 'Sheet2']);
        expect(state.columns.map((column) => column.targetName)).toEqual(['id', 'name']);
        expect(state.previewRows[0]).toEqual(['1', 'Alice']);
        expect(state.executionPlan.createTableSql).toContain('CREATE TABLE public.orders');
        expect(state.executionPlan.loadSql).toBe('LOAD PREVIEW SQL');
    });

    it('supports reorder, rename, and validation updates', async () => {
        const service = new ImportWizardService();
        const initialState = await service.createSession({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            previewRowCount: 2,
            validationSampleSize: 10,
        });

        const reorderedState = await service.reorderColumns(initialState.id, [1, 0]);
        expect(reorderedState.columns[0].sourceIndex).toBe(1);
        expect(reorderedState.previewRows[0]).toEqual(['Alice', '1']);

        const renamedState = await service.renameColumn(initialState.id, 1, 'Customer Name');
        expect(renamedState.columns[0].targetName).toBe('customer name');

        const validatedState = await service.setColumnType(initialState.id, 0, 'DATE');
        expect(validatedState.hasValidationErrors).toBe(true);
        expect(validatedState.issues[0].message).toContain('date');
    });

    it('validates additional sample rows beyond the visible preview row count', async () => {
        const service = new ImportWizardService();
        const initialState = await service.createSession({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            previewRowCount: 1,
            validationSampleSize: 2,
        });

        const validatedState = await service.setColumnType(initialState.id, 0, 'DATE');

        expect(validatedState.previewRows).toHaveLength(1);
        expect(validatedState.issues.some((issue) => issue.rowIndex === 1)).toBe(true);
    });

    it('builds execution column options and delegates execution', async () => {
        const service = new ImportWizardService();
        const state = await service.createSession({
            filePath: '/tmp/orders.csv',
            targetTable: 'public.orders',
            connectionDetails: {
                dbType: 'postgresql',
                host: 'localhost',
                database: 'warehouse',
                user: 'postgres',
            } as never,
            previewRowCount: 2,
            validationSampleSize: 10,
        });

        await service.renameColumn(state.id, 1, 'customer_name');
        await service.toggleColumn(state.id, 0, false);

        const result = await service.executeImport(state.id);

        expect(result.success).toBe(true);
        expect(executeMock).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: '/tmp/orders.csv',
                targetTable: 'public.orders',
                columnOptions: {
                    selectedColumnIndexes: [1],
                    forcedColumnTypes: undefined,
                    columnNameOverrides: { 1: 'customer_name' },
                },
            }),
        );
    });
});
