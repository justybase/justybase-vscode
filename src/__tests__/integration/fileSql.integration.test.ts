import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from '@jest/globals';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { fileDialect } from '../../../extensions/duckdb/src/fileDialect';
import { loadDuckDb } from '../../../extensions/duckdb/src/duckdbConnection';
import { listXlsxSheetNames } from '../../../extensions/duckdb/src/xlsxSheets';
import { listXlsbSheetNames } from '../../../extensions/duckdb/src/xlsbConversion';
import { convertAccessTablesToCsvs, listAccessTableNames } from '../../../extensions/duckdb/src/accessConversion';
import { duckdbMetadataProvider } from '../../../extensions/duckdb/src/duckdbSchemaProvider';
import {
    buildSaveEditsSql,
    editableTableName,
    sanitizeViewName,
    serializeFileWorkspace
} from '../../../extensions/duckdb/src/fileSqlSetup';
import type { DatabaseDataReader } from '../../contracts/database';

const extensionRequire = createRequire(path.join(process.cwd(), 'extensions', 'duckdb', 'package.json'));

function hasDuckDbRuntime(): boolean {
    try {
        extensionRequire.resolve('@duckdb/node-api');
        return true;
    } catch {
        return false;
    }
}

interface XlsbSheetFixture {
    name: string;
    headers: string[];
    rows: unknown[][];
}

/** Write a real XLSB workbook through @justybase/spreadsheet-tasks XlsbWriter. */
async function writeXlsbFile(filePath: string, sheets: XlsbSheetFixture[]): Promise<void> {
    const { XlsbWriter } = extensionRequire('@justybase/spreadsheet-tasks') as {
        XlsbWriter: new (filePath: string) => {
            startSheet(sheetName: string, columnCount: number, headers?: string[]): void;
            writeRow(row: unknown[]): void;
            endSheet(): void;
            finalize(): Promise<void>;
        };
    };
    const writer = new XlsbWriter(filePath);
    for (const sheet of sheets) {
        writer.startSheet(sheet.name, sheet.headers.length, sheet.headers);
        for (const row of sheet.rows) {
            writer.writeRow(row);
        }
        writer.endSheet();
    }
    await writer.finalize();
}

async function readRows(reader: DatabaseDataReader): Promise<unknown[][]> {
    const rows: unknown[][] = [];
    try {
        while (await reader.read()) {
            const values: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index += 1) {
                values.push(reader.getValue(index));
            }
            rows.push(values);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

/** Stringify cells for deterministic assertions (Date → ISO, numbers → text). */
function stringifyCells(rows: readonly (readonly unknown[])[]): string[][] {
    return rows.map(row => row.map(value => (value instanceof Date ? value.toISOString() : String(value))));
}

/** Copy a committed Access fixture into the test temp dir (fixtures are read-only). */
function copyAccessFixture(tempDir: string, fixtureName: string, destinationName: string): string {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'access', fixtureName);
    const targetPath = path.join(tempDir, destinationName);
    fs.copyFileSync(fixturePath, targetPath);
    return targetPath;
}

const duckdbRuntimeAvailable = hasDuckDbRuntime();
const describeIfInstalled = duckdbRuntimeAvailable ? describe : describe.skip;

if (duckdbRuntimeAvailable) {
    registerDatabaseDialect(fileDialect);
}

/** Write a data file (parquet/xlsx/avro) through a raw DuckDB instance. */
async function writeDataFile(
    filePath: string,
    format: 'parquet' | 'xlsx' | 'avro',
    headers: string[],
    rows: unknown[][],
): Promise<void> {
    const duckdb = await loadDuckDb();
    const instance = await duckdb.DuckDBInstance.create(undefined);
    const connection = await instance.connect();
    try {
        if (format === 'xlsx') {
            await connection.run('INSTALL excel');
            await connection.run('LOAD excel');
            const literal = (value: unknown): string => {
                if (value === null) {
                    return 'NULL';
                }
                return `'${String(value).replace(/'/g, "''")}'::VARCHAR`;
            };
            const headerSelect = `SELECT ${headers.map(header => literal(header)).join(', ')}`;
            const dataSelects = rows.map(row => `SELECT ${row.map(literal).join(', ')}`);
            await connection.run(
                `COPY (${[headerSelect, ...dataSelects].join(' UNION ALL ')}) TO '${filePath.split(path.sep).join('/')}' (FORMAT XLSX)`
            );
            return;
        }

        const literal = (value: unknown): string => {
            if (value === null) {
                return 'NULL';
            }
            if (typeof value === 'number' || typeof value === 'bigint') {
                return String(value);
            }
            if (typeof value === 'boolean') {
                return value ? 'TRUE' : 'FALSE';
            }
            return `'${String(value).replace(/'/g, "''")}'`;
        };
        const selects = rows.map((row, rowIndex) => {
            const columns = row.map((value, columnIndex) => {
                const literalValue = literal(value);
                return rowIndex === 0 ? `${literalValue} AS ${JSON.stringify(headers[columnIndex]).replace(/"/g, '')}` : literalValue;
            });
            return `SELECT ${columns.join(', ')}`;
        });
        const query = `COPY (${selects.join(' UNION ALL ')}) TO '${filePath.split(path.sep).join('/')}' (FORMAT ${format.toUpperCase()})`;
        await connection.run(query);
    } finally {
        connection.disconnectSync();
        instance.closeSync();
    }
}

describeIfInstalled('file dialect integration (xlsx/csv/parquet/avro via DuckDB)', () => {
    const tempDir = path.join(
        os.tmpdir(),
        `file-sql-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

    it('queries a CSV file through the FileDuckDbConnection', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const csvPath = path.join(tempDir, 'sales.csv');
        fs.writeFileSync(csvPath, 'region,amount\nEU,100\nUS,200\nEU,150\n');

        const connection = fileDialect.createConnection({
            
            host: 'local',
            database: csvPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(await connection.createCommand('SELECT * FROM "sales" ORDER BY amount').executeReader());
            expect(rows).toEqual([['EU', 100n], ['EU', 150n], ['US', 200n]]);

            const aggregated = await readRows(
                await connection.createCommand('SELECT region, SUM(amount) AS total FROM "sales" GROUP BY region ORDER BY region').executeReader(),
            );
            expect(aggregated).toEqual([['EU', 250n], ['US', 200n]]);
        } finally {
            await connection.close();
        }
    });

    it('joins multiple CSV files through a read-only File SQL workspace', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const customersPath = path.join(tempDir, 'customers-join.csv');
        const ordersPath = path.join(tempDir, 'orders-join.csv');
        fs.writeFileSync(customersPath, 'id,name\n1,Alice\n2,Bob\n');
        fs.writeFileSync(ordersPath, 'customer_id,total\n1,100\n2,250\n');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: customersPath,
            user: 'file',
            options: { fileWorkspace: serializeFileWorkspace([customersPath, ordersPath]) },
        });

        try {
            await connection.connect();
            const customersView = customersPath.split(path.sep).join('/');
            const ordersView = ordersPath.split(path.sep).join('/');
            const rows = await readRows(
                await connection.createCommand(
                    `SELECT c.name, o.total FROM "${customersView}" c JOIN "${ordersView}" o ON c.id = o.customer_id ORDER BY c.id`,
                ).executeReader(),
            );
            expect(rows).toEqual([['Alice', 100n], ['Bob', 250n]]);
        } finally {
            await connection.close();
        }
    });

    it('discovers workspace views with the Visual Query Builder metadata filters', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const firstPath = path.join(tempDir, 'vqb-first.csv');
        const secondPath = path.join(tempDir, 'vqb-second.csv');
        fs.writeFileSync(firstPath, 'id,name\n1,Alice\n');
        fs.writeFileSync(secondPath, 'id,total\n1,100\n');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: firstPath,
            user: 'file',
            options: { fileWorkspace: serializeFileWorkspace([firstPath, secondPath]) },
        });

        try {
            await connection.connect();
            const schemas = await readRows(
                await connection.createCommand(duckdbMetadataProvider.buildListSchemasQuery('')).executeReader(),
            );
            const views = await readRows(
                await connection.createCommand(duckdbMetadataProvider.buildListViewsQuery('', 'main')).executeReader(),
            );
            const columns = await readRows(
                await connection.createCommand(
                    duckdbMetadataProvider.buildColumnsWithKeysQuery('', { schema: 'main', objTypes: ['TABLE', 'VIEW'] }),
                ).executeReader(),
            );

            expect(schemas).toEqual([['main']]);
            expect(views.map(row => String(row[0]))).toEqual(expect.arrayContaining([firstPath, secondPath]));
            expect(columns.map(row => String(row[2]))).toEqual(
                expect.arrayContaining([firstPath, secondPath]),
            );
        } finally {
            await connection.close();
        }
    });

    it('lists the file as a view in metadata', async () => {
        const csvPath = path.join(tempDir, 'customers.csv');
        fs.writeFileSync(csvPath, 'id,name\n1,Alice\n2,Bob\n');

        const connection = fileDialect.createConnection({
            
            host: 'local',
            database: csvPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name").executeReader(),
            );
            expect(rows.some(row => String(row[0]) === 'customers')).toBe(true);
        } finally {
            await connection.close();
        }
    });

    it('supports INSERT/UPDATE on the editable copy and writes changes back', async () => {
        const csvPath = path.join(tempDir, 'editable.csv');
        fs.writeFileSync(csvPath, 'region,amount\nEU,100\nUS,200\n');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: csvPath,
            user: 'file',
            options: { editable: true },
        });

        const editedPath = path.join(tempDir, 'editable_edited.csv');
        try {
            await connection.connect();

            await connection.createCommand(`INSERT INTO "editable_edit" VALUES ('APAC', 300)`).execute();
            await connection.createCommand(`UPDATE "editable_edit" SET amount = 250 WHERE region = 'US'`).execute();
            const rows = await readRows(
                await connection.createCommand('SELECT region, amount FROM "editable_edit" ORDER BY region').executeReader(),
            );
            expect(rows).toEqual([['APAC', 300n], ['EU', 100n], ['US', 250n]]);

            // Save back to a fresh CSV file via the same COPY SQL the command uses.
            await connection.createCommand(
                `COPY (SELECT * FROM "editable_edit") TO '${editedPath}' (FORMAT CSV, HEADER)`,
            ).execute();
        } finally {
            await connection.close();
        }

        const saved = fs.readFileSync(editedPath, 'utf8');
        expect(saved).toContain('APAC,300');
        expect(saved).toContain('US,250');
        const lines = saved.split('\n').filter(line => line.trim().length > 0);
        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe('region,amount');
    });

    it('queries a parquet file through the FileDuckDbConnection', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const parquetPath = path.join(tempDir, 'sales.parquet');
        await writeDataFile(
            parquetPath,
            'parquet',
            ['region', 'amount'],
            [['EU', 100], ['US', 200], ['EU', 150]],
        );

        const connection = fileDialect.createConnection({
            host: 'local',
            database: parquetPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand('SELECT region, amount FROM "sales" ORDER BY amount').executeReader(),
            );
            expect(rows).toEqual([['EU', 100], ['EU', 150], ['US', 200]]);
        } finally {
            await connection.close();
        }
    });

    it('queries an xlsx workbook and exposes discovered sheets as views', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const xlsxPath = path.join(tempDir, 'book.xlsx');
        await writeDataFile(
            xlsxPath,
            'xlsx',
            ['id', 'title'],
            [['1', 'Alice in Wonderland'], ['2', 'Dune']],
        );

        expect(listXlsxSheetNames(xlsxPath)).toContain('Sheet1');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: xlsxPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand('SELECT id, title FROM "book" ORDER BY id').executeReader(),
            );
            expect(rows).toEqual([['1', 'Alice in Wonderland'], ['2', 'Dune']]);
        } finally {
            await connection.close();
        }
    });

    it('queries an xlsb workbook through conversion and exposes discovered sheets as views', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const xlsbPath = path.join(tempDir, 'book.xlsb');
        await writeXlsbFile(xlsbPath, [
            { name: 'Orders', headers: ['id', 'title'], rows: [[1, 'Alice in Wonderland'], [2, 'Dune']] },
            { name: 'Returns', headers: ['id', 'reason'], rows: [[1, 'damaged']] },
        ]);

        expect(await listXlsbSheetNames(xlsbPath)).toEqual(['Orders', 'Returns']);

        const connection = fileDialect.createConnection({
            host: 'local',
            database: xlsbPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand('SELECT id, title FROM "book" ORDER BY id').executeReader(),
            );
            expect(rows).toEqual([[1n, 'Alice in Wonderland'], [2n, 'Dune']]);

            const perSheet = await readRows(
                await connection.createCommand('SELECT id, reason FROM "book__Returns" ORDER BY id').executeReader(),
            );
            expect(perSheet).toEqual([[1n, 'damaged']]);
        } finally {
            await connection.close();
        }
    });

    it('joins an xlsb sheet with a csv file in a read-only File SQL workspace', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const xlsbPath = path.join(tempDir, 'workspace.xlsb');
        const csvPath = path.join(tempDir, 'regions.csv');
        await writeXlsbFile(xlsbPath, [
            { name: 'Sales', headers: ['region', 'amount'], rows: [['EU', 100], ['US', 200]] },
        ]);
        fs.writeFileSync(csvPath, 'region,name\nEU,Europe\nUS,United States\n');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: csvPath,
            user: 'file',
            options: { fileWorkspace: serializeFileWorkspace([xlsbPath, csvPath]) },
        });

        try {
            await connection.connect();
            const xlsbView = xlsbPath.split(path.sep).join('/');
            const csvView = csvPath.split(path.sep).join('/');
            const rows = await readRows(
                await connection.createCommand(
                    `SELECT s.region, n.name, s.amount FROM "${xlsbView}" s JOIN "${csvView}" n ON s.region = n.region ORDER BY s.amount`,
                ).executeReader(),
            );
            expect(rows).toEqual([['EU', 'Europe', 100n], ['US', 'United States', 200n]]);
        } finally {
            await connection.close();
        }
    });

    it('queries an Access database through conversion and exposes tables as views', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const accessPath = copyAccessFixture(tempDir, 'sample2007.accdb', 'sample2007.accdb');

        expect(await listAccessTableNames(accessPath)).toEqual(['t_people']);

        const connection = fileDialect.createConnection({
            host: 'local',
            database: accessPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const views = await readRows(
                await connection.createCommand(duckdbMetadataProvider.buildListViewsQuery('', 'main')).executeReader(),
            );
            const rows = await readRows(
                await connection.createCommand(
                    'SELECT name, age, active FROM "sample2007__t_people" ORDER BY id',
                ).executeReader(),
            );
            expect(stringifyCells(rows)).toEqual([
                ['Anna Kowalska', '34', 'true'],
                ['Jan Nowak', '41', 'true'],
                ['Ewa Wiśniewska', '29', 'false'],
            ]);
            expect(views.map(row => String(row[0]))).toEqual(
                expect.arrayContaining(['sample2007__t_people', 'sample2007']),
            );
        } finally {
            await connection.close();
        }
    });

    it('keeps converted Access CSV paths distinct for separate source files', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const firstPath = copyAccessFixture(tempDir, 'sample2007.accdb', 'collision-first.accdb');
        const secondPath = copyAccessFixture(tempDir, 'sample2007.accdb', 'collision-second.accdb');
        const outputDir = path.join(tempDir, 'access-csvs');

        const first = await convertAccessTablesToCsvs(firstPath, outputDir);
        const second = await convertAccessTablesToCsvs(secondPath, outputDir);
        const firstCsvPath = first.tableCsvPaths.get('t_people');
        const secondCsvPath = second.tableCsvPaths.get('t_people');

        expect(firstCsvPath).toBeDefined();
        expect(secondCsvPath).toBeDefined();
        expect(firstCsvPath).not.toBe(secondCsvPath);
        expect(fs.existsSync(firstCsvPath as string)).toBe(true);
        expect(fs.existsSync(secondCsvPath as string)).toBe(true);
    });

    it('joins Access tables with a csv file in a read-only File SQL workspace', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const accessPath = copyAccessFixture(tempDir, 'sample2007.accdb', 'workspace.accdb');
        const csvPath = path.join(tempDir, 'people.csv');
        fs.writeFileSync(csvPath, 'name,city\nAnna Kowalska,Warsaw\nJan Nowak,Krakow\n');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: csvPath,
            user: 'file',
            options: { fileWorkspace: serializeFileWorkspace([accessPath, csvPath]) },
        });

        try {
            await connection.connect();
            const accessView = `${accessPath.split(path.sep).join('/')}#table=t_people`;
            const csvView = csvPath.split(path.sep).join('/');
            const views = await readRows(
                await connection.createCommand(duckdbMetadataProvider.buildListViewsQuery('', 'main')).executeReader(),
            );
            const rows = await readRows(
                await connection.createCommand(
                    `SELECT p.name, c.city, p.age FROM "${accessView}" p JOIN "${csvView}" c ON p.name = c.name ORDER BY p.age`,
                ).executeReader(),
            );
            expect(stringifyCells(rows)).toEqual([
                ['Anna Kowalska', 'Warsaw', '34'],
                ['Jan Nowak', 'Krakow', '41'],
            ]);
            expect(views.map(row => String(row[0]))).toEqual(
                expect.arrayContaining([accessView, csvView]),
            );
        } finally {
            await connection.close();
        }
    });

    it('ignores a stale editable option for Access files and remains read-only', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const accessPath = copyAccessFixture(tempDir, 'sample2007.accdb', 'readonly.accdb');

        const connection = fileDialect.createConnection({
            host: 'local',
            database: accessPath,
            user: 'file',
            options: { editable: true },
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand('SELECT COUNT(*) FROM "readonly__t_people"').executeReader(),
            );
            expect(rows).toEqual([[3n]]);
        } finally {
            await connection.close();
        }
    });

    it('supports INSERT/UPDATE on an xlsb editable copy and writes back in place via XlsbUpdater', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const xlsbPath = path.join(tempDir, 'editable.xlsb');
        await writeXlsbFile(xlsbPath, [
            { name: 'Data', headers: ['region', 'amount'], rows: [['EU', 100], ['US', 200]] },
        ]);

        const connection = fileDialect.createConnection({
            host: 'local',
            database: xlsbPath,
            user: 'file',
            options: { editable: true, sheet: 'Data' },
        });

        try {
            await connection.connect();

            await connection.createCommand(`INSERT INTO "editable_edit" VALUES ('APAC', 300)`).execute();
            await connection.createCommand(`UPDATE "editable_edit" SET amount = 250 WHERE region = 'US'`).execute();
            const rows = await readRows(
                await connection.createCommand('SELECT region, amount FROM "editable_edit" ORDER BY amount').executeReader(),
            );
            expect(rows).toEqual([['EU', 100n], ['US', 250n], ['APAC', 300n]]);

            // Client-side write-back — the same flow the Save File Edits command uses:
            // fetch the editable table rows from DuckDB and rewrite the sheet in place.
            const reader = await connection.createCommand('SELECT * FROM "editable_edit"').executeReader();
            const columns: string[] = [];
            for (let index = 0; index < reader.fieldCount; index += 1) {
                columns.push(reader.getName(index));
            }
            const dataRows: unknown[][] = [];
            while (await reader.read()) {
                const values: unknown[] = [];
                for (let index = 0; index < reader.fieldCount; index += 1) {
                    values.push(reader.getValue(index));
                }
                dataRows.push(values);
            }
            await reader.close();

            const { XlsbUpdater } = extensionRequire('@justybase/spreadsheet-tasks') as {
                XlsbUpdater: new (filePath: string) => {
                    getSheetNames(): string[];
                    replaceSheetData(
                        sheetName: string,
                        rows: Array<Array<string | number | boolean | Date | null>>,
                        options?: { headers?: string[]; styleFallback?: 'inherit' | 'general' },
                    ): void;
                    save(outputPath?: string): void;
                };
            };
            const updater = new XlsbUpdater(xlsbPath);
            expect(updater.getSheetNames()).toEqual(['Data']);
            updater.replaceSheetData(
                'Data',
                dataRows.map(row => row.map(value => (value === undefined ? null : (value as string | number | boolean | Date | null)))),
                { headers: columns },
            );
            updater.save();
        } finally {
            await connection.close();
        }

        const reloaded = fileDialect.createConnection({
            host: 'local',
            database: xlsbPath,
            user: 'file',
        });
        try {
            await reloaded.connect();
            const rows = await readRows(
                await reloaded.createCommand('SELECT region, amount FROM "editable" ORDER BY amount').executeReader(),
            );
            expect(rows).toEqual([['EU', 100n], ['US', 250n], ['APAC', 300n]]);
        } finally {
            await reloaded.close();
        }
    });

    it('queries an avro file through the FileDuckDbConnection', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const avroPath = path.join(tempDir, 'events.avro');
        await writeDataFile(
            avroPath,
            'avro',
            ['event_id', 'event_name'],
            [[1, 'login'], [2, 'logout']],
        );

        const connection = fileDialect.createConnection({
            host: 'local',
            database: avroPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const rows = await readRows(
                await connection.createCommand('SELECT event_id, event_name FROM "events" ORDER BY event_id').executeReader(),
            );
            expect(rows).toEqual([[1, 'login'], [2, 'logout']]);
        } finally {
            await connection.close();
        }
    });

    it('supports DELETE on the editable copy and saves edits back to a parquet file', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const parquetPath = path.join(tempDir, 'editable.parquet');
        await writeDataFile(
            parquetPath,
            'parquet',
            ['region', 'amount'],
            [['EU', 100], ['US', 200], ['APAC', 300]],
        );

        const connection = fileDialect.createConnection({
            host: 'local',
            database: parquetPath,
            user: 'file',
            options: { editable: true },
        });

        try {
            await connection.connect();

            await connection.createCommand(`DELETE FROM "${editableTableName(parquetPath)}" WHERE region = 'US'`).execute();
            const rows = await readRows(
                await connection.createCommand(`SELECT region, amount FROM "${editableTableName(parquetPath)}" ORDER BY region`).executeReader(),
            );
            expect(rows).toEqual([['APAC', 300], ['EU', 100]]);

            const saveSql = buildSaveEditsSql(parquetPath, 'parquet');
            expect(saveSql.writesToNewFile).toBe(false);
            await connection.createCommand(saveSql.sql).execute();
        } finally {
            await connection.close();
        }

        const reloaded = fileDialect.createConnection({
            host: 'local',
            database: parquetPath,
            user: 'file',
        });
        try {
            await reloaded.connect();
            const rows = await readRows(
                await reloaded.createCommand('SELECT region, amount FROM "editable" ORDER BY region').executeReader(),
            );
            expect(rows).toEqual([['APAC', 300], ['EU', 100]]);
        } finally {
            await reloaded.close();
        }
    });

    it('exposes file-backed view columns through the shared metadata provider', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const parquetPath = path.join(tempDir, 'catalog.parquet');
        await writeDataFile(
            parquetPath,
            'parquet',
            ['sku', 'price'],
            [['A1', 9.99], ['B2', 19.99]],
        );

        const connection = fileDialect.createConnection({
            host: 'local',
            database: parquetPath,
            user: 'file',
        });

        try {
            await connection.connect();
            const viewName = sanitizeViewName(parquetPath);
            const columnRows = await readRows(
                await connection
                    .createCommand(duckdbMetadataProvider.buildColumnsWithKeysQuery('memory', { tableName: viewName }))
                    .executeReader(),
            );
            expect(columnRows.map(row => String(row[3]))).toEqual(expect.arrayContaining(['sku', 'price']));
        } finally {
            await connection.close();
        }
    });

    it('cleans up the file conversion temp directory on close', async () => {
        fs.mkdirSync(tempDir, { recursive: true });
        const xlsbPath = path.join(tempDir, 'tempdir-check.xlsb');
        await writeXlsbFile(xlsbPath, [
            { name: 'Sheet1', headers: ['id'], rows: [[1]] },
        ]);
        const tempPrefix = 'justybase-file-sql-';
        const listTempDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(tempPrefix));
        const beforeConnect = listTempDirs();

        const connection = fileDialect.createConnection({
            host: 'local',
            database: xlsbPath,
            user: 'file',
        });

        try {
            await connection.connect();
            await readRows(await connection.createCommand('SELECT id FROM "tempdir_check"').executeReader());
            const duringConnect = listTempDirs();
            expect(duringConnect.length).toBeGreaterThan(beforeConnect.length);
        } finally {
            await connection.close();
        }

        expect(listTempDirs()).toEqual(beforeConnect);
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
