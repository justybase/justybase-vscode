import type { DatabaseConnectionConfig } from '../contracts/database';
import { AccessConnection, splitAccessStatements, writeTargetTableName } from '../../extensions/access/src/accessConnection';
import { accessMetadataProvider } from '../../extensions/access/src/accessSchemaProvider';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

jest.mock('node:fs/promises', () => {
    const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: jest.fn(actual.open) };
});


function createConnection(overrides: Partial<DatabaseConnectionConfig> = {}): AccessConnection {
    return new AccessConnection({
        host: '',
        database: '/data/klienci.accdb',
        user: '',
        options: { readOnly: true },
        ...overrides,
    });
}

async function rawResult(connection: AccessConnection, sql: string): Promise<Awaited<ReturnType<AccessConnection['executeRaw']>>> {
    return connection.executeRaw(sql);
}

describe('AccessConnection native compatibility commands', () => {
    it('uses the Access file name as the catalog and a flat default schema', () => {
        const connection = createConnection({ database: '/data/monthly-report.accdb' });

        expect(connection.getCurrentCatalog()).toBe('monthly-report');
        expect(connection.getCurrentSchema()).toBe('default');
    });

    it('synthesizes CURRENT_SID locally', async () => {
        const result = await rawResult(createConnection(), 'SELECT CURRENT_SID');

        expect(result.columns[0]?.name).toBe('CURRENT_SID');
        expect(result.rows?.[0]?.[0]).toMatch(/^access-\d+-\d+$/);
    });

    it('synthesizes CURRENT_CATALOG and CURRENT_SCHEMA locally', async () => {
        const connection = createConnection();

        const catalog = await rawResult(connection, 'SELECT CURRENT_CATALOG');
        const schema = await rawResult(connection, 'SELECT CURRENT_SCHEMA');
        const both = await rawResult(connection, 'SELECT CURRENT_CATALOG, CURRENT_SCHEMA');

        expect(catalog.rows?.[0]?.[0]).toBe('klienci');
        expect(schema.rows?.[0]?.[0]).toBe('default');
        expect(both.columns.map(column => column.name)).toEqual(['CURRENT_CATALOG', 'CURRENT_SCHEMA']);
    });

    it('parses escaped closing brackets in identity aliases', async () => {
        const connection = createConnection();
        const result = await rawResult(connection, 'SELECT @@IDENTITY AS [a]]b]');
        expect(result.columns[0]?.name).toBe('a]b');
    });

    it('no-ops SET CATALOG and SET SCHEMA', async () => {
        const connection = createConnection();

        await expect(rawResult(connection, 'SET CATALOG other')).resolves.toMatchObject({ rows: [], recordsAffected: 0 });
        await expect(rawResult(connection, 'SET SCHEMA other')).resolves.toMatchObject({ rows: [], recordsAffected: 0 });
    });

    it('returns an empty result for blank SQL', async () => {
        await expect(rawResult(createConnection(), '   ')).resolves.toMatchObject({ columns: [], rows: [], recordsAffected: -1 });
    });

    it('blocks writes while the connection is read-only', async () => {
        await expect(rawResult(createConnection(), "UPDATE Klienci SET Imie = 'blocked'"))
            .rejects.toThrow(/read-only/);
    });

    it('requires an open native session before executing ordinary SQL', async () => {
        await expect(rawResult(createConnection(), 'SELECT 1')).rejects.toThrow(/mirror is not open/);
    });
});

describe('AccessConnection statement splitting and locking', () => {
    it('parses escaped closing brackets in write targets', () => {
        expect(writeTargetTableName('INSERT INTO [a]]b] (id) VALUES (1)')).toBe('a]b');
        expect(writeTargetTableName('UPDATE [a]]b] SET id = 2')).toBe('a]b');
        expect(writeTargetTableName('DELETE FROM [a]]b] WHERE id = 2')).toBe('a]b');
    });

    it('splits multi-statement scripts at top-level semicolons', async () => {
        const connection = createConnection();
        // the first statement is a write, which must be rejected as read-only
        // even though the script also contains SELECTs
        const multi = 'UPDATE Klienci SET Imie = 1; SELECT 1;';
        await expect(rawResult(connection, multi)).rejects.toThrow(/read-only/);
    });

    it('keeps semicolons inside string literals and date literals intact', async () => {
        const connection = createConnection();
        await expect(rawResult(connection, "SELECT 'a;b' AS [v];")).rejects.toThrow(/mirror is not open/);
        await expect(rawResult(connection, 'SELECT #2024-01-01 10:00:00# AS [d];')).rejects.toThrow(/mirror is not open/);
    });

    it('ignores comment-only fragments after a statement', async () => {
        const connection = createConnection();

        const result = await rawResult(connection, 'SELECT CURRENT_SID; -- trailing comment');

        expect(result.rows?.[0]?.[0]).toMatch(/^access-/);
    });

    it('handles escaped closing brackets in identifiers', () => {
        expect(splitAccessStatements('SELECT [semi]];colon]; SELECT 2;')).toEqual([
            'SELECT [semi]];colon]',
            'SELECT 2',
        ]);
        expect(splitAccessStatements('-- comment only\n/* another comment */;')).toEqual([]);
    });

    it('requires an open native session before executing a write', async () => {
        const connection = createConnection({ options: { readOnly: false } });

        await expect(rawResult(connection, "UPDATE Klienci SET Imie = 'allowed'"))
            .rejects.toThrow(/connection is not open/);
    });

    it('refuses writable connections when the sidecar lock cannot be created', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const openMock = fsPromises.open as jest.MockedFunction<typeof fsPromises.open>;
        openMock.mockRejectedValueOnce(error);
        try {
            const connection = createConnection({
                database: path.join(__dirname, 'fixtures', 'access', 'sample2007.accdb'),
                options: { readOnly: false },
            });
            await expect(connection.connect()).rejects.toThrow(/lock file.*refused/i);
        } finally {
            openMock.mockClear();
        }
    });
});

describe('accessMetadataProvider', () => {
    it('routes metadata queries through the native Access marker catalog', () => {
        expect(accessMetadataProvider.buildListTablesQuery('default')).toContain('_access_metadata.tables');
        expect(accessMetadataProvider.buildListViewsQuery('default')).toContain('_access_metadata.views');
        expect(accessMetadataProvider.buildListDatabasesQuery()).toContain('_access_metadata.databases');
        expect(accessMetadataProvider.buildTypeGroupsQuery('default')).toContain('_access_metadata.type_groups');
        expect(accessMetadataProvider.buildListProceduresQuery('default')).toContain('_access_metadata.procedures');
    });

    it('embeds and escapes table names in column markers', () => {
        const query = accessMetadataProvider.buildColumnsWithKeysQuery('default', {
            schema: 'default',
            tableName: "O'Reilly",
            objTypes: ['TABLE', 'INDEX', 'VIEW'],
        });

        expect(query).toContain("TABLE = 'O''Reilly'");
        expect(query).toContain("OBJTYPES = 'TABLE,VIEW'");
        expect(query).not.toContain('INDEX');
    });

    it('produces source-search markers with the server-side filter flag', () => {
        const query = accessMetadataProvider.buildViewSourceSearchQuery('default', {
            rawTerm: 'CUSTOMERS',
            likePattern: '%CUSTOMERS%',
            useServerSideFilter: true,
        });

        expect(query).toContain('SERVER_SIDE = 1');
        expect(query).toContain("PATTERN = '%CUSTOMERS%'");
    });

    it('uses a safe table marker when no table name is provided', () => {
        expect(accessMetadataProvider.buildColumnsWithKeysQuery('default')).toBe(
            "SELECT * FROM _access_metadata.columns WHERE TABLE = '' AND OBJTYPES = 'TABLE,VIEW'",
        );
    });
});
