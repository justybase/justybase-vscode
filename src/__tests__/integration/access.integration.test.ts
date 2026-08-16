import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseConnectionConfig } from '../../contracts/database';
import { AccessConnection } from '../../../extensions/access/src/accessConnection';
import { AccessFileSession } from '../../../packages/access-file/src';

const configuredFile = process.env.ACCESS_TEST_FILE?.trim();
const hasAccessFixture = Boolean(configuredFile);

async function readRows(connection: AccessConnection, sql: string): Promise<unknown[][]> {
    const reader = await connection.createCommand(sql).executeReader();
    const rows: unknown[][] = [];
    try {
        while (await reader.read()) {
            rows.push(Array.from({ length: reader.fieldCount }, (_, index) => reader.getValue(index)));
        }
    } finally {
        await reader.close();
    }
    return rows;
}

function createConfig(database: string, readOnly: boolean): DatabaseConnectionConfig {
    return {
        host: '',
        database,
        user: '',
        password: process.env.ACCESS_TEST_PASSWORD,
        options: { readOnly },
    };
}

describe('native Microsoft Access integration', () => {
    const test = hasAccessFixture ? it : it.skip;

    test('opens MDB/ACCDB, exposes metadata, and executes SQL in the DuckDB mirror', async () => {
        const session = await AccessFileSession.open({
            filePath: configuredFile as string,
            password: process.env.ACCESS_TEST_PASSWORD,
        });
        const tables = session.listTables();
        expect(tables.length).toBeGreaterThan(0);

        const connection = new AccessConnection(createConfig(configuredFile as string, true));
        await connection.connect();
        try {
            const rows = await readRows(connection, 'SELECT 1 AS native_access_smoke');
            expect(rows).toEqual([[1]]);

            const metadata = await readRows(connection, 'SELECT * FROM _access_metadata.tables');
            expect(metadata.length).toBe(tables.length);

            const sampleTable = tables.find(table => table.rowCount > 0) ?? tables[0];
            const sampleColumn = sampleTable?.columns[0];
            if (sampleTable && sampleColumn && sampleTable.rowCount > 0) {
                const tableName = sampleTable.name.replace(/]/g, ']]');
                const columnName = sampleColumn.name.replace(/]/g, ']]');
                const bracketed = await readRows(
                    connection,
                    `SELECT [${columnName}] AS [review_value] FROM [${tableName}] LIMIT 1`,
                );
                expect(bracketed).toHaveLength(1);

                const typedColumn = sampleTable.columns.find(column =>
                    column.accessType === 'datetime' || column.accessType === 'binary' || column.accessType === 'ole');
                if (typedColumn) {
                    const typedName = typedColumn.name.replace(/]/g, ']]');
                    const typedRows = await readRows(
                        connection,
                        `SELECT [${typedName}] FROM [${tableName}] WHERE [${typedName}] IS NOT NULL LIMIT 1`,
                    );
                    expect(typedRows).toHaveLength(1);
                    const typedValue = typedRows[0]?.[0];
                    if (typedColumn.accessType === 'datetime') {
                        expect(typedValue).toBeInstanceOf(Date);
                    } else {
                        expect(typedValue).toBeInstanceOf(Uint8Array);
                    }
                }
            }
            expect(await readRows(connection, "SELECT 'CURRENCY' AS [MEMO]")).toEqual([['CURRENCY']]);

            if (sampleTable) {
                const columnMetadata = await readRows(
                    connection,
                    `SELECT * FROM _access_metadata.columns WHERE TABLE = '${sampleTable.name.replace(/'/g, "''")}'`,
                );
                expect(columnMetadata).toHaveLength(sampleTable.columns.length);
                for (const column of sampleTable.columns) {
                    const row = columnMetadata.find(candidate => candidate[3] === column.name);
                    expect(row?.[6]).toBe(column.isPrimaryKey ? 1 : 0);
                }

                const detailed = await readRows(
                    connection,
                    `SELECT * FROM _access_metadata.table_columns WHERE TABLE = '${sampleTable.name.replace(/'/g, "''")}'`,
                );
                expect(detailed).toHaveLength(sampleTable.columns.length);
                expect(detailed[0]).toHaveLength(11);
                for (const column of sampleTable.columns) {
                    const row = detailed.find(candidate => candidate[0] === column.name);
                    expect(row?.[9]).toBe(column.autoLong || column.autoUuid ? 1 : 0);
                    expect(row?.[10]).toBe(column.accessType === 'long' && !column.fixedLength && column.size === 39 ? 1 : 0);
                }
            }

            for (const query of session.listQueryDefinitions()) {
                if (query.type !== 'select' || query.hasParameters || !query.sql) {
                    continue;
                }
                const queryName = query.name.replace(/]/g, ']]');
                await expect(readRows(connection, `SELECT * FROM [${queryName}]`)).resolves.toBeDefined();
            }
            if (session.listQueryDefinitions().some(query => query.type === 'select')) {
                const sourceRows = await readRows(
                    connection,
                    "SELECT * FROM _access_metadata.view_source_search WHERE PATTERN = '%SELECT%' AND SERVER_SIDE = 1",
                );
                expect(sourceRows.length).toBeGreaterThan(0);
            }
        } finally {
            await connection.close();
            await session.close();
        }
    });

    test('writes through a staged file replacement when explicitly enabled', async () => {
        if (process.env.ACCESS_TEST_WRITE !== '1') {
            return;
        }

        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-native-'));
        const temporaryFile = path.join(temporaryDirectory, path.basename(configuredFile as string));
        await fs.copyFile(configuredFile as string, temporaryFile);

        const sql = process.env.ACCESS_TEST_WRITE_SQL?.trim();
        if (!sql) {
            throw new Error('ACCESS_TEST_WRITE_SQL is required when ACCESS_TEST_WRITE=1.');
        }

        const connection = new AccessConnection(createConfig(temporaryFile, false));
        await connection.connect();
        try {
            const expectedError = process.env.ACCESS_TEST_EXPECT_WRITE_ERROR?.trim();
            if (expectedError) {
                await expect(connection.createCommand(sql).execute()).rejects.toThrow(new RegExp(expectedError, 'i'));
            } else {
                await connection.createCommand(sql).execute();
            }
        } finally {
            await connection.close();
        }

        const reopened = await AccessFileSession.open({ filePath: temporaryFile });
        try {
            expect(reopened.listTables().length).toBeGreaterThan(0);
            const verifyTable = process.env.ACCESS_TEST_VERIFY_TABLE?.trim();
            const expectedRows = Number(process.env.ACCESS_TEST_EXPECT_ROWS);
            if (verifyTable && Number.isInteger(expectedRows) && expectedRows >= 0) {
                expect((await reopened.readTable(verifyTable)).rows).toHaveLength(expectedRows);
            }
        } finally {
            await reopened.close();
            // Optional hand-off for an external Access validator (for example
            // the companion C# reader used during cross-format testing).
            const outputFile = process.env.ACCESS_TEST_OUTPUT_FILE?.trim();
            if (outputFile) {
                await fs.copyFile(temporaryFile, outputFile);
            }
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    test('written files are readable by the Java Jackcess reader when JDK is available', async () => {
        const javaProbe = spawnSync('java', ['-version'], { encoding: 'utf8' });
        if (javaProbe.status !== 0 && !process.env.JAVA_HOME) {
            return;
        }
        const script = path.join(__dirname, '..', '..', '..', 'scripts', 'access-java-crosscheck.cjs');
        if (!fsSync.existsSync(script)) {
            return;
        }
        const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 180000 });
        if (result.status !== 0) {
            throw new Error(`Java cross-check failed:\n${result.stdout}\n${result.stderr}`);
        }
    });

    test('creates foreign keys through DDL and exposes them in metadata', async () => {
        if (process.env.ACCESS_TEST_WRITE !== '1') {
            return;
        }

        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-fk-'));
        const temporaryFile = path.join(temporaryDirectory, path.basename(configuredFile as string));
        await fs.copyFile(configuredFile as string, temporaryFile);

        const connection = new AccessConnection(createConfig(temporaryFile, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE parent_t (id LONG, CONSTRAINT PK PRIMARY KEY (id))').execute();
            await connection.createCommand('CREATE TABLE child_t (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))').execute();
            await connection.createCommand(
                'ALTER TABLE child_t ADD CONSTRAINT FK_child_parent FOREIGN KEY (pid) REFERENCES parent_t (id)',
            ).execute();

            const relationships = await readRows(connection, 'SELECT * FROM _access_metadata.relationships');
            expect(relationships).toEqual([
                ['FK_child_parent', 'child_t', 'pid', 'parent_t', 'id', 1, 0, 0],
            ]);
        } finally {
            await connection.close();
        }

        const reopened = await AccessFileSession.open({ filePath: temporaryFile });
        try {
            expect(reopened.listRelationships()).toEqual([
                {
                    name: 'FK_child_parent',
                    table: 'child_t',
                    columns: ['pid'],
                    foreignTable: 'parent_t',
                    foreignColumns: ['id'],
                    enforced: true,
                    updateCascade: false,
                    deleteCascade: false,
                },
            ]);
        } finally {
            await reopened.close();
            await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
    });
});
