import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    AccessFileChangedError,
    AccessFileEncryptedWriteError,
    AccessFileError,
    AccessFileReadOnlyError,
    AccessFileSession,
    ACCESS_COMPLEX_KIND,
    detectAccessFileFormat,
} from '../../packages/access-file/src';
import type { AccessComplexValue } from '../../packages/access-file/src';
import { serializeAccessComplexValue } from '../../packages/access-file/src/complexValues';
import { parseAccessPropertyMapDescription } from '../../packages/access-file/src/accessFileSession';

// `node:fs/promises` is copied by the Babel interop helper, so spying on the
// test's namespace does not affect the module under test.  Mocking the module
// keeps one shared jest.fn (wrapping the real implementation by default) for
// both copies.
jest.mock('node:fs/promises', () => {
    const actual = jest.requireActual('node:fs/promises');
    return {
        ...actual,
        rename: jest.fn(actual.rename),
        link: jest.fn(actual.link),
    };
});

const realRename = (jest.requireActual('node:fs/promises') as typeof fs).rename;
const realLink = (jest.requireActual('node:fs/promises') as typeof fs).link;
const renameMock = fs.rename as jest.Mock;
const linkMock = fs.link as jest.Mock;

beforeEach(() => {
    renameMock.mockReset();
    renameMock.mockImplementation(realRename);
    linkMock.mockReset();
    linkMock.mockImplementation(realLink);
});

function accessHeader(engineName: string, version: number): Buffer {
    const header = Buffer.alloc(21);
    Buffer.from(engineName, 'ascii').copy(header, 4);
    header[20] = version;
    return header;
}

function longDescriptionPropertyMap(text: string): Buffer {
    const name = Buffer.from('Description', 'utf16le');
    const namesBlock = Buffer.alloc(6 + 2 + name.length);
    namesBlock.writeUInt32LE(namesBlock.length, 0);
    namesBlock.writeUInt16LE(0x80, 4);
    namesBlock.writeUInt16LE(name.length, 6);
    name.copy(namesBlock, 8);

    const encoded = Buffer.from(text, 'utf16le');
    const payload = Buffer.alloc(4 + encoded.length);
    payload.writeUInt32LE(encoded.length, 0);
    encoded.copy(payload, 4);
    const valueLength = 2 + 6 + payload.length;
    const value = Buffer.alloc(valueLength);
    value.writeUInt16LE(valueLength, 0);
    value[2] = 0;
    value[3] = 0x0c;
    value.writeUInt16LE(0, 4);
    value.writeUInt16LE(payload.length, 6);
    payload.copy(value, 8);

    const valuesBlock = Buffer.alloc(6 + 6 + value.length);
    valuesBlock.writeUInt32LE(valuesBlock.length, 0);
    valuesBlock.writeUInt16LE(0x00, 4);
    valuesBlock.writeUInt32LE(6, 6);
    value.copy(valuesBlock, 12);
    return Buffer.concat([Buffer.from('MR2\0', 'ascii'), namesBlock, valuesBlock]);
}

describe('Access file format boundary', () => {
    it.each([
        ['Standard Jet DB', 0x00, 'jet3'],
        ['Standard Jet DB', 0x01, 'jet4'],
        ['Standard ACE DB', 0x02, 'accdb2007'],
        ['Standard ACE DB', 0x03, 'accdb2010'],
        ['Standard ACE DB', 0x04, 'accdb2013'],
        ['Standard ACE DB', 0x05, 'accdb2016'],
        ['Standard ACE DB', 0x06, 'accdb2019'],
    ] as const)('detects %s version 0x%s as %s', (engineName, version, expected) => {
        expect(detectAccessFileFormat(accessHeader(engineName, version))).toBe(expected);
    });

    it('reports unknown future ACE versions without treating them as Jet files', () => {
        expect(detectAccessFileFormat(accessHeader('Standard ACE DB', 0x07))).toBe('unknown');
    });

    it('rejects files without an Access engine header', () => {
        expect(() => detectAccessFileFormat(Buffer.alloc(21))).toThrow(AccessFileError);
    });

    it('exposes a distinct read-only error for callers that request a write', () => {
        expect(new AccessFileReadOnlyError('/tmp/sample.accdb')).toBeInstanceOf(AccessFileError);
        expect(new AccessFileReadOnlyError('/tmp/sample.accdb').message).toMatch(/read-only/);
    });

    it('reads table Description from the MSysObjects property map', () => {
        // Captured from DAO after setting TableDef.Properties("Description")
        // on an ACE 2007 table.  The table property block is type 0 and is
        // distinct from the column property block used for Required.
        const propertyMap = Buffer.from(
            '4d523200300000008000100052006500710075006900720065006400160044'
            + '00650073006300720069007000740069006f006e001900000001000a000000'
            + '0400690064000900010100000100013800000000000600000000002c00000a'
            + '0100240050006100720065006e007400200064006500730063007200690070'
            + '00740069006f006e00',
            'hex',
        );
        expect(parseAccessPropertyMapDescription(propertyMap, 'accdb2007')).toBe('Parent description');
        expect(parseAccessPropertyMapDescription(longDescriptionPropertyMap('Long description'), 'accdb2007'))
            .toBe('Long description');
        expect(parseAccessPropertyMapDescription(Buffer.from('not-a-map'), 'accdb2007')).toBeUndefined();
    });

    it('keeps the kind when serializing an empty complex value', () => {
        const emptyAttachment = [] as AccessComplexValue;
        Object.defineProperty(emptyAttachment, ACCESS_COMPLEX_KIND, { value: 'attachment' });
        expect(JSON.parse(serializeAccessComplexValue(emptyAttachment))).toEqual({
            Kind: 'attachment',
            Values: [],
        });
    });

    it.each([
        ['mdb2000', 'jet4'],
        ['mdb2003', 'jet4'],
        ['accdb2007', 'accdb2007'],
        ['accdb2010', 'accdb2010'],
        ['accdb2016', 'accdb2016'],
    ] as const)('creates an empty %s database from the packaged template', async (requested, expected) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-create-'));
        const filePath = path.join(directory, `${requested}.${requested.startsWith('mdb') ? 'mdb' : 'accdb'}`);
        try {
            const session = await AccessFileSession.create({ filePath, format: requested });
            expect(session.format).toBe(expected);
            expect(session.readOnly).toBe(false);
            expect(session.listTableNames()).toEqual([]);
            await session.close();

            const reopened = await AccessFileSession.open({ filePath });
            expect(reopened.format).toBe(expected);
            expect(reopened.listTableNames()).toEqual([]);
            await reopened.close();
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('reads Access multivalue and attachment columns through the flat-table metadata', async () => {
        const filePath = path.join(__dirname, 'fixtures', 'access', 'complex.accdb');
        const session = await AccessFileSession.open({ filePath });
        try {
            const definition = session.getTableDefinition('ComplexFixture');
            const tags = definition.columns.find(column => column.name === 'Tags');
            const files = definition.columns.find(column => column.name === 'Files');
            expect(tags).toMatchObject({ accessType: 'complex', complexTypeId: 37 });
            expect(files).toMatchObject({ accessType: 'complex', complexTypeId: 39 });
            const tableNames = session.listTableNames();
            expect(tableNames).toContain('ComplexFixture');
            expect(tableNames.some(name => name !== 'ComplexFixture')).toBe(true);

            const snapshot = await session.readTable('ComplexFixture');
            expect(snapshot.rows).toHaveLength(1);
            expect(snapshot.rows[0]?.[1]).toEqual([
                { value: 'alpha' },
                { value: 'beta' },
            ]);
            expect(snapshot.rows[0]?.[2]).toMatchObject([{
                name: 'uca-attachment.txt',
                type: 'txt',
            }]);
            const attachment = snapshot.rows[0]?.[2];
            expect(Array.isArray(attachment)).toBe(true);
            expect((attachment as readonly { data: Uint8Array | null }[])[0]?.data?.length).toBeGreaterThan(0);
        } finally {
            await session.close();
        }
    });

    it('reads real Jet 3 and Jet 4 fixtures with stable value representations', async () => {
        const accdb = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'),
        });
        try {
            const snapshot = await accdb.readTable('t_people');
            expect(snapshot.rows).toHaveLength(3);
            expect(snapshot.rows[0]?.slice(0, 3)).toEqual([1, 'Anna Kowalska', 34]);
            // Currency keeps its fixed four-decimal Access representation.
            expect(snapshot.rows[0]?.[3]).toBe('12500.5000');
            // Access stores timezone-less wall-clock values; the reader exposes
            // them as UTC so result formatting and CSV export keep the digits.
            expect(snapshot.rows[0]?.[4]).toEqual(new Date('2020-06-15T09:30:00.000Z'));
            expect(snapshot.rows[0]?.[5]).toBe(true);
        } finally {
            await accdb.close();
        }

        const mdb = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'sample2003.mdb'),
        });
        try {
            const snapshot = await mdb.readTable('t_people');
            expect(snapshot.rows.map(row => row[1])).toEqual([
                'Anna Kowalska',
                'Jan Nowak',
                'Ewa Wiśniewska',
            ]);
        } finally {
            await mdb.close();
        }

        const polish = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'sample_polish.accdb'),
        });
        try {
            const snapshot = await polish.readTable('sample_table_01');
            expect(snapshot.rows).toHaveLength(20);
            expect(snapshot.rows[0]).toEqual([1, 'row_000000_text', 0]);
            expect(polish.listIndexes('sample_table_01')).toEqual([
                {
                    name: 'PrimaryKey',
                    columns: ['text_col1'],
                    primaryKey: true,
                    unique: true,
                    ignoreNulls: false,
                    required: true,
                },
                {
                    name: 'num_col2',
                    columns: ['num_col2'],
                    primaryKey: false,
                    unique: false,
                    ignoreNulls: false,
                    required: false,
                },
            ]);
        } finally {
            await polish.close();
        }
    });

    it('reads Jet 3 primary-key index flags from the definition page', async () => {
        const session = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'size97.mdb'),
        });
        try {
            expect(session.listTableNames()).toEqual(['table1']);
            expect(session.listIndexes('table1')).toEqual([{
                name: 'PrimaryKey',
                columns: ['ID'],
                primaryKey: true,
                unique: true,
                ignoreNulls: false,
                required: true,
            }]);
        } finally {
            await session.close();
        }
    });

    it('reads the Access Required property separately from the nullable flag', async () => {
        const session = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'accessLike.mdb'),
        });
        try {
            expect(session.getTableDefinition('t_like1').columns).toMatchObject([
                { name: 'a1', nullable: true, defaultValue: '"rrr"', validationRule: 'CLng("a1")>2' },
                { name: 'a2', nullable: false },
            ]);
            expect(session.getTableDefinition('t_like2').columns).toMatchObject([
                { name: 'ID', nullable: true },
                { name: 'Campo1', nullable: true, defaultValue: '"campo1"', allowZeroLength: true },
                { name: 'Campo2', nullable: false, allowZeroLength: false },
                { name: 'Campo3', nullable: true, allowZeroLength: true },
            ]);
            // Absent properties stay undefined; Access' DAO default of False
            // is only reported when an explicit value is stored.
            expect(session.getTableDefinition('t_like2').columns[0].allowZeroLength).toBeUndefined();
        } finally {
            await session.close();
        }
    });

    it('reads column validation rules and AllowZeroLength from the property map', async () => {
        const session = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'accessLike.mdb'),
        });
        try {
            const like1 = session.getTableDefinition('t_like1');
            expect(like1.columns[0].validationRule).toBe('CLng("a1")>2');
            expect(like1.columns[0].validationText).toBeUndefined();
            expect(like1.columns[1].validationRule).toBeUndefined();
            // Record-level rules are only present in files that stored them;
            // the DAO gate covers that path against a live database.
            expect(like1.validationRule).toBeUndefined();
        } finally {
            await session.close();
        }
    });

    it('refuses to write a password-protected file', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-encrypted-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        try {
            // The reader accepts a password for an unencrypted file, so this
            // exercises the conservative write guard without shipping an
            // encrypted binary fixture.
            const session = await AccessFileSession.open({ filePath, password: 'secret', readOnly: false });
            try {
                await expect(session.writeAtomically(() => undefined))
                    .rejects.toBeInstanceOf(AccessFileEncryptedWriteError);
            } finally {
                await session.close();
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('refuses a staged write after the file changed on disk', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-changed-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                const later = new Date(Date.now() + 10_000);
                await fs.utimes(filePath, later, later);
                await expect(session.writeAtomically(() => undefined))
                    .rejects.toBeInstanceOf(AccessFileChangedError);
            } finally {
                await session.close();
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('does not install a staged file that cannot be read back', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-verify-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await expect(session.writeAtomically(async context => {
                    await fs.writeFile(context.stagedPath, Buffer.from('not an Access file'));
                })).rejects.toThrow(/cannot be read back/i);
            } finally {
                await session.close();
            }
            const after = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
            expect(after).toBe(before);
            const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.justybase-'));
            expect(leftovers).toEqual([]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('rejects a staged write whose table row count does not match the expectation', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-expect-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                const actual = session.getTableDefinition('t_people').rowCount;
                await expect(session.writeAtomically(async () => undefined, {
                    tableRowCounts: { t_people: actual + 1 },
                })).rejects.toThrow(/has \d+ rows, expected \d+/i);
            } finally {
                await session.close();
            }
            const after = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
            expect(after).toBe(before);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('checks for external changes after the writer ran', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-race-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await expect(session.writeAtomically(async () => {
                    const later = new Date(Date.now() + 10_000);
                    await fs.utimes(filePath, later, later);
                })).rejects.toBeInstanceOf(AccessFileChangedError);
            } finally {
                await session.close();
            }
            const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.justybase-'));
            expect(leftovers).toEqual([]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('accepts a valid complex-column database when verifyAllTables is set', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-complex-write-'));
        const filePath = path.join(directory, 'complex.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'complex.accdb'), filePath);
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await session.writeAtomically(async () => undefined, { verifyAllTables: true });
                expect(session.listTableNames()).toContain('ComplexFixture');
            } finally {
                await session.close();
            }
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps a recoverable backup when the platform refuses a one-step replace', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-fallback-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        let failedOnce = false;
        renameMock.mockImplementation(async (source: string, target: string) => {
            if (!failedOnce && String(source).endsWith('.tmp')) {
                failedOnce = true;
                const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
                error.code = 'EEXIST';
                throw error;
            }
            await realRename(source, target);
        });
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await session.writeAtomically(async () => undefined);
                expect(session.listTableNames()).toContain('t_people');
            } finally {
                await session.close();
            }
        } finally {
            renameMock.mockReset();
            renameMock.mockImplementation(realRename);
        }
        try {
            expect(failedOnce).toBe(true);
            const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.justybase-'));
            expect(leftovers).toEqual([]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('restores the original file when the fallback install also fails', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-fallback-fail-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
        renameMock.mockImplementation(async (source: string, target: string) => {
            if (String(source).endsWith('.tmp')) {
                const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
                error.code = 'EEXIST';
                throw error;
            }
            await realRename(source, target);
        });
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await expect(session.writeAtomically(async () => undefined)).rejects.toThrow(/EEXIST|exists/i);
            } finally {
                await session.close();
            }
        } finally {
            renameMock.mockReset();
            renameMock.mockImplementation(realRename);
        }
        try {
            const after = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
            expect(after).toBe(before);
            const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.justybase-'));
            expect(leftovers).toEqual([]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('removes the backup link without touching the original when the fallback restore is blocked', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-fallback-link-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
        // The staged rename cannot replace the existing file, and the restore
        // rename of the `.bak` link is refused as well.  The original file was
        // never moved, so the backup link must be removed instead of stranded.
        renameMock.mockImplementation(async (source: string, target: string) => {
            const name = String(source);
            if (name.endsWith('.tmp') || name.endsWith('.bak')) {
                const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
                error.code = 'EEXIST';
                throw error;
            }
            await realRename(source, target);
        });
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await expect(session.writeAtomically(async () => undefined)).rejects.toThrow(/EEXIST|exists/i);
            } finally {
                await session.close();
            }
        } finally {
            renameMock.mockReset();
            renameMock.mockImplementation(realRename);
        }
        try {
            const after = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
            expect(after).toBe(before);
            const leftovers = (await fs.readdir(directory)).filter(name => name.includes('.justybase-'));
            expect(leftovers).toEqual([]);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('reports the retained backup path when neither install nor restore can complete', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justybase-access-fallback-retained-'));
        const filePath = path.join(directory, 'sample.accdb');
        await fs.copyFile(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
        // No hard link is available, so the original is moved to the `.bak`
        // path.  Both the staged install and the restore then fail: the user
        // must get the preserved path instead of a generic rename error.
        linkMock.mockRejectedValueOnce(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
        renameMock.mockImplementation(async (source: string, target: string) => {
            const name = String(source);
            if (name.endsWith('.tmp') || name.endsWith('.bak')) {
                const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
                error.code = 'EEXIST';
                throw error;
            }
            await realRename(source, target);
        });
        try {
            const session = await AccessFileSession.open({ filePath, readOnly: false });
            try {
                await expect(session.writeAtomically(async () => undefined)).rejects.toThrow(
                    /EEXIST[\s\S]*preserved at [\s\S]*\.bak/,
                );
            } finally {
                await session.close();
            }
        } finally {
            renameMock.mockReset();
            renameMock.mockImplementation(realRename);
            linkMock.mockReset();
            linkMock.mockImplementation(realLink);
        }
        try {
            // The original was moved to the retained backup, so the target is
            // intentionally absent until the user moves the backup back.
            await expect(fs.access(filePath)).rejects.toThrow();
            const backups = (await fs.readdir(directory)).filter(name => name.endsWith('.bak'));
            expect(backups).toHaveLength(1);
            const retainedHash = createHash('sha256')
                .update(await fs.readFile(path.join(directory, backups[0]!)))
                .digest('hex');
            expect(retainedHash).toBe(before);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
