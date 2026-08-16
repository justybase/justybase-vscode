import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JetPageChannel } from '../../packages/access-file/src/jet/JetPageChannel';
import { jetLayoutFor } from '../../packages/access-file/src/jet/JetLayout';
import { JetTable } from '../../packages/access-file/src/jet/JetTable';
import { writeAccessSnapshotChanges } from '../../packages/access-file/src/jet/JetWriter';
import { AccessFileSession } from '../../packages/access-file/src';
import type { AccessTableSnapshot, AccessValue } from '../../packages/access-file/src/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'access');

function copyFixture(name: string): string {
    const target = path.join(os.tmpdir(), `jet-table-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.copyFileSync(path.join(FIXTURES, name), target);
    return target;
}

function open(file: string): { table: JetTable; rows: AccessValue[][] } {
    const buffer = fs.readFileSync(file);
    const channel = new JetPageChannel(buffer, jetLayoutFor(file.endsWith('.mdb') ? 'jet4' : 'accdb2007'));
    const table = new JetTable(channel, file.endsWith('.mdb') ? 't_funcs' : 't_people', file.endsWith('.mdb') ? 50 : 80);
    return { table, rows: table.rowLocations().map(location => table.readRowValues(location)) };
}

function openNamed(file: string, name: string, page: number): { table: JetTable; rows: AccessValue[][] } {
    const buffer = fs.readFileSync(file);
    const channel = new JetPageChannel(buffer, jetLayoutFor(file.endsWith('.accdb') ? 'accdb2007' : 'jet4'));
    const table = new JetTable(channel, name, page);
    return { table, rows: table.rowLocations().map(location => table.readRowValues(location)) };
}

function snapshot(name: string, rows: readonly (readonly AccessValue[])[]): AccessTableSnapshot {
    return {
        definition: {
            name,
            // the writer only needs the table name from the definition
            columns: [],
            rowCount: rows.length,
            isSystem: false,
        } as AccessTableSnapshot['definition'],
        rows: rows.map(row => [...row]),
    };
}

/** Reads all discovered user tables (like the mirror snapshotTables does). */
function readAllTables(file: string, format: 'jet4' | 'accdb2007'): Map<string, AccessValue[][]> {
    const buffer = fs.readFileSync(file);
    const channel = new JetPageChannel(buffer, jetLayoutFor(format));
    const catalog = new JetTable(channel, 'MSysObjects', 2);
    const names = new Map<number, string>();
    for (const location of catalog.rowLocations()) {
        const row = catalog.readRowValues(location);
        if (Number(row[3]) === 1) {
            names.set(Number(row[0]) & 0xffffff, String(row[2]));
        }
    }
    const result = new Map<string, AccessValue[][]>();
    for (const [pageNumber, name] of names) {
        if (/^MSys/i.test(name)) continue;
        const table = new JetTable(channel, name, pageNumber);
        result.set(name, table.rowLocations().map(location => table.readRowValues(location)));
    }
    return result;
}

async function applyWrite(
    file: string,
    format: 'jet4' | 'accdb2007',
    tableName: string,
    _before: readonly (readonly AccessValue[])[],
    after: readonly (readonly AccessValue[])[],
): Promise<void> {
    const allBefore = readAllTables(file, format);
    const allAfter = new Map(allBefore);
    allAfter.set(tableName, after.map(row => [...row]));
    await writeAccessSnapshotChanges(
        file,
        format,
        Array.from(allBefore, ([name, rows]) => snapshot(name, rows)),
        Array.from(allAfter, ([name, rows]) => snapshot(name, rows)),
    );
}

describe('JetTable writes on real Access fixtures', () => {
    it('writes a real Jet 3 fixture with variable-length rows', async () => {
        const file = copyFixture('size97.mdb');
        try {
            const session = await AccessFileSession.open({ filePath: file, readOnly: false });
            const before = await session.readTable('table1');
            await session.close();
            const snapshot = (rows: readonly (readonly AccessValue[])[]): AccessTableSnapshot => ({
                definition: before.definition,
                rows: rows.map(row => [...row]),
            });

            await writeAccessSnapshotChanges(file, 'jet3', [snapshot([])], [snapshot([[1, 'hello'], [2, 'world']])]);
            let reopened = await AccessFileSession.open({ filePath: file });
            expect((await reopened.readTable('table1')).rows).toEqual([[1, 'hello'], [2, 'world']]);
            await reopened.close();

            await writeAccessSnapshotChanges(
                file,
                'jet3',
                [snapshot([[1, 'hello'], [2, 'world']])],
                [snapshot([[1, 'x'.repeat(100)], [2, 'world']])],
            );
            reopened = await AccessFileSession.open({ filePath: file });
            expect((await reopened.readTable('table1')).rows).toEqual([[1, 'x'.repeat(100)], [2, 'world']]);
            await reopened.close();

            await writeAccessSnapshotChanges(
                file,
                'jet3',
                [snapshot([[1, 'x'.repeat(100)], [2, 'world']])],
                [snapshot([[1, 'x'.repeat(100)]])],
            );
            reopened = await AccessFileSession.open({ filePath: file });
            expect((await reopened.readTable('table1')).rows).toEqual([[1, 'x'.repeat(100)]]);
            await reopened.close();
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    it('reads the fixture rows exactly as mdb-reader does', () => {
        const file = path.join(FIXTURES, 'sample2007.accdb');
        const { table, rows } = open(file);
        expect(table.indexCount).toBe(0);
        expect(table.rowCount).toBe(3);
        expect(table.columns.map(column => column.name)).toEqual(['id', 'name', 'age', 'salary', 'joined', 'active']);
        expect(rows).toHaveLength(3);
        expect(rows[0]![0]).toBe(1);
        expect(rows[0]![1]).toBe('Anna Kowalska');
        expect(rows[0]![2]).toBe(34);
        expect(rows[0]![4]).toBeInstanceOf(Date);
    });

    it('inserts a row and keeps the file readable (mdb-reader)', async () => {
        const file = copyFixture('sample2007.accdb');
        const { rows } = open(file);
        const after = [
            ...rows.map(row => [...row]),
            [4, 'Nowy', 50, 10000n, new Date('2024-01-01T10:00:00Z'), true],
        ];
        await applyWrite(file, 'accdb2007', 't_people', rows, after);

        const reopened = open(file);
        expect(reopened.table.rowCount).toBe(4);
        expect(reopened.rows.map(row => row[0])).toEqual([1, 2, 3, 4]);
        expect(reopened.rows[3]![1]).toBe('Nowy');
    });

    it('relocates a row in place when it grows beyond its slot', async () => {
        const file = copyFixture('sample2007.accdb');
        const { rows } = open(file);
        const longName = 'X'.repeat(200);
        const after = rows.map((row, index) => index === 1 ? [row[0], longName, row[2], row[3], row[4], row[5]] : [...row]);
        await applyWrite(file, 'accdb2007', 't_people', rows, after);

        const reopened = open(file);
        expect(reopened.rows).toHaveLength(3);
        expect(reopened.rows[1]![1]).toBe(longName);
        // physical order is preserved by the in-page rewrite
        expect(reopened.rows.map(row => row[0])).toEqual([1, 2, 3]);
    });

    it('refreshes later row locations after an earlier row relocation', async () => {
        const file = copyFixture('sample2007.accdb');
        const { rows } = open(file);
        const longName = 'Y'.repeat(220);
        const after = rows.map((row, index) => index === 1
            ? [row[0], longName, row[2], row[3], row[4], row[5]]
            : index === 2
                ? [row[0], row[1], 99, row[3], row[4], row[5]]
                : [...row]);
        await applyWrite(file, 'accdb2007', 't_people', rows, after);

        const reopened = open(file);
        expect(reopened.rows.map(row => row[0])).toEqual([1, 2, 3]);
        expect(reopened.rows[1]![1]).toBe(longName);
        expect(reopened.rows[2]![2]).toBe(99);
    });

    it('deletes a middle row and keeps the remaining order', async () => {
        const file = copyFixture('sample2007.accdb');
        const { rows } = open(file);
        const after = rows.filter((_, index) => index !== 1);
        await applyWrite(file, 'accdb2007', 't_people', rows, after);

        const reopened = open(file);
        expect(reopened.table.rowCount).toBe(2);
        expect(reopened.rows.map(row => row[0])).toEqual([1, 3]);
    });

    it('writes a long MEMO value through an LVAL chain', async () => {
        const file = copyFixture('functionsV2003.mdb');
        const { rows } = open(file);
        const bigText = 'ĄĆĘŁŃÓŚŹŻ'.repeat(600) + ' end';
        const after = [[rows[0]![0], bigText, rows[0]![2], rows[0]![3]]];
        await applyWrite(file, 'jet4', 't_funcs', rows, after);

        const reopened = open(file);
        expect(reopened.table.rowCount).toBe(1);
        expect(reopened.rows[0]![1]).toBe(bigText);
    });

    it('reuses pages from replaced LVAL chains', async () => {
        const file = copyFixture('functionsV2003.mdb');
        let { rows } = open(file);
        const sizes: number[] = [];
        for (let index = 0; index < 4; index++) {
            const text = `${'L'.repeat(5400 + index * 20)}-${index}`;
            await applyWrite(file, 'jet4', 't_funcs', rows, [[rows[0]![0], text, rows[0]![2], rows[0]![3]]]);
            sizes.push(fs.statSync(file).size);
            ({ rows } = open(file));
        }

        expect(sizes[2]).toBe(sizes[3]);
    });

    it('does not reject an unrelated write because another table is indexed', async () => {
        const file = copyFixture('accessLike.mdb');
        const before = readAllTables(file, 'jet4');
        const after = new Map(before);
        const rows = before.get('t_like1') ?? [];
        after.set('t_like1', [...rows.map(row => [...row]), ['new', 'row']]);
        await writeAccessSnapshotChanges(
            file,
            'jet4',
            Array.from(before, ([name, tableRows]) => snapshot(name, tableRows)),
            Array.from(after, ([name, tableRows]) => snapshot(name, tableRows)),
        );

        expect(readAllTables(file, 'jet4').get('t_like1')).toHaveLength(rows.length + 1);
    });

    it('inserts into an indexed table and updates the unique count', async () => {
        const file = copyFixture('accessLike.mdb');
        const buffer = fs.readFileSync(file);
        const channel = new JetPageChannel(buffer, jetLayoutFor('jet4'));
        const table = new JetTable(channel, 't_like2', 50);
        expect(table.indexCount).toBeGreaterThan(0);
        expect(table.indexDatas[0]!.columns.map(c => c.columnNumber)).toEqual([0]);

        const rows = table.rowLocations().map(location => table.readRowValues(location));
        const after = [...rows.map(row => [...row]), [3, 'nowy', 'x', 'y']];
        await applyWrite(file, 'jet4', 't_like2', rows, after);

        const reopened = readAllTables(file, 'jet4').get('t_like2');
        expect(reopened).toHaveLength(3);
        const reopenedTable = new JetTable(
            new JetPageChannel(fs.readFileSync(file), jetLayoutFor('jet4')),
            't_like2',
            50,
        );
        expect(reopenedTable.indexDatas[0]!.uniqueEntryCount).toBe(3);
    });

    it('rejects duplicate keys in a unique index', async () => {
        const file = copyFixture('accessLike.mdb');
        const { rows } = openNamed(file, 't_like2', 50);
        const after = [...rows.map(row => [...row]), [2, 'dupe', 'x', 'y']];
        await expect(applyWrite(file, 'jet4', 't_like2', rows, after)).rejects.toThrow(/violates uniqueness/i);
    });

    it('updates an indexed column (delete old entry, insert new one)', async () => {
        const file = copyFixture('accessLike.mdb');
        const { rows } = openNamed(file, 't_like2', 50);
        const after = rows.map((row, index) => index === 0 ? [10, row[1], row[2], row[3]] : [...row]);
        await applyWrite(file, 'jet4', 't_like2', rows, after);

        const reopened = readAllTables(file, 'jet4').get('t_like2');
        expect(reopened?.map(row => row[0])).toEqual([10, 2]);
    });

    it('deletes a row from an indexed table', async () => {
        const file = copyFixture('accessLike.mdb');
        const { rows } = openNamed(file, 't_like2', 50);
        const after = rows.filter((_, index) => index !== 1);
        await applyWrite(file, 'jet4', 't_like2', rows, after);

        const reopened = readAllTables(file, 'jet4').get('t_like2');
        expect(reopened?.map(row => row[0])).toEqual([1]);
    });

    it('splits the index B-tree across many inserted rows', async () => {
        const file = copyFixture('accessLike.mdb');
        const all = readAllTables(file, 'jet4');
        const tLike1 = all.get('t_like1')!;
        const s1 = {
            definition: { name: 't_like1', columns: [], rowCount: tLike1.length, isSystem: false },
            rows: tLike1,
        };
        let rows = all.get('t_like2')!;
        for (let batch = 0; batch < 10; batch++) {
            const additions = Array.from({ length: 100 }, (_, index) => {
                const id = 3 + batch * 100 + index;
                return [id, `row_${String(id).padStart(6, '0')}_text`, 'x', 'y'];
            });
            const snap = (r: readonly (readonly AccessValue[])[]): AccessTableSnapshot => snapshot('t_like2', r);
            await writeAccessSnapshotChanges(file, 'jet4', [s1, snap(rows)], [s1, snap([...rows, ...additions])]);
            rows = readAllTables(file, 'jet4').get('t_like2')!;
        }
        expect(rows).toHaveLength(1002);
    });
});

import { AccessConnection } from '../../extensions/access/src/accessConnection';
import type { DatabaseConnectionConfig } from '../contracts/database';

function createAccessConfig(database: string, readOnly: boolean): DatabaseConnectionConfig {
    return { host: '', database, user: '', options: { readOnly } };
}

describe('AccessConnection lock file', () => {
    it('creates and releases the .laccdb lock when opening a writable database', async () => {
        const file = copyFixture('sample2007.accdb');
        const lockPath = file.replace(/\.(?:mdb|accdb)$/i, '') + '.laccdb';

        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            expect(fs.existsSync(lockPath)).toBe(true);
        } finally {
            await connection.close();
        }
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('shares the lock between in-process connections and removes it on last close', async () => {
        const file = copyFixture('sample2007.accdb');
        const lockPath = file.replace(/\.(?:mdb|accdb)$/i, '') + '.laccdb';

        const first = new AccessConnection(createAccessConfig(file, false));
        const second = new AccessConnection(createAccessConfig(file, false));
        await first.connect();
        await second.connect();
        try {
            expect(fs.existsSync(lockPath)).toBe(true);
        } finally {
            await second.close();
            // The first connection still holds the lock.
            expect(fs.existsSync(lockPath)).toBe(true);
            await first.close();
        }
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('refuses a connection when the lock is held by another process', async () => {
        const file = copyFixture('sample2007.accdb');
        const lockPath = file.replace(/\.(?:mdb|accdb)$/i, '') + '.laccdb';
        fs.writeFileSync(lockPath, '');

        const connection = new AccessConnection(createAccessConfig(file, false));
        try {
            await expect(connection.connect()).rejects.toThrow(/already open by another process/);
        } finally {
            await connection.close();
            fs.rmSync(lockPath, { force: true });
        }

        await connection.connect();
        try {
            expect(fs.existsSync(lockPath)).toBe(true);
        } finally {
            await connection.close();
        }
        expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('does not create a lock for read-only connections', async () => {
        const file = copyFixture('sample2007.accdb');
        const connection = new AccessConnection(createAccessConfig(file, true));
        await connection.connect();
        try {
            expect(fs.existsSync(file.replace(/\.(?:mdb|accdb)$/i, '') + '.laccdb')).toBe(false);
        } finally {
            await connection.close();
        }
    });
});

describe('AccessConnection DDL', () => {
    async function readAllRows(connection: AccessConnection, sql: string): Promise<unknown[][]> {
        const reader = await connection.createCommand(sql).executeReader();
        const rows: unknown[][] = [];
        try {
            while (await reader.read()) {
                rows.push(Array.from({ length: reader.fieldCount }, (_, i) => reader.getValue(i)));
            }
        } finally {
            await reader.close();
        }
        return rows;
    }

    it('creates a table, inserts rows and reads them back', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand(
                'CREATE TABLE nowa_e2e (id LONG PRIMARY KEY, nazwa TEXT(50), wartosc DOUBLE)',
            ).execute();
            await connection.createCommand(
                "INSERT INTO nowa_e2e (id, nazwa, wartosc) VALUES (1, 'test', 2.5)",
            ).execute();
            const rows = await readAllRows(connection, 'SELECT * FROM nowa_e2e');
            expect(rows).toEqual([[1, 'test', 2.5]]);
        } finally {
            await connection.close();
        }
    });

    it('creates and drops a view', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand(
                'CREATE VIEW v_e2e AS SELECT ID, Campo1 FROM t_like2 WHERE ID > 1',
            ).execute();
            const rows = await readAllRows(connection, 'SELECT * FROM v_e2e');
            expect(rows.length).toBe(1);
            expect(rows[0]![0]).toBe(2);
            await connection.createCommand('DROP VIEW v_e2e').execute();
            await expect(connection.createCommand('SELECT * FROM v_e2e').executeReader())
                .rejects.toThrow();
        } finally {
            await connection.close();
        }
    });

    it('drops a table', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE do_usuniecia (id LONG PRIMARY KEY)').execute();
            await connection.createCommand('DROP TABLE do_usuniecia').execute();
            const tables = await readAllRows(connection, 'SELECT * FROM _access_metadata.tables');
            expect(tables.some(row => String(row[0]).toLowerCase() === 'do_usuniecia')).toBe(false);
        } finally {
            await connection.close();
        }
    });

    it('exposes the last generated AutoNumber through @@IDENTITY per connection', async () => {
        const file = copyFixture('sample2007.accdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        try {
            await connection.connect();
            await connection.createCommand("INSERT INTO t_people (name) VALUES ('Identity row')").execute();
            await connection.createCommand("UPDATE t_people SET name = 'Identity row updated' WHERE id = 4").execute();
            expect(await readAllRows(connection, 'SELECT @@IDENTITY AS id')).toEqual([[4]]);

            await connection.close();
            await connection.connect();
            expect(await readAllRows(connection, 'SELECT @@IDENTITY AS id')).toEqual([[null]]);
        } finally {
            await connection.close();
            fs.rmSync(file, { force: true });
        }
    });

    it('mirrors Access multivalue and attachment values using the C# envelope', async () => {
        const file = copyFixture('complex.accdb');
        const connection = new AccessConnection(createAccessConfig(file, true));
        try {
            await connection.connect();
            const rows = await readAllRows(connection, 'SELECT Tags, Files FROM ComplexFixture');
            expect(rows).toHaveLength(1);
            const tags = JSON.parse(String(rows[0]?.[0])) as { Kind: string; Values: unknown[] };
            const files = JSON.parse(String(rows[0]?.[1])) as { Kind: string; Values: { FileName: string; FileType: string; FileData: number[] }[] };
            expect(tags).toEqual({ Kind: 'single', Values: ['alpha', 'beta'] });
            expect(files.Kind).toBe('attachment');
            expect(files.Values[0]).toMatchObject({ FileName: 'uca-attachment.txt', FileType: 'txt' });
            expect(files.Values[0]?.FileData.length).toBeGreaterThan(0);
        } finally {
            await connection.close();
            fs.rmSync(file, { force: true });
        }
    });

    it('rejects writes to complex columns instead of serializing arrays into the parent row', async () => {
        const file = copyFixture('complex.accdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        try {
            await connection.connect();
            await expect(connection.createCommand('INSERT INTO ComplexFixture (ID) VALUES (2)').execute())
                .rejects.toThrow(/complex columns.*flat child table/i);
        } finally {
            await connection.close();
            fs.rmSync(file, { force: true });
        }
    });

    it('allows writes to the generated flat table behind a complex column', async () => {
        const file = copyFixture('complex.accdb');
        const session = await AccessFileSession.open({ filePath: file });
        const child = session.listTables().find(table => table.columns.some(column => column.name.toLowerCase() === 'value'));
        await session.close();
        expect(child).toBeDefined();
        const valueColumn = child?.columns.find(column => column.name.toLowerCase() === 'value');
        expect(valueColumn).toBeDefined();

        const connection = new AccessConnection(createAccessConfig(file, false));
        try {
            await connection.connect();
            const tableName = child!.name.replace(/]/g, ']]');
            const columnName = valueColumn!.name.replace(/]/g, ']]');
            await connection.createCommand(
                `UPDATE [${tableName}] SET [${columnName}] = 'gamma' WHERE [${columnName}] = 'alpha'`,
            ).execute();
            expect(await readAllRows(connection, `SELECT [${columnName}] FROM [${tableName}] WHERE [${columnName}] = 'gamma'`))
                .toEqual([['gamma']]);
        } finally {
            await connection.close();
            fs.rmSync(file, { force: true });
        }
    });
});
