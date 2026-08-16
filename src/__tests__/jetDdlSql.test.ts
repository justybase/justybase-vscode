import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccessFileSession } from '../../packages/access-file/src';
import { applyDdlSql } from '../../packages/access-file/src/jet/JetDdlSql';
import { JetPageChannel } from '../../packages/access-file/src/jet/JetPageChannel';
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
});
