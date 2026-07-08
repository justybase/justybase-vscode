import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sqliteAdvancedFeatures } from '../../../dialects/sqlite/advancedFeatures';
import { SqliteConnection } from '../../../dialects/sqlite/runtime';
import type { ConnectionDetails } from '../../../types';

function createTempSqlitePath(): string {
    return path.join(os.tmpdir(), `jb-sqlite-ddl-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

async function createDatabaseWithSql(
    statements: string[]
): Promise<{ connectionDetails: ConnectionDetails; dispose: () => Promise<void> }> {
    const databasePath = createTempSqlitePath();
    const connection = new SqliteConnection({
        host: 'localhost',
        database: databasePath,
        user: 'sqlite-test'
    });
    await connection.connect();

    for (const statement of statements) {
        await connection.createCommand(statement).execute();
    }

    await connection.close();

    return {
        connectionDetails: {
            host: 'localhost',
            database: databasePath,
            user: 'sqlite-test',
            dbType: 'sqlite'
        },
        dispose: async () => {
            if (fs.existsSync(databasePath)) {
                fs.unlinkSync(databasePath);
            }
        }
    };
}

describe('sqliteAdvancedFeatures ddl', () => {
    it('reads table DDL directly from sqlite_master', async () => {
        const fixture = await createDatabaseWithSql([
            'CREATE TABLE main.sales (ID INTEGER NOT NULL, PRIMARY KEY (ID));'
        ]);

        try {
            const result = await sqliteAdvancedFeatures.ddl!.generateDDL(
                fixture.connectionDetails,
                'main',
                '',
                'sales',
                'TABLE'
            );

            expect(result.success).toBe(true);
            expect(result.ddlCode).toContain('CREATE TABLE sales');
            expect(result.note).toContain('sqlite_master');
        } finally {
            await fixture.dispose();
        }
    });

    it('exports stored SQLite DDL for batch export', async () => {
        const fixture = await createDatabaseWithSql([
            'CREATE TABLE main.sales (ID INTEGER PRIMARY KEY, SKU TEXT NOT NULL);',
            'CREATE INDEX main.sales_sku_idx ON sales (SKU);',
            'CREATE VIEW main.sales_view AS SELECT ID, SKU FROM sales;',
            `CREATE TRIGGER main.sales_insert_guard
                BEFORE INSERT ON sales
                WHEN NEW.SKU IS NULL
                BEGIN
                    SELECT RAISE(ABORT, 'SKU required');
                END;`
        ]);

        try {
            const result = await sqliteAdvancedFeatures.ddl!.generateBatchDDL({
                connectionDetails: fixture.connectionDetails,
                database: 'main'
            });

            expect(result.success).toBe(true);
            expect(result.objectCount).toBeGreaterThanOrEqual(4);
            expect(result.ddlCode).toContain('CREATE TABLE sales');
            expect(result.ddlCode).toContain('CREATE INDEX sales_sku_idx');
            expect(result.ddlCode).toContain('CREATE VIEW sales_view');
            expect(result.ddlCode).toContain('CREATE TRIGGER sales_insert_guard');
        } finally {
            await fixture.dispose();
        }
    });
});
