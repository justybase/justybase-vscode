import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTabularDataImporter } from '../import/tabularDataImporter';

describe('TabularDataImporter existing-table options', () => {
    let tempDir: string;
    let csvPath: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabular-importer-'));
        csvPath = path.join(tempDir, 'source.csv');
        fs.writeFileSync(csvPath, 'source_id,source_name\n1,Alpha\n');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('keeps exact target names, external types, and maxErrors in the delegate SQL', async () => {
        const importer = createTabularDataImporter(csvPath, 'ADMIN.TARGET', { kind: 'netezza' });
        await importer.analyzeDataTypes();
        importer.applyColumnOptions({
            selectedColumnIndexes: [0, 1],
            targetColumnNameOverrides: { 0: 'Id', 1: 'Display Name' },
            externalColumnTypes: { 0: 'BIGINT', 1: 'NVARCHAR(20)' },
            maxErrors: 9,
        });

        expect(importer.getColumnMappings().map((mapping) => mapping.targetColumn))
            .toEqual(['Id', 'Display Name']);

        const sql = importer.getDelegate().generateLoadIntoExistingTableSql();
        expect(sql).toContain('("Id", "Display Name")');
        expect(sql).toContain('"Display Name" NVARCHAR(20)');
        expect(sql).toContain('MAXERRORS 9');
    });

    it('keeps the delegate in sync when target options change between previews', async () => {
        const importer = createTabularDataImporter(csvPath, 'ADMIN.TARGET', { kind: 'netezza' });
        await importer.analyzeDataTypes();

        importer.applyColumnOptions({
            selectedColumnIndexes: [0],
            targetColumnNameOverrides: { 0: 'Id' },
            externalColumnTypes: { 0: 'BIGINT' },
        });
        expect(importer.getDelegate().generateLoadIntoExistingTableSql())
            .toContain('("Id")');

        importer.applyColumnOptions({
            selectedColumnIndexes: [1],
            targetColumnNameOverrides: { 1: 'Display Name' },
            externalColumnTypes: { 1: 'NVARCHAR(20)' },
        });
        const sql = importer.getDelegate().generateLoadIntoExistingTableSql();
        expect(sql).toContain('("Display Name")');
        expect(sql).not.toContain('"Id"');
    });
});
