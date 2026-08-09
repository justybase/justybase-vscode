import * as vscode from 'vscode';
import type { DatabaseConnection } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import { buildColumnCacheKey } from '../metadata/columnRowMapping';
import { MetadataCache } from '../metadata/cache/MetadataCache';
import { hasTreeReadyColumnCache } from '../metadata/cache/schemaTreeDataSource';
import { TableDdlSynchronizer } from '../metadata/tableDdlSynchronizer';
import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { accessDialect } from '../../extensions/access/src/accessDialect';
import type { SchemaProvider } from '../providers/schemaProvider';

jest.mock('vscode');
jest.unmock('chevrotain');

type Row = Record<string, unknown>;

interface ConnectionMockOptions {
    databaseKind?: 'netezza' | 'access';
    objectRows?: Row[];
    columnRows?: Row[];
    columnQueryError?: Error;
}

function isColumnCatalogQuery(sql: string): boolean {
    return sql.includes('AS TABLENAME')
        || sql.includes('_V_RELATION_COLUMN')
        || sql.includes('_access_metadata.columns');
}

function isRuntimeContextQuery(sql: string): boolean {
    return sql.includes('CURRENT_CATALOG');
}

function isObjectCatalogQuery(sql: string): boolean {
    return sql.includes('_V_OBJECT_DATA') || sql.includes('_access_metadata.object_type');
}

function createConnection(options: ConnectionMockOptions = {}): DatabaseConnection {
    const {
        objectRows = [],
        columnRows = [],
        columnQueryError,
    } = options;

    return {
        createCommand: (sql: string) => ({
            executeReader: async () => {
                if (columnQueryError && isColumnCatalogQuery(sql)) {
                    throw columnQueryError;
                }

                let rows: Row[];
                if (isRuntimeContextQuery(sql)) {
                    rows = [{ DATABASE: 'JUST_DATA', SCHEMA: 'ADMIN' }];
                } else if (isColumnCatalogQuery(sql)) {
                    rows = columnRows;
                } else if (isObjectCatalogQuery(sql)) {
                    rows = objectRows;
                } else {
                    rows = objectRows;
                }

                const columns = Object.keys(rows[0] ?? {});
                let rowIndex = -1;
                return {
                    fieldCount: columns.length,
                    getName: (index: number) => columns[index],
                    getValue: (index: number) => rows[rowIndex][columns[index]],
                    read: async () => {
                        rowIndex++;
                        return rowIndex < rows.length;
                    },
                    close: async () => undefined,
                };
            },
        }),
    } as unknown as DatabaseConnection;
}

describe('TableDdlSynchronizer', () => {
    beforeAll(() => {
        registerDatabaseDialect(accessDialect);
    });

    function createFixture(options: ConnectionMockOptions = {}) {
        const metadataCache = new MetadataCache({
            globalStorageUri: vscode.Uri.file('/tmp/table-ddl-synchronizer'),
        } as vscode.ExtensionContext);
        const connectionManager = {
            getConnectionDatabaseKind: jest.fn(() => options.databaseKind ?? 'netezza'),
        } as unknown as ConnectionManager;
        const schemaProvider = { refresh: jest.fn() } as unknown as SchemaProvider;
        const synchronizer = new TableDdlSynchronizer(
            {} as vscode.ExtensionContext,
            connectionManager,
            metadataCache,
            schemaProvider,
        );
        return {
            metadataCache,
            schemaProvider,
            synchronizer,
            connection: createConnection(options),
        };
    }

    it('upserts a created table and refreshes the tree', async () => {
        const fixture = createFixture({
            objectRows: [
                {
                    OBJNAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    OBJID: 42,
                    OBJTYPE: 'TABLE',
                    OWNER: 'ADMIN',
                    DESCRIPTION: '',
                },
            ],
            columnRows: [
                {
                    TABLENAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 0,
                },
            ],
        });

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'CREATE TABLE NEW_T (ID INTEGER)',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toEqual([
            expect.objectContaining({ OBJNAME: 'NEW_T', OBJID: 42, objType: 'TABLE' }),
        ]);
        expect(fixture.schemaProvider.refresh).toHaveBeenCalledTimes(1);
    });

    it('warms column cache in ATTNUM order after CREATE TABLE', async () => {
        const fixture = createFixture({
            objectRows: [
                {
                    OBJNAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    OBJID: 42,
                    OBJTYPE: 'TABLE',
                    OWNER: 'ADMIN',
                    DESCRIPTION: '',
                },
            ],
            columnRows: [
                {
                    TABLENAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'SECOND_COL',
                    FORMAT_TYPE: 'CHAR(1)',
                    IS_PK: 0,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 0,
                },
                {
                    TABLENAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'FIRST_COL',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 1,
                },
            ],
        });

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'CREATE TABLE NEW_T (FIRST_COL INTEGER, SECOND_COL CHAR(1))',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        const columnKey = buildColumnCacheKey('JUST_DATA', 'ADMIN', 'NEW_T');
        const columns = fixture.metadataCache.getColumns('CONN', columnKey);
        expect(hasTreeReadyColumnCache(columns)).toBe(true);
        expect(columns?.map(column => column.ATTNAME)).toEqual(['SECOND_COL', 'FIRST_COL']);
        expect(columns?.[0]).toEqual(expect.objectContaining({
            ATTNAME: 'SECOND_COL',
            isPk: false,
            isFk: false,
            isDistributionKey: false,
        }));
        expect(columns?.[1]).toEqual(expect.objectContaining({
            ATTNAME: 'FIRST_COL',
            isPk: true,
            isDistributionKey: true,
        }));
    });

    it('updates column cache after ALTER TABLE ADD COLUMN', async () => {
        const fixture = createFixture({
            objectRows: [
                {
                    OBJNAME: 'EXISTING_T',
                    SCHEMA: 'ADMIN',
                    OBJID: 7,
                    OBJTYPE: 'TABLE',
                    OWNER: 'ADMIN',
                    DESCRIPTION: '',
                },
            ],
            columnRows: [
                {
                    TABLENAME: 'EXISTING_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 0,
                },
                {
                    TABLENAME: 'EXISTING_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'NAME',
                    FORMAT_TYPE: 'VARCHAR(50)',
                    IS_PK: 0,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 0,
                },
            ],
        });
        fixture.metadataCache.setTables(
            'CONN',
            'JUST_DATA.ADMIN',
            [{ OBJNAME: 'EXISTING_T', SCHEMA: 'ADMIN', OBJID: 7, objType: 'TABLE', label: 'EXISTING_T' }],
            new Map(),
        );
        fixture.metadataCache.setColumns(
            'CONN',
            buildColumnCacheKey('JUST_DATA', 'ADMIN', 'EXISTING_T'),
            [{ ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER', isPk: true, isFk: false, isDistributionKey: false }],
        );

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'ALTER TABLE EXISTING_T ADD COLUMN NAME VARCHAR(50)',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        const columns = fixture.metadataCache.getColumns(
            'CONN',
            buildColumnCacheKey('JUST_DATA', 'ADMIN', 'EXISTING_T'),
        );
        expect(columns?.map(column => column.ATTNAME)).toEqual(['ID', 'NAME']);
    });

    it('keeps table metadata when column warmup query fails', async () => {
        const fixture = createFixture({
            objectRows: [
                {
                    OBJNAME: 'NEW_T',
                    SCHEMA: 'ADMIN',
                    OBJID: 42,
                    OBJTYPE: 'TABLE',
                    OWNER: 'ADMIN',
                    DESCRIPTION: '',
                },
            ],
            columnQueryError: new Error('catalog timeout'),
        });

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'CREATE TABLE NEW_T (ID INTEGER)',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toEqual([
            expect.objectContaining({ OBJNAME: 'NEW_T' }),
        ]);
        expect(
            fixture.metadataCache.getColumns(
                'CONN',
                buildColumnCacheKey('JUST_DATA', 'ADMIN', 'NEW_T'),
            ),
        ).toBeUndefined();
        expect(fixture.schemaProvider.refresh).toHaveBeenCalledTimes(1);
    });

    it('buffers DDL until COMMIT and discards it on ROLLBACK', async () => {
        const fixture = createFixture({
            objectRows: [{ OBJNAME: 'TX_T', SCHEMA: 'ADMIN', OBJID: 43, OBJTYPE: 'TABLE' }],
            columnRows: [
                {
                    TABLENAME: 'TX_T',
                    SCHEMA: 'ADMIN',
                    DBNAME: 'JUST_DATA',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 0,
                    IS_FK: 0,
                    IS_DISTRIBUTION_KEY: 0,
                },
            ],
        });
        const base = {
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        };

        await fixture.synchronizer.handleStatementSucceeded({ ...base, sql: 'BEGIN' });
        await fixture.synchronizer.handleStatementSucceeded({
            ...base,
            sql: 'CREATE TABLE TX_T (ID INTEGER)',
        });
        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toBeUndefined();
        await fixture.synchronizer.handleStatementSucceeded({ ...base, sql: 'ROLLBACK' });
        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toBeUndefined();

        await fixture.synchronizer.handleStatementSucceeded({ ...base, sql: 'BEGIN' });
        await fixture.synchronizer.handleStatementSucceeded({
            ...base,
            sql: 'CREATE TABLE TX_T (ID INTEGER)',
        });
        await fixture.synchronizer.handleStatementSucceeded({ ...base, sql: 'COMMIT' });
        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toEqual([
            expect.objectContaining({ OBJNAME: 'TX_T' }),
        ]);
        expect(
            fixture.metadataCache.getColumns(
                'CONN',
                buildColumnCacheKey('JUST_DATA', 'ADMIN', 'TX_T'),
            )?.map(column => column.ATTNAME),
        ).toEqual(['ID']);
    });

    it('removes dropped tables and their cached columns', async () => {
        const fixture = createFixture();
        fixture.metadataCache.setTables(
            'CONN',
            'JUST_DATA.ADMIN',
            [{ OBJNAME: 'OLD_T', SCHEMA: 'ADMIN', OBJID: 1, objType: 'TABLE', label: 'OLD_T' }],
            new Map(),
        );
        fixture.metadataCache.setColumns(
            'CONN',
            'JUST_DATA.ADMIN.OLD_T',
            [{ ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER' }],
        );

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'DROP TABLE OLD_T',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getTables('CONN', 'JUST_DATA.ADMIN')).toEqual([]);
        expect(fixture.metadataCache.getColumns('CONN', 'JUST_DATA.ADMIN.OLD_T')).toBeUndefined();
    });

    it('synchronizes Access CREATE TABLE through the flat default.. marker catalog', async () => {
        const fixture = createFixture({
            databaseKind: 'access',
            objectRows: [
                { OBJNAME: 'NEW_T', OBJID: 42, OBJTYPE: 'TABLE', SCHEMA: null },
            ],
            columnRows: [
                {
                    DATABASE: 'default',
                    SCHEMA: null,
                    TABLENAME: 'NEW_T',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                },
            ],
        });
        fixture.metadataCache.setTables('CONN', 'default..', [
            { OBJNAME: 'SAVED_QUERY', label: 'SAVED_QUERY', objType: 'VIEW', SCHEMA: undefined },
        ], new Map());

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'CREATE TABLE NEW_T (ID INTEGER)',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getTables('CONN', 'default..')).toEqual([
            expect.objectContaining({ OBJNAME: 'SAVED_QUERY', objType: 'VIEW' }),
            expect.objectContaining({ OBJNAME: 'NEW_T', objType: 'TABLE' }),
        ]);
        expect(fixture.metadataCache.getTables('CONN', 'default.default')).toBeUndefined();
        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..NEW_T')).toEqual([
            expect.objectContaining({ ATTNAME: 'ID', isPk: true }),
        ]);
        expect(fixture.schemaProvider.refresh).toHaveBeenCalledTimes(1);
    });

    it('removes an Access table, qualified indexes, and columns after DROP TABLE', async () => {
        const fixture = createFixture({
            databaseKind: 'access',
            objectRows: [],
        });
        fixture.metadataCache.setTables('CONN', 'default..', [
            { OBJNAME: 'OLD_T', label: 'OLD_T', OBJID: 1, objType: 'TABLE', SCHEMA: undefined },
            { OBJNAME: 'SAVED_QUERY', label: 'SAVED_QUERY', OBJID: 9, objType: 'VIEW', SCHEMA: undefined },
        ], new Map([
            ['default..OLD_T', 1],
            ['default..SAVED_QUERY', 9],
        ]));
        fixture.metadataCache.setColumns('CONN', 'DEFAULT..OLD_T', [
            { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER' },
        ]);

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'DROP TABLE OLD_T',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getTables('CONN', 'default..')).toEqual([
            expect.objectContaining({ OBJNAME: 'SAVED_QUERY', objType: 'VIEW' }),
        ]);
        expect(fixture.metadataCache.findTableId('CONN', 'DEFAULT..OLD_T')).toBeUndefined();
        expect(fixture.metadataCache.findObjectWithType('CONN', 'DEFAULT', undefined, 'OLD_T')).toBeUndefined();
        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..OLD_T')).toBeUndefined();
    });

    it('refreshes Access columns after ALTER TABLE through the Access marker provider', async () => {
        const fixture = createFixture({
            databaseKind: 'access',
            objectRows: [
                { OBJNAME: 'EXISTING_T', OBJID: 7, OBJTYPE: 'TABLE', SCHEMA: null },
            ],
            columnRows: [
                {
                    DATABASE: 'default',
                    SCHEMA: null,
                    TABLENAME: 'EXISTING_T',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                },
                {
                    DATABASE: 'default',
                    SCHEMA: null,
                    TABLENAME: 'EXISTING_T',
                    ATTNAME: 'NAME',
                    FORMAT_TYPE: 'TEXT',
                    IS_PK: 0,
                    IS_FK: 0,
                },
            ],
        });
        fixture.metadataCache.setTables('CONN', 'default..', [
            { OBJNAME: 'EXISTING_T', label: 'EXISTING_T', objType: 'TABLE', SCHEMA: undefined },
        ], new Map());
        fixture.metadataCache.setColumns('CONN', 'DEFAULT..EXISTING_T', [
            { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER' },
        ]);

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'ALTER TABLE EXISTING_T ADD COLUMN NAME TEXT',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..EXISTING_T')?.map(column => column.ATTNAME))
            .toEqual(['ID', 'NAME']);
    });

    it('defers Access rename cache changes until COMMIT and removes the old identity', async () => {
        const fixture = createFixture({
            databaseKind: 'access',
            objectRows: [
                { OBJNAME: 'RENAMED_T', OBJID: 8, OBJTYPE: 'TABLE', SCHEMA: null },
            ],
            columnRows: [
                {
                    DATABASE: 'default',
                    SCHEMA: null,
                    TABLENAME: 'RENAMED_T',
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    IS_PK: 1,
                    IS_FK: 0,
                },
            ],
        });
        fixture.metadataCache.setTables('CONN', 'default..', [
            { OBJNAME: 'OLD_T', label: 'OLD_T', OBJID: 7, objType: 'TABLE', SCHEMA: undefined },
            { OBJNAME: 'SAVED_QUERY', label: 'SAVED_QUERY', objType: 'VIEW', SCHEMA: undefined },
        ], new Map([
            ['default..OLD_T', 7],
            ['default..SAVED_QUERY', 9],
        ]));
        fixture.metadataCache.setColumns('CONN', 'DEFAULT..OLD_T', [
            { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER' },
        ]);

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'BEGIN',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });
        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'ALTER TABLE OLD_T RENAME TO RENAMED_T',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.findTableId('CONN', 'DEFAULT..OLD_T')).toBe(7);
        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..OLD_T')).toBeDefined();

        await fixture.synchronizer.handleStatementSucceeded({
            sql: 'COMMIT',
            connectionName: 'CONN',
            documentUri: 'file:///query.sql',
            connection: fixture.connection,
        });

        expect(fixture.metadataCache.findTableId('CONN', 'DEFAULT..OLD_T')).toBeUndefined();
        expect(fixture.metadataCache.findTableId('CONN', 'DEFAULT..RENAMED_T')).toBe(8);
        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..OLD_T')).toBeUndefined();
        expect(fixture.metadataCache.getColumns('CONN', 'DEFAULT..RENAMED_T'))
            .toEqual([expect.objectContaining({ ATTNAME: 'ID' })]);
        expect(fixture.metadataCache.getTables('CONN', 'default..')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ OBJNAME: 'SAVED_QUERY', objType: 'VIEW' }),
            ]),
        );
    });
});
