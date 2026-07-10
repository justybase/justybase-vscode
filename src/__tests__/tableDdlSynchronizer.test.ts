import * as vscode from 'vscode';
import type { DatabaseConnection } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import { buildColumnCacheKey } from '../metadata/columnRowMapping';
import { MetadataCache } from '../metadata/cache/MetadataCache';
import { hasTreeReadyColumnCache } from '../metadata/cache/schemaTreeDataSource';
import { TableDdlSynchronizer } from '../metadata/tableDdlSynchronizer';
import type { SchemaProvider } from '../providers/schemaProvider';

jest.mock('vscode');
jest.unmock('chevrotain');

type Row = Record<string, unknown>;

interface ConnectionMockOptions {
    objectRows?: Row[];
    columnRows?: Row[];
    columnQueryError?: Error;
}

function isColumnCatalogQuery(sql: string): boolean {
    return sql.includes('AS TABLENAME') || sql.includes('_V_RELATION_COLUMN');
}

function isRuntimeContextQuery(sql: string): boolean {
    return sql.includes('CURRENT_CATALOG');
}

function isObjectCatalogQuery(sql: string): boolean {
    return sql.includes('_V_OBJECT_DATA');
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
    function createFixture(options: ConnectionMockOptions = {}) {
        const metadataCache = new MetadataCache({
            globalStorageUri: vscode.Uri.file('/tmp/table-ddl-synchronizer'),
        } as vscode.ExtensionContext);
        const connectionManager = {
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
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
});
