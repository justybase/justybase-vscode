import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection } from '../../../dialects/sqlite';

async function readAllRows(connection: SqliteConnection, sql: string): Promise<unknown[][]> {
    const command = connection.createCommand(sql);
    const reader = await command.executeReader();
    const rows: unknown[][] = [];

    try {
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                row.push(reader.getValue(i));
            }
            rows.push(row);
        }
    } finally {
        await reader.close();
    }

    return rows;
}

describe('SqliteConnection runtime', () => {
    it('executes basic SQL and compatibility queries against an in-memory database', async () => {
        const connection = new SqliteConnection({
            host: '',
            database: ':memory:',
            user: '',
            password: ''
        });

        await connection.connect();

        try {
            await connection.createCommand('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL);').execute();

            const insertCommand = connection.createCommand("INSERT INTO items(name) VALUES ('alpha'), ('beta');");
            await insertCommand.execute();
            expect(insertCommand._recordsAffected).toBe(2);

            expect(await readAllRows(connection, 'SELECT id, name FROM items ORDER BY id;')).toEqual([
                [1, 'alpha'],
                [2, 'beta']
            ]);

            expect(await readAllRows(connection, 'SELECT CURRENT_CATALOG, CURRENT_SCHEMA;')).toEqual([
                ['main', 'main']
            ]);
        } finally {
            await connection.close();
        }
    });

    it('supports SET CATALOG for attached databases', async () => {
        const connection = new SqliteConnection({
            host: '',
            database: ':memory:',
            user: '',
            password: ''
        });

        await connection.connect();

        try {
            await connection.createCommand("ATTACH DATABASE ':memory:' AS analytics;").execute();
            await connection.createCommand('SET CATALOG analytics;').execute();

            expect(await readAllRows(connection, 'SELECT CURRENT_CATALOG;')).toEqual([['analytics']]);
        } finally {
            await connection.close();
        }
    });

    it('creates a missing database file (and its parent directory) on connect', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-conn-'));
        const dbPath = path.join(workspace, 'nested', 'brand-new.db');
        expect(fs.existsSync(dbPath)).toBe(false);

        const connection = new SqliteConnection({
            host: '',
            database: dbPath,
            user: '',
            password: ''
        });

        try {
            await connection.connect();
            expect(fs.existsSync(dbPath)).toBe(true);

            await connection.createCommand('CREATE TABLE items(id INTEGER PRIMARY KEY);').execute();
            expect(await readAllRows(connection, 'SELECT name FROM pragma_database_list;')).toEqual([['main']]);
        } finally {
            await connection.close();
        }

        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('reads integers beyond Number.MAX_SAFE_INTEGER without RangeError', async () => {
        const connection = new SqliteConnection({
            host: '',
            database: ':memory:',
            user: '',
            password: ''
        });

        await connection.connect();

        try {
            await connection.createCommand('CREATE TABLE bigints(id INTEGER PRIMARY KEY);').execute();
            await connection.createCommand('INSERT INTO bigints(id) VALUES (9007199254740993);').execute();

            // Out-of-range integers are lossless strings instead of crashing
            // with RangeError; safe values keep their historical number type.
            expect(await readAllRows(connection, 'SELECT id FROM bigints;')).toEqual([['9007199254740993']]);
            expect(await readAllRows(connection, 'SELECT id FROM bigints WHERE id = 1;')).toEqual([]);

            await connection.createCommand('INSERT INTO bigints(id) VALUES (42);').execute();
            expect(await readAllRows(connection, 'SELECT id FROM bigints ORDER BY id;')).toEqual([
                [42],
                ['9007199254740993']
            ]);
        } finally {
            await connection.close();
        }
    });

    it('keeps :memory: mode independent of the database path field', async () => {
        const connection = new SqliteConnection({
            host: '',
            database: '/does/not/exist/ignored.db',
            user: '',
            password: '',
            options: { mode: 'memory' }
        });

        await connection.connect();
        expect(await readAllRows(connection, 'SELECT sqlite_version() AS v;')).toHaveLength(1);
        await connection.close();
    });
});
