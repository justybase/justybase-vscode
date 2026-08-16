import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    AccessFileError,
    AccessFileReadOnlyError,
    AccessFileSession,
    ACCESS_COMPLEX_KIND,
    detectAccessFileFormat,
} from '../../packages/access-file/src';
import type { AccessComplexValue } from '../../packages/access-file/src';
import { serializeAccessComplexValue } from '../../packages/access-file/src/complexValues';
import { parseAccessPropertyMapDescription } from '../../packages/access-file/src/accessFileSession';

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
});
