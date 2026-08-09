import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { describe, expect, it } from '@jest/globals';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { fileDialect } from '../../../extensions/duckdb/src/fileDialect';
import { serializeFileWorkspace } from '../../../extensions/duckdb/src/fileSqlSetup';
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

const duckdbRuntimeAvailable = hasDuckDbRuntime();
const describeIfInstalled = duckdbRuntimeAvailable ? describe : describe.skip;

if (duckdbRuntimeAvailable) {
    registerDatabaseDialect(fileDialect);
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

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
