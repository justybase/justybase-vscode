import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
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

    it('maps reordered UPDATE snapshots by the table AutoNumber key', async () => {
        const file = copyFixture('sample2007.accdb');
        try {
            const session = await AccessFileSession.open({ filePath: file });
            const before = await session.readTable('t_people');
            await session.close();

            const reordered = [
                [...before.rows[2]!].map((value, index) => index === 1 ? 'updated third' : value),
                [...before.rows[0]!],
                [...before.rows[1]!],
            ];
            await writeAccessSnapshotChanges(
                file,
                'accdb2007',
                [before],
                [{ definition: before.definition, rows: reordered }],
            );

            const reopened = await AccessFileSession.open({ filePath: file });
            try {
                const rows = (await reopened.readTable('t_people')).rows;
                expect(rows.map(row => row[1])).toEqual([
                    before.rows[0]![1],
                    before.rows[1]![1],
                    'updated third',
                ]);
            } finally {
                await reopened.close();
            }
        } finally {
            fs.rmSync(file, { force: true });
        }
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
import { AccessDuckDbMirror } from '../../extensions/access/src/accessDuckDbMirror';
import type { DatabaseConnectionConfig } from '../contracts/database';

/**
 * Access DDL/lock tests execute the optional DuckDB mirror. CI installs the
 * extension dependencies (`extensions/access/npm ci`); a root-only install has
 * no `@duckdb/node-api`, so skip these runtime tests instead of failing the
 * whole suite. The pure Jet reader tests above remain active.
 */
const accessRequire = createRequire(path.join(__dirname, '../../extensions/access/package.json'));
const accessDuckDbAvailable = (() => {
    try {
        accessRequire.resolve('@duckdb/node-api');
        return true;
    } catch {
        return false;
    }
})();
const describeWithAccessRuntime = accessDuckDbAvailable ? describe : describe.skip;

function createAccessConfig(database: string, readOnly: boolean): DatabaseConnectionConfig {
    return { host: '', database, user: '', options: { readOnly } };
}

describeWithAccessRuntime('AccessConnection lock file', () => {
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

describeWithAccessRuntime('AccessConnection DDL', () => {
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

    it('truncates a table and accepts Access-qualified DELETE targets', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE trunc_e2e (id LONG PRIMARY KEY, nazwa TEXT(50))').execute();
            await connection.createCommand("INSERT INTO trunc_e2e (id, nazwa) VALUES (1, 'a')").execute();
            await connection.createCommand("INSERT INTO trunc_e2e (id, nazwa) VALUES (2, 'b')").execute();
            expect(Number((await readAllRows(connection, 'SELECT COUNT(*) FROM trunc_e2e'))[0]?.[0])).toBe(2);

            await connection.createCommand('TRUNCATE TABLE trunc_e2e').execute();
            expect(Number((await readAllRows(connection, 'SELECT COUNT(*) FROM trunc_e2e'))[0]?.[0])).toBe(0);

            await connection.createCommand("INSERT INTO trunc_e2e (id, nazwa) VALUES (3, 'c')").execute();
            await connection.createCommand('DELETE FROM default.trunc_e2e').execute();
            expect(Number((await readAllRows(connection, 'SELECT COUNT(*) FROM trunc_e2e'))[0]?.[0])).toBe(0);
        } finally {
            await connection.close();
        }
    });

    it('exposes primary keys and indexes through the schema-tree metadata markers', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE idx_e2e (id LONG PRIMARY KEY, code TEXT(20))').execute();
            await connection.createCommand('CREATE UNIQUE INDEX idx_e2e_code ON idx_e2e (code)').execute();
            await connection.createCommand('CREATE INDEX idx_e2e_code_plain ON idx_e2e (code)').execute();

            const keys = await readAllRows(connection, "SELECT * FROM _access_metadata.keys WHERE TABLE = 'idx_e2e'");
            expect(keys.some(row => row[1] === 'PRIMARY KEY')).toBe(true);
            expect(keys.some(row => row[1] === 'UNIQUE')).toBe(true);

            const indexes = await readAllRows(connection, "SELECT * FROM _access_metadata.indexes WHERE TABLE = 'idx_e2e'");
            expect(indexes.map(row => row[0])).toContain('idx_e2e_code_plain');
            expect(indexes.every(row => row[1] === 'INDEX')).toBe(true);

            const triggers = await readAllRows(connection, "SELECT * FROM _access_metadata.triggers WHERE TABLE = 'idx_e2e'");
            expect(triggers).toEqual([]);
        } finally {
            await connection.close();
        }
    });

    it('rejects a unique index over existing duplicate values', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE dup_e2e (id LONG PRIMARY KEY, code TEXT(20))').execute();
            await connection.createCommand("INSERT INTO dup_e2e (id, code) VALUES (1, 'x')").execute();
            await connection.createCommand("INSERT INTO dup_e2e (id, code) VALUES (2, 'x')").execute();
            await expect(connection.createCommand('CREATE UNIQUE INDEX dup_e2e_code ON dup_e2e (code)').execute())
                .rejects.toThrow();
        } finally {
            await connection.close();
        }
    });

    it('applies Access column defaults to INSERTs that omit the column', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            // accessLike.mdb declares Campo1 DEFAULT "campo1". Access would fill
            // it on an INSERT that omits the column; the mirror and the file
            // write must do the same, otherwise editing a file silently stores
            // values Access would never produce.
            await connection.createCommand('INSERT INTO t_like2 (ID, Campo2) VALUES (99, \'x\')').execute();
            const rows = await readAllRows(connection, 'SELECT ID, Campo1, Campo2 FROM t_like2 WHERE ID = 99');
            expect(rows).toEqual([[99, 'campo1', 'x']]);

            // The metadata markers must expose the source DefaultValue and the
            // Required flag, because DDL export and the edit-data panel read
            // them from here rather than from the session object.
            const columns = await readAllRows(
                connection,
                "SELECT * FROM _access_metadata.table_columns WHERE TABLE = 't_like2'",
            );
            const campo1 = columns.find(row => row[0] === 'Campo1');
            expect(campo1?.[3]).toBe(0);
            expect(campo1?.[4]).toBe('"campo1"');
            const campo2 = columns.find(row => row[0] === 'Campo2');
            expect(campo2?.[3]).toBe(1);
        } finally {
            await connection.close();
        }
        const session = await AccessFileSession.open({ filePath: file });
        try {
            const rows = (await session.readTable('t_like2')).rows.filter(row => row[0] === 99);
            expect(rows).toEqual([[99, 'campo1', 'x', null]]);
        } finally {
            await session.close();
        }
    });

    it('keeps a Required column rejected when an INSERT omits it', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            // Campo2 is Required in the fixture.  The mirror must enforce that,
            // because the writer only copies rows that the mirror accepted.
            await expect(connection.createCommand('INSERT INTO t_like2 (ID, Campo1) VALUES (100, \'y\')').execute())
                .rejects.toThrow(/NOT NULL|NULL/i);
        } finally {
            await connection.close();
        }
        const session = await AccessFileSession.open({ filePath: file });
        try {
            expect((await session.readTable('t_like2')).rows.some(row => row[0] === 100)).toBe(false);
        } finally {
            await session.close();
        }
    });

    it('enforces AllowZeroLength and ValidationRule the same way Access does', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            // accessLike.mdb stores AllowZeroLength=False on Campo2 and a
            // column rule on t_like1.a1.  Both come from the property map.
            await expect(connection.createCommand("INSERT INTO t_like2 (ID, Campo1, Campo2) VALUES (199, 'x', '')").execute())
                .rejects.toThrow(/CHECK|constraint/i);
            await connection.createCommand("INSERT INTO t_like2 (ID, Campo1, Campo2) VALUES (200, 'x', 'ok')").execute();
            expect(await readAllRows(connection, 'SELECT ID, Campo1, Campo2 FROM t_like2 WHERE ID = 200'))
                .toEqual([[200, 'x', 'ok']]);

            // NULL still passes: Access only rejects values whose rule is false.
            const columns = await readAllRows(
                connection,
                "SELECT * FROM _access_metadata.table_columns WHERE TABLE = 't_like2'",
            );
            expect(columns.find(row => row[0] === 'Campo2')?.[11]).toBe(0);
            expect(columns.find(row => row[0] === 'Campo3')?.[11]).toBe(1);
        } finally {
            await connection.close();
        }
        const session = await AccessFileSession.open({ filePath: file });
        try {
            const definition = session.getTableDefinition('t_like2');
            expect(definition.columns.find(column => column.name === 'Campo2')?.allowZeroLength).toBe(false);
            expect(definition.columns.find(column => column.name === 'Campo1')?.allowZeroLength).toBe(true);
            // The rejected row must never reach the file.
            expect((await session.readTable('t_like2')).rows.some(row => row[0] === 199)).toBe(false);
        } finally {
            await session.close();
        }
    });

    it('relaxes validation only when legacy rows already violate the rule', async () => {
        const file = copyFixture('accessLike.mdb');
        const { rows } = openNamed(file, 't_like2', 50);
        // Write a row that breaks AllowZeroLength directly through the writer,
        // which is how a file made by another tool can carry legacy bad data.
        await applyWrite(file, 'jet4', 't_like2', rows, [...rows, [300, 'legacy', '', null]]);

        const session = await AccessFileSession.open({ filePath: file });
        const mirror = new AccessDuckDbMirror();
        // The mirror consumes the published package types; the test opens the
        // source session, which is structurally identical.
        await mirror.open(session as unknown as Parameters<AccessDuckDbMirror['open']>[0]);
        try {
            // Access would still open such a file, so the mirror must too; the
            // constraint is dropped with a warning instead of blocking the file.
            expect(mirror.warnings.join('\n')).toContain('t_like2');
            await mirror.executeAndReadAll("INSERT INTO t_like2 (ID, Campo1, Campo2) VALUES (301, 'x', 'ok')");
            const count = await mirror.executeAndReadAll('SELECT COUNT(*) AS c FROM t_like2');
            expect(Number(count.rows?.[0]?.[0])).toBe(rows.length + 2);
        } finally {
            await mirror.close();
            await session.close();
        }
    });

    it('creates a table with DEFAULT columns and keeps them through a reopen', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand(
                'CREATE TABLE default_e2e (id LONG PRIMARY KEY, code TEXT(20) DEFAULT "abc", n LONG DEFAULT (3), flag BOOLEAN DEFAULT True)',
            ).execute();
            await connection.createCommand('INSERT INTO default_e2e (id) VALUES (1)').execute();
            expect(await readAllRows(connection, 'SELECT id, code, n, flag FROM default_e2e'))
                .toEqual([[1, 'abc', 3, true]]);
        } finally {
            await connection.close();
        }
        const session = await AccessFileSession.open({ filePath: file });
        try {
            expect(session.getTableDefinition('default_e2e').columns.map(column => ({
                name: column.name,
                nullable: column.nullable,
                defaultValue: column.defaultValue,
            }))).toEqual([
                { name: 'id', nullable: true, defaultValue: undefined },
                { name: 'code', nullable: true, defaultValue: '"abc"' },
                { name: 'n', nullable: true, defaultValue: '(3)' },
                { name: 'flag', nullable: true, defaultValue: 'True' },
            ]);
        } finally {
            await session.close();
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

    it('refreshes another in-process mirror after a write', async () => {
        const file = copyFixture('sample2007.accdb');
        const first = new AccessConnection(createAccessConfig(file, false));
        const second = new AccessConnection(createAccessConfig(file, false));
        try {
            await first.connect();
            await second.connect();
            await first.createCommand("INSERT INTO t_people (name) VALUES ('from first connection')").execute();

            const rows = await readAllRows(second, 'SELECT id, name FROM t_people ORDER BY id');
            expect(rows).toHaveLength(4);
            expect(rows[3]).toEqual([4, 'from first connection']);
        } finally {
            await second.close();
            await first.close();
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

describeWithAccessRuntime('AccessConnection mirror keys and relationships', () => {
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

    it('enforces an Access text primary key with its case and trailing-space rules', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            // Access rejects a text key that differs only by case or trailing
            // spaces, and accepts a leading space; a DuckDB PRIMARY KEY would
            // do the opposite, so the mirror uses the Access comparison.
            await connection.createCommand('CREATE TABLE key_e2e (code TEXT(20) PRIMARY KEY, n LONG)').execute();
            await connection.createCommand("INSERT INTO key_e2e (code, n) VALUES ('a', 1)").execute();
            await expect(connection.createCommand("INSERT INTO key_e2e (code, n) VALUES ('A', 2)").execute())
                .rejects.toThrow(/unique|duplicate|constraint/i);
            await expect(connection.createCommand("INSERT INTO key_e2e (code, n) VALUES ('a ', 3)").execute())
                .rejects.toThrow(/unique|duplicate|constraint/i);
            await connection.createCommand("INSERT INTO key_e2e (code, n) VALUES (' a', 4)").execute();
            // A primary key cannot hold NULL at all.
            await expect(connection.createCommand('INSERT INTO key_e2e (code, n) VALUES (NULL, 5)').execute())
                .rejects.toThrow(/NOT NULL|NULL/i);
            expect(await readAllRows(connection, 'SELECT code FROM key_e2e ORDER BY code'))
                .toEqual([[' a'], ['a']]);
        } finally {
            await connection.close();
        }
    });

    it('rejects a duplicate on a unique index and still allows repeated NULL keys', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE uniq_e2e (id LONG PRIMARY KEY, code TEXT(20))').execute();
            await connection.createCommand('CREATE UNIQUE INDEX UX_uniq_e2e ON uniq_e2e (code)').execute();
            await connection.createCommand("INSERT INTO uniq_e2e (id, code) VALUES (1, 'a')").execute();
            await expect(connection.createCommand("INSERT INTO uniq_e2e (id, code) VALUES (2, 'A')").execute())
                .rejects.toThrow(/unique|duplicate|constraint/i);
            // Access tolerates duplicate NULLs in a unique index regardless of
            // `WITH IGNORE NULL`, so the mirror must too.
            await connection.createCommand('INSERT INTO uniq_e2e (id, code) VALUES (3, NULL)').execute();
            await connection.createCommand('INSERT INTO uniq_e2e (id, code) VALUES (4, NULL)').execute();
            // The case-only duplicate was rejected above, so the table keeps
            // the first row plus both NULL keys.
            expect(Number((await readAllRows(connection, 'SELECT COUNT(*) FROM uniq_e2e'))[0]?.[0])).toBe(3);
        } finally {
            await connection.close();
        }
    });

    it('enforces a composite unique index with an all-or-nothing NULL rule', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand(
                'CREATE TABLE comp_e2e (id LONG PRIMARY KEY, a TEXT(10), b TEXT(10))',
            ).execute();
            await connection.createCommand('CREATE UNIQUE INDEX UX_comp_e2e ON comp_e2e (a, b)').execute();
            await connection.createCommand("INSERT INTO comp_e2e (id, a, b) VALUES (1, 'k', NULL)").execute();
            // Two rows whose key contains a NULL are both allowed.
            await connection.createCommand("INSERT INTO comp_e2e (id, a, b) VALUES (2, 'k', NULL)").execute();
            await connection.createCommand("INSERT INTO comp_e2e (id, a, b) VALUES (3, 'k', 'v')").execute();
            await expect(connection.createCommand("INSERT INTO comp_e2e (id, a, b) VALUES (4, 'K', 'V')").execute())
                .rejects.toThrow(/unique|duplicate|constraint/i);
        } finally {
            await connection.close();
        }
    });

    it('enforces an Access relationship stored in the file', async () => {
        const file = copyFixture('sample2007.accdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE fk_parent (id LONG PRIMARY KEY, name TEXT(20))').execute();
            await connection.createCommand('CREATE TABLE fk_child (id LONG PRIMARY KEY, pid LONG, note TEXT(20))').execute();
            await connection.createCommand(
                'ALTER TABLE fk_child ADD CONSTRAINT FK_child_parent FOREIGN KEY (pid) REFERENCES fk_parent (id)',
            ).execute();

            await connection.createCommand("INSERT INTO fk_parent (id, name) VALUES (1, 'parent')").execute();
            await connection.createCommand('INSERT INTO fk_child (id, pid) VALUES (1, 1)').execute();
            // An orphan child and a parent that is still referenced are both
            // rejected exactly like Access does.
            await expect(connection.createCommand('INSERT INTO fk_child (id, pid) VALUES (2, 99)').execute())
                .rejects.toThrow(/foreign key|constraint/i);
            await expect(connection.createCommand('DELETE FROM fk_parent WHERE id = 1').execute())
                .rejects.toThrow(/foreign key|constraint/i);
            await connection.createCommand('INSERT INTO fk_child (id, pid) VALUES (3, NULL)').execute();
            expect(Number((await readAllRows(connection, 'SELECT COUNT(*) FROM fk_child'))[0]?.[0])).toBe(2);
        } finally {
            await connection.close();
        }
    });

    it('reports table descriptions through the schema-tree markers', async () => {
        const file = copyFixture('accessLike.mdb');
        const connection = new AccessConnection(createAccessConfig(file, false));
        await connection.connect();
        try {
            // Access keeps a description in the table-definition property
            // block.  The schema tree reads it through two markers, so both
            // must report the same text (the fixtures carry none, which must be
            // an empty string rather than a missing row).
            const tables = await readAllRows(connection, 'SELECT * FROM _access_metadata.tables');
            for (const row of tables) {
                const name = String(row[0]);
                const comment = await readAllRows(
                    connection,
                    `SELECT * FROM _access_metadata.table_comment WHERE TABLE = '${name.replace(/'/g, "''")}'`,
                );
                expect(comment).toHaveLength(1);
                expect(String(comment[0]?.[0] ?? '')).toBe(String(row[4] ?? ''));
            }
        } finally {
            await connection.close();
        }
    });

    it('exposes mirror warnings instead of hiding relaxed constraints', async () => {
        const file = copyFixture('complex.accdb');
        const connection = new AccessConnection(createAccessConfig(file, true));
        await connection.connect();
        try {
            // complex.accdb stores multivalue/attachment indexes that DuckDB
            // cannot reproduce, so the mirror must say so.
            const warnings = await readAllRows(connection, 'SELECT * FROM _access_metadata.mirror_warnings');
            expect(warnings.length).toBeGreaterThan(0);
            expect(warnings.map(row => String(row[0])).join('\n')).toMatch(/index|complex|key/i);
        } finally {
            await connection.close();
        }
    });
});
