import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccessFileSession } from '../../packages/access-file/src';
import { applyDdlSql } from '../../packages/access-file/src/jet/JetDdlSql';
import { addRelationship } from '../../packages/access-file/src/jet/JetDdl';
import { JetPageChannel } from '../../packages/access-file/src/jet/JetPageChannel';
import { JetTable } from '../../packages/access-file/src/jet/JetTable';
import { jetLayoutFor } from '../../packages/access-file/src/jet/JetLayout';

const FIXTURES = path.join(__dirname, 'fixtures', 'access');
const SAMPLE = path.join(FIXTURES, 'sample2007.accdb');

function makeWorkingFile(): { directory: string; filePath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-jet-fk-'));
    const filePath = path.join(directory, 'test.accdb');
    fs.copyFileSync(SAMPLE, filePath);
    return { directory, filePath };
}

function applyDdl(filePath: string, statements: readonly string[]): void {
    const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
    for (const statement of statements) {
        applyDdlSql(channel, statement);
    }
    fs.writeFileSync(filePath, channel.buffer);
}

describe('JetDdlSql foreign keys (Phase 4)', () => {
    it('keeps CREATE UNIQUE INDEX unique in the stored definition', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE unique_t (id LONG PRIMARY KEY, code TEXT(20))',
                'CREATE UNIQUE INDEX unique_t_code ON unique_t (code)',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listIndexes('unique_t')).toEqual(expect.arrayContaining([
                    expect.objectContaining({ name: 'unique_t_code', primaryKey: false, unique: true }),
                ]));
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('accepts Access-qualified names in table, index, constraint and drop DDL', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE default.q_parent (id LONG PRIMARY KEY)',
                'CREATE TABLE [db].[q child] (id LONG PRIMARY KEY, pid LONG)',
                'ALTER TABLE default.[q child] ADD CONSTRAINT FK_q FOREIGN KEY (pid) REFERENCES default.q_parent (id)',
                'CREATE INDEX default.q_child_pid ON default.[q child] (pid)',
                'ALTER TABLE default.[q child] DROP CONSTRAINT FK_q',
                'DROP INDEX default.q_child_pid ON default.[q child]',
                'DROP TABLE default.[q child]',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listTables().map(table => table.name).sort()).toEqual(['q_parent', 't_people']);
                expect(session.listIndexes('q_parent').map(index => index.name)).toContain('PrimaryKey');
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('reports CREATE TABLE AS SELECT as unsupported before parsing columns', () => {
        const channel = new JetPageChannel(fs.readFileSync(SAMPLE), jetLayoutFor('accdb2007'));
        expect(() => applyDdlSql(channel, 'CREATE TABLE copy_t AS SELECT * FROM t_people'))
            .toThrow(/CREATE TABLE AS SELECT is not supported/i);
    });

    it('adds and lists a foreign key through ALTER TABLE', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE parent_t (id LONG, name TEXT(50), CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE child_t (id LONG, pid LONG, note TEXT(50), CONSTRAINT PK PRIMARY KEY (id))',
                'ALTER TABLE child_t ADD CONSTRAINT FK_child_parent FOREIGN KEY (pid) REFERENCES parent_t (id)',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listTables().map(table => table.name).sort()).toEqual(['child_t', 'parent_t', 't_people']);
                expect(session.listRelationships()).toEqual([
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
                // FK index created alongside the relationship
                const indexes = session.listIndexes('child_t');
                expect(indexes.map(index => index.name)).toEqual(['PK', 'FK_child_parent']);
                expect(indexes.find(index => index.name === 'FK_child_parent')?.columns).toEqual(['pid']);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('supports inline FOREIGN KEY in CREATE TABLE and DROP CONSTRAINT', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE p (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c (id LONG, pid LONG, CONSTRAINT FK_c_p FOREIGN KEY (pid) REFERENCES p (id))',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listRelationships().map(relationship => relationship.name)).toEqual(['FK_c_p']);
            } finally {
                await session.close();
            }

            applyDdl(filePath, ['ALTER TABLE c DROP CONSTRAINT FK_c_p']);
            const reopened = await AccessFileSession.open({ filePath });
            try {
                expect(reopened.listRelationships()).toEqual([]);
            } finally {
                await reopened.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('supports composite foreign keys', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE parent_c (k1 LONG, k2 LONG, CONSTRAINT PK PRIMARY KEY (k1, k2))',
                'CREATE TABLE child_c (id LONG, fk1 LONG, fk2 LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'ALTER TABLE child_c ADD CONSTRAINT FK_composite FOREIGN KEY (fk1, fk2) REFERENCES parent_c (k1, k2)',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listRelationships()).toEqual([
                    {
                        name: 'FK_composite',
                        table: 'child_c',
                        columns: ['fk1', 'fk2'],
                        foreignTable: 'parent_c',
                        foreignColumns: ['k1', 'k2'],
                        enforced: true,
                        updateCascade: false,
                        deleteCascade: false,
                    },
                ]);
                expect(session.listIndexes('child_c').find(index => index.name === 'FK_composite')?.columns).toEqual(['fk1', 'fk2']);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('rejects relationships with unknown columns or tables', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
            applyDdlSql(channel, 'CREATE TABLE p (id LONG, CONSTRAINT PK PRIMARY KEY (id))');
            applyDdlSql(channel, 'CREATE TABLE c (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))');
            expect(() => applyDdlSql(channel, 'ALTER TABLE c ADD CONSTRAINT bad FOREIGN KEY (missing) REFERENCES p (id)'))
                .toThrow(/unknown column/);
            expect(() => applyDdlSql(channel, 'ALTER TABLE c ADD CONSTRAINT bad FOREIGN KEY (id) REFERENCES ghost (id)'))
                .toThrow(/does not exist/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('exposes relationships through the metadata marker', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE parent_t (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE child_t (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'ALTER TABLE child_t ADD CONSTRAINT FK_child_parent FOREIGN KEY (pid) REFERENCES parent_t (id)',
            ]);
            const session = await AccessFileSession.open({ filePath });
            try {
                const relationships = session.listRelationships();
                expect(relationships).toHaveLength(1);
                expect(relationships[0]).toMatchObject({ name: 'FK_child_parent', table: 'child_t', foreignTable: 'parent_t' });
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('detects GUID AutoNumber from the column flag bits', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, ['CREATE TABLE guid_t (id GUID AUTOINCREMENT, name TEXT(10))']);
            const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
            const catalog = new JetTable(channel, 'MSysObjects', 2);
            const catalogRow = catalog.rowLocations()
                .map(location => catalog.readRowValues(location))
                .find(row => String(row[2] ?? '').toLowerCase() === 'guid_t');
            expect(catalogRow).toBeDefined();
            const table = new JetTable(channel, 'guid_t', Number(catalogRow?.[0]) & 0x00ffffff);
            const id = table.columns.find(column => column.name.toLowerCase() === 'id');
            expect(id).toMatchObject({ autoUuid: true, autoLong: false });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('stores TEXT(n) as n characters (2 bytes each) in Jet', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, ['CREATE TABLE text_t (id LONG, name TEXT(50))']);
            const session = await AccessFileSession.open({ filePath });
            try {
                const name = session.getTableDefinition('text_t').columns
                    .find(column => column.name === 'name');
                expect(name?.size).toBe(100);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('round-trips enforced and cascade relationship attributes', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE p (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c1 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c2 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c3 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
            ]);
            const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
            addRelationship(channel, {
                name: 'FK_enf', table: 'c1', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'], enforced: true,
            });
            addRelationship(channel, {
                name: 'FK_noenf', table: 'c2', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'], enforced: false,
            });
            addRelationship(channel, {
                name: 'FK_casc', table: 'c3', columns: ['pid'], foreignTable: 'p', foreignColumns: ['id'],
                enforced: true, updateCascade: true, deleteCascade: true,
            });
            fs.writeFileSync(filePath, channel.buffer);

            const session = await AccessFileSession.open({ filePath });
            try {
                const relationships = session.listRelationships();
                expect(relationships).toHaveLength(3);
                expect(relationships.find(relationship => relationship.name === 'FK_enf')).toMatchObject({
                    enforced: true,
                    updateCascade: false,
                    deleteCascade: false,
                });
                expect(relationships.find(relationship => relationship.name === 'FK_noenf')).toMatchObject({
                    enforced: false,
                    updateCascade: false,
                    deleteCascade: false,
                });
                expect(relationships.find(relationship => relationship.name === 'FK_casc')).toMatchObject({
                    enforced: true,
                    updateCascade: true,
                    deleteCascade: true,
                });
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('removes relationships that reference a dropped table', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE p (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c1 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE c2 (id LONG, pid LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'ALTER TABLE c1 ADD CONSTRAINT FK_c1 FOREIGN KEY (pid) REFERENCES p (id)',
                'ALTER TABLE c2 ADD CONSTRAINT FK_c2 FOREIGN KEY (pid) REFERENCES p (id)',
            ]);
            applyDdl(filePath, ['DROP TABLE c1']);

            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listRelationships().map(relationship => relationship.name)).toEqual(['FK_c2']);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('maps Access INTEGER to a 4-byte Long Integer and SMALLINT to 2 bytes', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, ['CREATE TABLE int_types (a INTEGER, b SMALLINT)']);
            const session = await AccessFileSession.open({ filePath });
            try {
                const columns = session.getTableDefinition('int_types').columns;
                expect(columns.find(column => column.name === 'a')?.size).toBe(4);
                expect(columns.find(column => column.name === 'b')?.size).toBe(2);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('rejects BIGINT columns in Jet 4 .mdb files', () => {
        const filePath = path.join(FIXTURES, 'accessLike.mdb');
        const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('jet4'));
        expect(() => applyDdlSql(channel, 'CREATE TABLE big_t (a BIGINT)'))
            .toThrow(/BIGINT.*\.accdb|Jet 4/i);
    });

    it('recreates an AutoNumber column from COUNTER', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, ['CREATE TABLE counter_t (id COUNTER, name TEXT(10))']);
            const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
            const catalog = new JetTable(channel, 'MSysObjects', 2);
            const catalogRow = catalog.rowLocations()
                .map(location => catalog.readRowValues(location))
                .find(row => String(row[2] ?? '').toLowerCase() === 'counter_t');
            expect(catalogRow).toBeDefined();
            const table = new JetTable(channel, 'counter_t', Number(catalogRow?.[0]) & 0x00ffffff);
            const id = table.columns.find(column => column.name.toLowerCase() === 'id');
            expect(id).toMatchObject({ autoLong: true, autoUuid: false });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('creates a table after dropping another without corrupting the catalog', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            applyDdl(filePath, [
                'CREATE TABLE a (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'CREATE TABLE b (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
                'DROP TABLE a',
                'CREATE TABLE c (id LONG, CONSTRAINT PK PRIMARY KEY (id))',
            ]);
            applyDdl(filePath, ['CREATE TABLE d (id LONG, CONSTRAINT PK PRIMARY KEY (id))']);

            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listTables().map(table => table.name).sort()).toEqual(['b', 'c', 'd', 't_people']);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('adds an index to a table that already has rows', async () => {
        const { directory, filePath } = makeWorkingFile();
        try {
            const channel = new JetPageChannel(fs.readFileSync(filePath), jetLayoutFor('accdb2007'));
            applyDdlSql(channel, 'CREATE TABLE idx_t (id LONG, name TEXT(20))');
            const catalog = new JetTable(channel, 'MSysObjects', 2);
            const catalogRow = catalog.rowLocations()
                .map(location => catalog.readRowValues(location))
                .find(row => String(row[2] ?? '').toLowerCase() === 'idx_t');
            expect(catalogRow).toBeDefined();
            const table = new JetTable(channel, 'idx_t', Number(catalogRow?.[0]) & 0x00ffffff);
            table.addRowWithIndexes([1, 'one']);
            table.addRowWithIndexes([2, 'two']);
            applyDdlSql(channel, 'CREATE INDEX IX_idx_t ON idx_t (id)');
            fs.writeFileSync(filePath, channel.buffer);

            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listIndexes('idx_t').map(index => index.name)).toContain('IX_idx_t');
                expect((await session.readTable('idx_t')).rows).toHaveLength(2);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
