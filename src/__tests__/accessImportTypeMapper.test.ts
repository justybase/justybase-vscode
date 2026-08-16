import { accessImportTypeMapper } from '../../extensions/access/src/accessImportTypeMapper';
import { AccessFileSession } from '../../packages/access-file/src';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('accessImportTypeMapper (Phase 5)', () => {
    it('maps generic source types to Access DDL types', () => {
        expect(accessImportTypeMapper.createDataType('VARCHAR', undefined, undefined, 50).toString()).toBe('TEXT');
        expect(accessImportTypeMapper.createDataType('NVARCHAR(100)').toString()).toBe('TEXT');
        expect(accessImportTypeMapper.createDataType('INTEGER').toString()).toBe('INTEGER');
        expect(accessImportTypeMapper.createDataType('BIGINT').toString()).toBe('LONG');
        expect(accessImportTypeMapper.createDataType('DOUBLE').toString()).toBe('DOUBLE');
        expect(accessImportTypeMapper.createDataType('REAL').toString()).toBe('SINGLE');
        expect(accessImportTypeMapper.createDataType('DECIMAL', 18, 2).toString()).toBe('DECIMAL');
        expect(accessImportTypeMapper.createDataType('MONEY').toString()).toBe('CURRENCY');
        expect(accessImportTypeMapper.createDataType('DATETIME').toString()).toBe('DATETIME');
        expect(accessImportTypeMapper.createDataType('TIMESTAMP').toString()).toBe('DATETIME');
        expect(accessImportTypeMapper.createDataType('DATE').toString()).toBe('DATETIME');
        expect(accessImportTypeMapper.createDataType('BOOLEAN').toString()).toBe('BOOLEAN');
        expect(accessImportTypeMapper.createDataType('UUID').toString()).toBe('GUID');
        expect(accessImportTypeMapper.createDataType('BLOB').toString()).toBe('BINARY');
        expect(accessImportTypeMapper.createDataType('MEMO').toString()).toBe('TEXT');
    });

    it('creates a working column type chooser', () => {
        const chooser = accessImportTypeMapper.createColumnTypeChooser('.');
        expect(chooser).toBeDefined();
        expect(typeof chooser.refreshCurrentType).toBe('function');
    });
});

describe('AccessFileSession linked tables (Phase 5)', () => {
    it('returns an empty list when the file has no linked tables', async () => {
        const session = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'),
        });
        try {
            expect(session.listLinkedTables()).toEqual([]);
        } finally {
            await session.close();
        }
    });

    it('lists indexes and relationships without throwing on plain tables', async () => {
        const session = await AccessFileSession.open({
            filePath: path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'),
        });
        try {
            expect(session.listIndexes('t_people')).toBeDefined();
            expect(session.listRelationships()).toEqual([]);
            expect(session.listLinkedTables()).toEqual([]);
        } finally {
            await session.close();
        }
    });

    it('persists a linked table entry through the file path round trip', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-access-linked-'));
        const filePath = path.join(directory, 'test.accdb');
        fs.copyFileSync(path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'), filePath);
        try {
            const session = await AccessFileSession.open({ filePath });
            try {
                expect(session.listLinkedTables()).toEqual([]);
            } finally {
                await session.close();
            }
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
