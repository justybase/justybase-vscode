import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportWizardSession } from '../import/wizard/ImportWizardSession';
import { ImportPreviewService } from '../import/wizard/ImportPreviewService';
import { ImportValidationService } from '../import/wizard/ImportValidationService';
import type { DatabaseImportWizardAdapter } from '../import/wizard/adapters/DatabaseImportWizardAdapter';
import type { ImportTargetColumn, ImportWizardSessionOptions } from '../import/wizard/ImportWizardState';

function createAdapter(execute = jest.fn(async () => ({ success: true, message: 'ok' }))): DatabaseImportWizardAdapter & {
    execute: jest.Mock;
} {
    return {
        kind: 'netezza',
        supportsAppendToExistingTable: true,
        supportsTargetColumnMapping: true,
        normalizeTargetColumnName: (name: string) => name.toUpperCase(),
        getSupportedTypeOptions: () => ['BIGINT', 'NVARCHAR(20)', 'NUMERIC(10,2)'],
        mapInferredType: (typeName: string) => typeName.toUpperCase(),
        validateTypeOverride: () => [],
        buildCreateTableSql: (input) => `CREATE TABLE ${input.targetTable} (...)`,
        buildExecutionPlan: (input) => {
            const delegate = input.importer?.getDelegate();
            return {
                mode: 'direct',
                createTableSql: delegate?.generateStandaloneCreateTableSql() ?? '',
                loadSql: delegate?.generateLoadIntoExistingTableSql(),
                warnings: [],
            };
        },
        execute,
        getExecutionMode: () => 'direct',
    };
}

const TARGET_COLUMNS: ImportTargetColumn[] = [
    { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
    { name: 'DISPLAY NAME', dataType: 'NVARCHAR(20)', nullable: true, hasDefault: false },
    { name: 'AMOUNT', dataType: 'NUMERIC(10,2)', nullable: true, hasDefault: true },
];

describe('ImportWizardSession existing-table mapping', () => {
    let tempDir: string;
    let csvPath: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-existing-'));
        csvPath = path.join(tempDir, 'source.csv');
        fs.writeFileSync(csvPath, 'ID,SOURCE_NAME,AMOUNT\n1,Alpha,12.50\n2,Beta,8.25\n');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function createSession(
        adapter: DatabaseImportWizardAdapter,
        overrides: Partial<ImportWizardSessionOptions> = {},
    ): ImportWizardSession {
        return new ImportWizardSession(
            {
                filePath: csvPath,
                targetTable: 'ADMIN.TARGET',
                connectionDetails: {
                    dbType: 'netezza',
                    host: 'localhost',
                    database: 'SYSTEM',
                    user: 'admin',
                } as never,
                previewRowCount: 2,
                validationSampleSize: 10,
                ...overrides,
            },
            adapter,
            new ImportPreviewService(),
            new ImportValidationService(),
        );
    }

    async function createMappedSession(
        adapter: DatabaseImportWizardAdapter,
        targetColumns: ImportTargetColumn[] = TARGET_COLUMNS,
    ): Promise<ImportWizardSession> {
        const session = createSession(adapter);
        const initialized = await session.initialize();
        await session.setCreateTable(false);
        await session.setTargetColumns(initialized.targetTable, targetColumns);
        return session;
    }

    it('auto-maps matching source headers and keeps unmatched sources visible but excluded', async () => {
        const session = await createMappedSession(createAdapter());
        const state = session.getState();

        expect(state.existingTable.status).toBe('ready');
        expect(state.columns.map(column => ({
            source: column.sourceName,
            target: column.targetName,
            included: column.included,
        }))).toEqual([
            { source: 'ID', target: 'ID', included: true },
            { source: 'SOURCE_NAME', target: 'SOURCE_NAME', included: false },
            { source: 'AMOUNT', target: 'AMOUNT', included: true },
        ]);
        expect(state.warnings).toContainEqual(
            expect.stringContaining('SOURCE_NAME'),
        );
        expect(state.hasValidationErrors).toBe(false);
    });

    it('maps a source column to an exact catalog name and uses target types for execution', async () => {
        const execute = jest.fn(async () => ({ success: true, message: 'ok' }));
        const session = await createMappedSession(createAdapter(execute));

        await session.mapColumnToTarget(1, 'DISPLAY NAME');
        const state = session.getState();
        expect(state.columns[1].included).toBe(true);
        expect(state.columns[1].targetName).toBe('DISPLAY NAME');
        expect(state.executionPlan.loadSql).toContain('"DISPLAY NAME"');
        expect(state.executionPlan.loadSql).toContain('NVARCHAR(20)');
        expect(state.executionPlan.loadSql).toContain('MAXERRORS 1');

        await session.executeImport();

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                columnOptions: expect.objectContaining({
                    appendToExistingTable: true,
                    targetColumnNameOverrides: {
                        0: 'ID',
                        1: 'DISPLAY NAME',
                        2: 'AMOUNT',
                    },
                    externalColumnTypes: {
                        0: 'BIGINT',
                        1: 'NVARCHAR(20)',
                        2: 'NUMERIC(10,2)',
                    },
                    maxErrors: 1,
                }),
            }),
        );
    });

    it('passes a recoverable-reject budget when skip invalid rows is selected', async () => {
        const execute = jest.fn(async () => ({ success: true, message: 'ok' }));
        const session = await createMappedSession(createAdapter(execute));

        await session.setInvalidRowMode('skip');
        await session.executeImport();

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                columnOptions: expect.objectContaining({
                    maxErrors: 2147483647,
                }),
            }),
        );
    });

    it('blocks execution when a required target column is not mapped', async () => {
        const execute = jest.fn(async () => ({ success: true, message: 'ok' }));
        const session = await createMappedSession(createAdapter(execute), [
            { name: 'REQUIRED_VALUE', dataType: 'NVARCHAR(20)', nullable: false, hasDefault: false },
        ]);

        const state = session.getState();
        expect(state.hasValidationErrors).toBe(true);
        expect(state.warnings).toContainEqual(
            expect.stringContaining('REQUIRED_VALUE is NOT NULL'),
        );
        // Skip-invalid-rows must not bypass a structural mapping error.
        await session.setInvalidRowMode('skip');
        await expect(session.executeImport()).rejects.toThrow(
            'NOT NULL and has no default',
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('validates sample values against the catalog type instead of the inferred type', async () => {
        fs.writeFileSync(csvPath, 'ID,SOURCE_NAME\nabc,Alpha\n');
        const session = await createMappedSession(createAdapter(), [
            { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
            { name: 'SOURCE_NAME', dataType: 'NVARCHAR(20)', nullable: true, hasDefault: false },
        ]);

        const state = session.getState();
        expect(state.hasValidationErrors).toBe(true);
        expect(state.issues).toContainEqual(
            expect.objectContaining({
                sourceIndex: 0,
                message: 'Expected an integer value.',
            }),
        );
    });

    it('reports empty values for a mapped NOT NULL target', async () => {
        fs.writeFileSync(csvPath, 'ID,REQUIRED_VALUE\n1,\n');
        const session = await createMappedSession(createAdapter(), [
            { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
            { name: 'REQUIRED_VALUE', dataType: 'NVARCHAR(20)', nullable: false, hasDefault: false },
        ]);

        const state = session.getState();
        expect(state.issues).toContainEqual(
            expect.objectContaining({
                sourceIndex: 1,
                message: 'Column is NOT NULL but the value is empty.',
            }),
        );
    });

    it('allows sample type errors to execute when invalid rows are skipped', async () => {
        fs.writeFileSync(csvPath, 'ID,SOURCE_NAME\nabc,Alpha\n');
        const execute = jest.fn(async () => ({ success: true, message: 'ok' }));
        const session = await createMappedSession(createAdapter(execute), [
            { name: 'ID', dataType: 'BIGINT', nullable: false, hasDefault: false },
            { name: 'SOURCE_NAME', dataType: 'NVARCHAR(20)', nullable: true, hasDefault: false },
        ]);

        expect(session.getState().hasValidationErrors).toBe(true);
        await expect(session.executeImport()).rejects.toThrow(
            'Fix validation errors before executing the import.',
        );
        expect(execute).not.toHaveBeenCalled();

        await session.setInvalidRowMode('skip');
        expect(session.getState().executionPlan.loadSql).toContain('MAXERRORS 2147483647');
        await session.executeImport();

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                columnOptions: expect.objectContaining({
                    maxErrors: 2147483647,
                    externalColumnTypes: {
                        0: 'BIGINT',
                        1: 'NVARCHAR(20)',
                    },
                }),
            }),
        );
    });

    it('renames through the catalog and ignores type edits in mapping mode', async () => {
        const session = await createMappedSession(createAdapter());

        const renamed = await session.renameColumn(1, 'display name');
        expect(renamed.columns[1].targetName).toBe('DISPLAY NAME');
        expect(renamed.columns[1].included).toBe(true);

        const typed = await session.setColumnType(0, 'NVARCHAR(1)');
        expect(typed.columns[0].selectedType).toBe('BIGINT');
    });

    it('records catalog errors and an empty catalog before recovering', async () => {
        const session = createSession(createAdapter());
        const initialized = await session.initialize();
        await session.setCreateTable(false);

        const empty = await session.setTargetColumns(initialized.targetTable, []);
        expect(empty.existingTable.status).toBe('error');
        expect(empty.existingTable.error).toContain('No columns were found');

        const failed = await session.setTargetColumns(
            initialized.targetTable,
            [],
            'metadata unavailable',
        );
        expect(failed.existingTable).toEqual({
            status: 'error',
            columns: [],
            error: 'metadata unavailable',
        });

        const recovered = await session.setTargetColumns(
            initialized.targetTable,
            TARGET_COLUMNS,
        );
        expect(recovered.existingTable.status).toBe('ready');
        expect(recovered.existingTable.columns).toHaveLength(3);
    });

    it('resets the target catalog when the destination table changes', async () => {
        const session = await createMappedSession(createAdapter());
        expect(session.getState().existingTable.status).toBe('ready');

        const changed = await session.setTargetTableName('OTHER');
        expect(changed.existingTable).toEqual({ status: 'idle', columns: [] });
    });

    it('auto-maps again when switching back to existing-table mode', async () => {
        const session = createSession(createAdapter());
        const initialized = await session.initialize();
        await session.setCreateTable(false);
        await session.setTargetColumns(initialized.targetTable, TARGET_COLUMNS);

        await session.setCreateTable(true);
        const reopened = await session.setCreateTable(false);
        expect(reopened.existingTable.status).toBe('ready');
        expect(reopened.columns.filter((column) => column.included).length).toBeGreaterThan(0);
    });

    it('unmaps a source and switches back to abort mode', async () => {
        const session = await createMappedSession(createAdapter());

        const unmapped = await session.mapColumnToTarget(1, undefined);
        expect(unmapped.columns[1].included).toBe(false);

        await session.setInvalidRowMode('skip');
        const aborted = await session.setInvalidRowMode('abort');
        expect(aborted.invalidRowMode).toBe('abort');
    });

    it('ignores a catalog result for a target table that changed during the lookup', async () => {
        const session = createSession(createAdapter());
        const initialized = await session.initialize();
        await session.setCreateTable(false);
        await session.beginTargetColumnLoad(initialized.targetTable);

        const state = await session.setTargetColumns('ADMIN.OTHER', TARGET_COLUMNS);
        expect(state.existingTable.status).toBe('loading');
        expect(state.existingTable.columns).toEqual([]);
    });
});
