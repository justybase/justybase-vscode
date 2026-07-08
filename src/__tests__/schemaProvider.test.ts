/**
 * Unit tests for SchemaProvider
 * Tests tree data provider functionality, schema hierarchy, and SchemaItem
 */

import * as vscode from 'vscode';
import { SchemaProvider, SchemaItem } from '../providers/schemaProvider';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';

// Mock dependencies
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result) => {
        if (!result || !result.data) return [];
        return result.data.map((row: unknown[]) => {
            const obj: Record<string, unknown> = {};
            if (result.columns) {
                result.columns.forEach((col: { name: string }, i: number) => {
                    obj[col.name] = row[i];
                });
            }
            return obj;
        });
    })
}));

jest.mock('../providers/tableMetadataProvider', () => ({
    buildColumnMetadataQuery: jest.fn(() => 'SELECT * FROM columns'),
    parseColumnMetadata: jest.fn(() => [])
}));

// Import mocked modules
import { runQueryRaw, queryResultToRows } from '../core/queryRunner';

describe('SchemaProvider', () => {
    let schemaProvider: SchemaProvider;
    let mockContext: vscode.ExtensionContext;
    let mockConnectionManager: jest.Mocked<ConnectionManager>;
    let mockMetadataCache: jest.Mocked<MetadataCache>;
    let secretsStore: Map<string, string>;
    let globalState: Map<string, unknown>;

    beforeEach(() => {
        jest.clearAllMocks();

        secretsStore = new Map();
        globalState = new Map();

        mockContext = {
            secrets: {
                get: jest.fn(async (key: string) => secretsStore.get(key)),
                store: jest.fn(async (key: string, value: string) => {
                    secretsStore.set(key, value);
                }),
                delete: jest.fn(async (key: string) => {
                    secretsStore.delete(key);
                })
            },
            globalState: {
                get: jest.fn((key: string) => globalState.get(key)),
                update: jest.fn(async (key: string, value: unknown) => {
                    if (value === undefined) {
                        globalState.delete(key);
                    } else {
                        globalState.set(key, value);
                    }
                })
            },
            extensionUri: { fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri,
            subscriptions: [],
            asAbsolutePath: jest.fn((relativePath: string) => `/test/${relativePath}`)
        } as unknown as vscode.ExtensionContext;

        // Mock ConnectionManager
        mockConnectionManager = {
            getConnections: jest.fn().mockResolvedValue([
                { name: 'TestConnection', host: 'localhost', port: 5480, database: 'TESTDB', user: 'admin' }
            ]),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            getConnection: jest.fn().mockResolvedValue({
                name: 'TestConnection',
                host: 'localhost',
                port: 5480,
                database: 'TESTDB',
                user: 'admin'
            }),
            ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
            getConnectionForExecution: jest.fn().mockReturnValue('TestConnection'),
            onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            dispose: jest.fn()
        } as unknown as jest.Mocked<ConnectionManager>;

        // Mock MetadataCache
        mockMetadataCache = {
            getDatabases: jest.fn().mockReturnValue(null),
            setDatabases: jest.fn(),
            getTypeGroups: jest.fn().mockReturnValue(null),
            setTypeGroups: jest.fn(),
            hasCachedTypeGroups: jest.fn().mockReturnValue(false),
            getObjectsWithSchema: jest.fn().mockReturnValue(null),
            getObjectsByType: jest.fn().mockReturnValue(undefined),
            getProcedures: jest.fn().mockReturnValue(undefined),
            getProceduresForDatabase: jest.fn().mockReturnValue(undefined),
            setProcedures: jest.fn(),
            isProcedureCatalogLoaded: jest.fn().mockReturnValue(false),
            markProcedureCatalogLoaded: jest.fn(),
            markObjectsCatalogLoaded: jest.fn(),
            areObjectsCatalogLoadedForDatabase: jest.fn().mockReturnValue(false),
            getTables: jest.fn().mockReturnValue(undefined),
            setTables: jest.fn(),
            getColumns: jest.fn().mockReturnValue(null),
            setColumns: jest.fn(),
            hasConnectionPrefetchTriggered: jest.fn().mockReturnValue(false),
            isConnectionPrefetchFresh: jest.fn().mockReturnValue(false),
            whenDiskReady: jest.fn().mockResolvedValue(undefined),
            triggerConnectionPrefetch: jest.fn(),
            onDidExternalRefresh: jest.fn().mockReturnValue({ dispose: jest.fn() }),
            ensureColumnsLoadedForTableKey: jest.fn().mockResolvedValue(undefined)
        } as unknown as jest.Mocked<MetadataCache>;

        schemaProvider = new SchemaProvider(
            mockContext,
            mockConnectionManager,
            mockMetadataCache
        );
    });

    describe('constructor', () => {
        it('should subscribe to connection changes', () => {
            expect(mockConnectionManager.onDidChangeConnections).toHaveBeenCalled();
        });
    });

    describe('refresh', () => {
        it('should fire onDidChangeTreeData event', () => {
            const listener = jest.fn();
            schemaProvider.onDidChangeTreeData(listener);

            schemaProvider.refresh();

            expect(listener).toHaveBeenCalled();
        });
    });

    describe('getTreeItem', () => {
        it('should return the same element', () => {
            const item = new SchemaItem(
                'TestDB',
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                'TestDB'
            );

            const result = schemaProvider.getTreeItem(item);

            expect(result).toBe(item);
        });
    });

    describe('getChildren - root level', () => {
        it('should return server instances at root', async () => {
            const children = await schemaProvider.getChildren();

            // 1 connection + Favorites = 2 items
            expect(children).toHaveLength(2);
            expect(mockConnectionManager.ensureFullyLoaded).toHaveBeenCalled();
            expect(children[0].label).toBe('TestConnection');
            expect(children[0].contextValue).toBe('serverInstance');
            expect(children[0].resourceUri?.toString()).toBe('netezza-connection-accent:/TestConnection');
            expect(children[1].label).toBe('Favorites');
            expect(children[1].contextValue).toBe('favoritesRoot');
        });

        it('should return empty array when no connections', async () => {
            mockConnectionManager.getConnections.mockResolvedValue([]);

            const children = await schemaProvider.getChildren();

            // Only Favorites = 1 item
            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('Favorites');
            expect(children[0].contextValue).toBe('favoritesRoot');
        });

        it('should set custom icon for server instances', async () => {
            const children = await schemaProvider.getChildren();

            // Should have iconPath set (from asAbsolutePath)
            expect(children[0]).toBeDefined();
        });
    });

    describe('getChildren - databases level', () => {
        let serverItem: SchemaItem;

        beforeEach(() => {
            serverItem = new SchemaItem(
                'TestConnection',
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
        });

        it('should return databases from cache when available', async () => {
            mockMetadataCache.getDatabases.mockReturnValue([
                { DATABASE: 'DB1', label: 'DB1', kind: 9, detail: 'Database' },
                { DATABASE: 'DB2', label: 'DB2', kind: 9, detail: 'Database' }
            ]);

            const children = await schemaProvider.getChildren(serverItem);

            expect(children).toHaveLength(2);
            expect(children[0].label).toBe('DB1');
            expect(children[0].contextValue).toBe('database');
            expect(mockMetadataCache.getDatabases).toHaveBeenCalledWith('TestConnection');
        });

        it('should query databases when not in cache', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'DATABASE' }],
                data: [['SYSTEM'], ['TESTDB']]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { DATABASE: 'SYSTEM' },
                { DATABASE: 'TESTDB' }
            ]);

            const children = await schemaProvider.getChildren(serverItem);

            expect(children).toHaveLength(2);
            expect(runQueryRaw).toHaveBeenCalled();
            expect(mockMetadataCache.setDatabases).toHaveBeenCalled();
        });

        it('should return empty array when connection name is missing', async () => {
            const itemWithoutConnection = new SchemaItem(
                'TestConnection',
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance'
            );

            const children = await schemaProvider.getChildren(itemWithoutConnection);

            expect(children).toHaveLength(0);
        });

        it('should handle query errors gracefully', async () => {
            (runQueryRaw as jest.Mock).mockRejectedValue(new Error('Connection failed'));

            const children = await schemaProvider.getChildren(serverItem);

            expect(children).toHaveLength(1);
            expect(children[0].contextValue).toBe('schemaError');
            expect(children[0].label).toContain('Connection failed');
            expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        });

        it('should fail loudly when the connection kind is unresolved instead of defaulting to Netezza', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue(undefined);

            const children = await schemaProvider.getChildren(serverItem);

            expect(children).toHaveLength(1);
            expect(children[0].contextValue).toBe('schemaError');
            expect(children[0].label).toContain('missing a database type');
            expect(runQueryRaw).not.toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining('missing a database type')
            );
        });
    });

    describe('getChildren - type groups level', () => {
        let databaseItem: SchemaItem;

        beforeEach(() => {
            databaseItem = new SchemaItem(
                'TESTDB',
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                'TESTDB',
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
        });

        it('should return type groups from cache when available', async () => {
            mockMetadataCache.getTypeGroups.mockReturnValue(['TABLE', 'VIEW', 'PROCEDURE']);
            mockMetadataCache.hasCachedTypeGroups.mockReturnValue(true);

            const children = await schemaProvider.getChildren(databaseItem);

            expect(children).toHaveLength(3);
            expect(children[0].label).toBe('TABLE');
            expect(children[0].contextValue).toBe('typeGroup:TABLE');
        });

        it('should scope Snowflake dynamic table type groups to the Snowflake provider', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('snowflake');
            mockMetadataCache.getTypeGroups.mockReturnValue(['TABLE', 'DYNAMIC TABLE']);
            mockMetadataCache.hasCachedTypeGroups.mockReturnValue(true);

            const children = await schemaProvider.getChildren(databaseItem);

            const dynamicTableGroup = children.find((child) => child.label === 'DYNAMIC TABLE');
            expect(dynamicTableGroup).toBeDefined();
            expect(dynamicTableGroup?.contextValue).toBe('typeGroup:DYNAMIC TABLE:snowflake');
        });

        it('should query type groups when not in cache', async () => {
            // getTypeGroups returns defaults when not cached, so we need to mock hasCachedTypeGroups as false
            mockMetadataCache.hasCachedTypeGroups.mockReturnValue(false);
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'OBJTYPE' }],
                data: [['TABLE'], ['VIEW']]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJTYPE: 'TABLE' },
                { OBJTYPE: 'VIEW' }
            ]);

            const children = await schemaProvider.getChildren(databaseItem);

            expect(children).toHaveLength(2);
            expect(mockMetadataCache.setTypeGroups).toHaveBeenCalled();
        });

        it('should trigger database prefetch', async () => {
            mockMetadataCache.getTypeGroups.mockReturnValue(['TABLE']);
            mockMetadataCache.hasCachedTypeGroups.mockReturnValue(true);

            await schemaProvider.getChildren(databaseItem);

            expect(mockMetadataCache.isConnectionPrefetchFresh).toHaveBeenCalledWith('TestConnection');
        });

        it('should skip legacy connection prefetch for DB2 databases', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('db2');
            mockMetadataCache.getTypeGroups.mockReturnValue(['TABLE']);
            mockMetadataCache.hasCachedTypeGroups.mockReturnValue(true);

            await schemaProvider.getChildren(databaseItem);

            expect(mockMetadataCache.isConnectionPrefetchFresh).not.toHaveBeenCalled();
            expect(mockMetadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        });
    });

    describe('getChildren - objects level', () => {
        let typeGroupItem: SchemaItem;

        beforeEach(() => {
            typeGroupItem = new SchemaItem(
                'TABLE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:TABLE',
                'TESTDB',
                'TABLE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
        });

        it('should return objects from cache for TABLE type', async () => {
            mockMetadataCache.getObjectsByType.mockReturnValue([
                { schema: 'PUBLIC', objId: 1, item: { label: 'USERS', objType: 'TABLE', kind: 7 } },
                { schema: 'PUBLIC', objId: 2, item: { label: 'ORDERS', objType: 'TABLE', kind: 7 } }
            ]);

            const children = await schemaProvider.getChildren(typeGroupItem);

            expect(children).toHaveLength(2);
            expect(children[0].label).toBe('USERS');
            expect(children[0].contextValue).toBe('netezza:TABLE');
        });

        it('should query objects when not in cache', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['USERS', 'PUBLIC', 1, 'User table', 'ADMIN'],
                    ['ORDERS', 'PUBLIC', 2, 'Orders table', 'ADMIN']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'USERS', SCHEMA: 'PUBLIC', OBJID: 1, DESCRIPTION: 'User table', OWNER: 'ADMIN' },
                { OBJNAME: 'ORDERS', SCHEMA: 'PUBLIC', OBJID: 2, DESCRIPTION: 'Orders table', OWNER: 'ADMIN' }
            ]);

            const children = await schemaProvider.getChildren(typeGroupItem);

            expect(children).toHaveLength(2);
            expect(children[0].label).toBe('USERS');
            expect(children[0].schema).toBe('PUBLIC');
            expect(children[0].owner).toBe('ADMIN');
            expect(children[0].description).toBe('(PUBLIC) - User table');
            expect(children[0].tooltip).toContain('User table');
        });

        it('should scope Snowflake dynamic table objects to the Snowflake provider', async () => {
            const dynamicTableItem = new SchemaItem(
                'DYNAMIC TABLE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:DYNAMIC TABLE:snowflake',
                'TESTDB',
                'DYNAMIC TABLE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('snowflake');
            mockMetadataCache.getObjectsByType.mockReturnValue([
                { schema: 'PUBLIC', objId: 1, item: { label: 'ORDERS_DYNAMIC', objType: 'DYNAMIC TABLE', kind: 7 } }
            ]);

            const children = await schemaProvider.getChildren(dynamicTableItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('ORDERS_DYNAMIC');
            expect(children[0].contextValue).toBe('netezza:DYNAMIC TABLE:snowflake');
        });

        it('should merge table-like cache updates without dropping other object types', async () => {
            mockMetadataCache.getTables.mockReturnValue([
                {
                    OBJNAME: 'REMOTE_CUSTOMERS',
                    OBJID: 99,
                    SCHEMA: 'PUBLIC',
                    label: 'REMOTE_CUSTOMERS',
                    objType: 'NICKNAME',
                    kind: vscode.CompletionItemKind.Class,
                    detail: 'NICKNAME (PUBLIC)'
                }
            ]);

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['USERS', 'PUBLIC', 1, 'User table', 'ADMIN']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'USERS', SCHEMA: 'PUBLIC', OBJID: 1, DESCRIPTION: 'User table', OWNER: 'ADMIN' }
            ]);

            await schemaProvider.getChildren(typeGroupItem);

            expect(mockMetadataCache.setTables).toHaveBeenCalledWith(
                'TestConnection',
                'TESTDB.PUBLIC',
                expect.arrayContaining([
                    expect.objectContaining({ label: 'USERS', objType: 'TABLE', OBJID: 1 }),
                    expect.objectContaining({ label: 'REMOTE_CUSTOMERS', objType: 'NICKNAME', OBJID: 99 })
                ]),
                expect.any(Map),
                undefined,
            );

            const idMap = (mockMetadataCache.setTables as jest.Mock).mock.calls[0][3] as Map<string, number>;
            expect(Array.from(idMap.values()).sort((left, right) => left - right)).toEqual([1, 99]);
        });

        it('should query DB2 views live when a partial table cache reports the group as empty', async () => {
            const viewItem = new SchemaItem(
                'VIEW',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:VIEW',
                'TESTDB',
                'VIEW',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('db2');
            mockMetadataCache.getObjectsByType.mockReturnValue([]);
            (
                schemaProvider as unknown as {
                    getMetadataProvider: () => { buildObjectTypeQuery: () => string };
                }
            ).getMetadataProvider = jest.fn(() => ({
                buildObjectTypeQuery: () => 'SELECT DB2 VIEWS'
            }));

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['EMP_VIEW', 'DB2INST1', 7, 'Employee view', 'DB2INST1']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'EMP_VIEW', SCHEMA: 'DB2INST1', OBJID: 7, DESCRIPTION: 'Employee view', OWNER: 'DB2INST1' }
            ]);

            const children = await schemaProvider.getChildren(viewItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('EMP_VIEW');
            expect(children[0].contextValue).toBe('netezza:VIEW');
            expect(runQueryRaw).toHaveBeenCalled();
        });

        it('should query PostgreSQL views live when a partial table cache reports the group as empty', async () => {
            const viewItem = new SchemaItem(
                'VIEW',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:VIEW',
                'TESTDB',
                'VIEW',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
            mockMetadataCache.getObjectsByType.mockReturnValue([]);
            (
                schemaProvider as unknown as {
                    getMetadataProvider: () => { buildObjectTypeQuery: () => string };
                }
            ).getMetadataProvider = jest.fn(() => ({
                buildObjectTypeQuery: () => 'SELECT POSTGRESQL VIEWS'
            }));

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['v_user_orders', 'public', 7, 'User orders view', 'postgres']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'v_user_orders', SCHEMA: 'public', OBJID: 7, DESCRIPTION: 'User orders view', OWNER: 'postgres' }
            ]);

            const children = await schemaProvider.getChildren(viewItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('v_user_orders');
            expect(children[0].contextValue).toBe('netezza:VIEW');
            expect(runQueryRaw).toHaveBeenCalled();
        });

        it('should query PostgreSQL tables live when a partial view cache reports the group as empty', async () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('postgresql');
            mockMetadataCache.getObjectsByType.mockReturnValue([]);
            (
                schemaProvider as unknown as {
                    getMetadataProvider: () => { buildObjectTypeQuery: () => string };
                }
            ).getMetadataProvider = jest.fn(() => ({
                buildObjectTypeQuery: () => 'SELECT POSTGRESQL TABLES'
            }));

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['orders', 'public', 8, 'Orders table', 'postgres']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'orders', SCHEMA: 'public', OBJID: 8, DESCRIPTION: 'Orders table', OWNER: 'postgres' }
            ]);

            const children = await schemaProvider.getChildren(typeGroupItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('orders');
            expect(children[0].contextValue).toBe('netezza:TABLE');
            expect(runQueryRaw).toHaveBeenCalled();
        });

        it('should display catalog label without quotes but preserve rawLabel for lowercase objects', async () => {
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['lower_case_name', 'PUBLIC', 3, 'Lowercase table', 'ADMIN']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'lower_case_name', SCHEMA: 'PUBLIC', OBJID: 3, DESCRIPTION: 'Lowercase table', OWNER: 'ADMIN' }
            ]);

            const children = await schemaProvider.getChildren(typeGroupItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('lower_case_name');
            expect(children[0].rawLabel).toBe('lower_case_name');
        });

        it('should serve PROCEDURE type from cache without SQL', async () => {
            const procedureItem = new SchemaItem(
                'PROCEDURE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:PROCEDURE',
                'TESTDB',
                'PROCEDURE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );

            mockMetadataCache.getProceduresForDatabase.mockReturnValue([
                {
                    PROCEDURE: 'P1',
                    PROCEDURESIGNATURE: 'P1()',
                    SCHEMA: 'ADMIN',
                    label: 'P1()',
                },
            ]);

            const children = await schemaProvider.getChildren(procedureItem);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('P1()');
            expect(runQueryRaw).not.toHaveBeenCalled();
        });

        it('should use different query for PROCEDURE type when cache is empty', async () => {
            const procedureItem = new SchemaItem(
                'PROCEDURE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:PROCEDURE',
                'TESTDB',
                'PROCEDURE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'OBJNAME' }],
                data: []
            });
            (queryResultToRows as jest.Mock).mockReturnValue([]);

            await schemaProvider.getChildren(procedureItem);

            // Check that query includes PROCEDURESIGNATURE
            expect(runQueryRaw).toHaveBeenCalledWith(
                expect.anything(),
                expect.stringContaining('PROCEDURESIGNATURE'),
                expect.anything(),
                expect.anything(),
                expect.anything(),
                undefined,
                undefined,
                undefined,
                1000000,
                false
            );
        });

        it('should quote only procedure name part before signature parentheses', async () => {
            const procedureItem = new SchemaItem(
                'PROCEDURE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:PROCEDURE',
                'TESTDB',
                'PROCEDURE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [
                    { name: 'OBJNAME' },
                    { name: 'SCHEMA' },
                    { name: 'OBJID' },
                    { name: 'DESCRIPTION' },
                    { name: 'OWNER' }
                ],
                data: [
                    ['PROC_NAME()', 'PUBLIC', 10, '', 'ADMIN'],
                    ['lower_case_name()', 'PUBLIC', 11, '', 'ADMIN']
                ]
            });

            (queryResultToRows as jest.Mock).mockReturnValue([
                { OBJNAME: 'PROC_NAME()', SCHEMA: 'PUBLIC', OBJID: 10, DESCRIPTION: '', OWNER: 'ADMIN' },
                { OBJNAME: 'lower_case_name()', SCHEMA: 'PUBLIC', OBJID: 11, DESCRIPTION: '', OWNER: 'ADMIN' }
            ]);

            const children = await schemaProvider.getChildren(procedureItem);

            const upperProc = children.find(child => child.rawLabel === 'PROC_NAME()');
            const lowerProc = children.find(child => child.rawLabel === 'lower_case_name()');

            expect(upperProc?.label).toBe('PROC_NAME()');
            expect(lowerProc?.label).toBe('lower_case_name()');
        });
    });

    describe('getChildren - columns level', () => {
        let tableItem: SchemaItem;

        beforeEach(() => {
            tableItem = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                'User table',
                'TestConnection'
            );
        });

        it('should return columns from cache when available with isPk', async () => {
            mockMetadataCache.getColumns.mockReturnValue([
                { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER', label: 'ID', kind: 5, detail: 'INTEGER', documentation: 'Identifier', isPk: true, isFk: false, isDistributionKey: false },
                { ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(100)', label: 'NAME', kind: 5, detail: 'VARCHAR(100)', documentation: 'User name', isPk: false, isFk: false, isDistributionKey: false }
            ]);

            const children = await schemaProvider.getChildren(tableItem);

            expect(children).toHaveLength(2);
            expect(children[0].label).toBe('ID');
            expect(children[0].description).toBe('123 - Identifier');
            expect(children[0].isPk).toBe(true);
            expect(children[0].contextValue).toBe('column');
            expect(children[0].tooltip).toContain('Type: INTEGER');
            expect(children[1].description).toBe('txt - User name');
        });

        it('should resolve lowercase table names to uppercase cache keys', async () => {
            const lowerTableItem = new SchemaItem(
                'lower_table',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'ADMIN',
                3,
                'Lowercase table',
                'TestConnection',
                undefined,
                undefined,
                undefined,
                undefined,
                'ADMIN',
                'lower_table',
            );

            mockMetadataCache.getColumns.mockReturnValue([
                {
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    label: 'ID',
                    kind: 5,
                    detail: 'INTEGER',
                    documentation: '',
                    isPk: true,
                    isFk: false,
                    isDistributionKey: false,
                },
            ]);

            const children = await schemaProvider.getChildren(lowerTableItem);

            expect(children).toHaveLength(1);
            expect(mockMetadataCache.getColumns).toHaveBeenCalledWith(
                'TestConnection',
                'TESTDB.ADMIN.LOWER_TABLE',
            );
            expect(runQueryRaw).not.toHaveBeenCalled();
        });

        it('should query columns when not in cache', async () => {
            const { parseColumnMetadata } = require('../providers/tableMetadataProvider');
            (parseColumnMetadata as jest.Mock).mockReturnValue([
                { attname: 'ID', formatType: 'INTEGER', description: 'Identifier', isPk: true, isFk: false }
            ]);

            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'ATTNAME' }],
                data: [['ID']]
            });

            const children = await schemaProvider.getChildren(tableItem);

            expect(children).toHaveLength(1);
            expect(mockMetadataCache.setColumns).toHaveBeenCalled();
            expect(children[0].label).toBe('ID');
            expect(children[0].description).toBe('123 - Identifier');
            expect(children[0].tooltip).toContain('Type: INTEGER');
        });

        it('should reuse cache when isDistributionKey was not stored on first fetch', async () => {
            mockMetadataCache.getColumns.mockReturnValue([
                {
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    label: 'ID',
                    kind: 5,
                    detail: 'INTEGER',
                    documentation: 'Identifier',
                    isPk: true,
                    isFk: false,
                },
            ]);

            const children = await schemaProvider.getChildren(tableItem);

            expect(children).toHaveLength(1);
            expect(runQueryRaw).not.toHaveBeenCalled();
        });
    });

    describe('getParent', () => {
        it('should return undefined for root element', () => {
            const serverItem = new SchemaItem(
                'TestConnection',
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance'
            );

            const parent = schemaProvider.getParent(serverItem);

            expect(parent).toBeUndefined();
        });

        it('should return server instance for database', () => {
            const databaseItem = new SchemaItem(
                'TESTDB',
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                'TESTDB',
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );

            const parent = schemaProvider.getParent(databaseItem);

            expect(parent?.label).toBe('TestConnection');
            expect(parent?.contextValue).toBe('serverInstance');
        });

        it('should return database for type group', () => {
            const typeGroupItem = new SchemaItem(
                'TABLE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:TABLE',
                'TESTDB',
                'TABLE',
                undefined,
                undefined,
                undefined,
                'TestConnection'
            );

            const parent = schemaProvider.getParent(typeGroupItem);

            expect(parent?.label).toBe('TESTDB');
            expect(parent?.contextValue).toBe('database');
        });

        it('should return type group for object', () => {
            const objectItem = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection'
            );

            const parent = schemaProvider.getParent(objectItem);

            expect(parent?.label).toBe('TABLE');
            expect(parent?.contextValue).toBe('typeGroup:TABLE');
        });

        it('should return the Snowflake-specific type group for Snowflake dynamic tables', () => {
            mockConnectionManager.getConnectionDatabaseKind.mockReturnValue('snowflake');
            const objectItem = new SchemaItem(
                'ORDERS_DYNAMIC',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:DYNAMIC TABLE:snowflake',
                'TESTDB',
                'DYNAMIC TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection'
            );

            const parent = schemaProvider.getParent(objectItem);

            expect(parent?.label).toBe('DYNAMIC TABLE');
            expect(parent?.contextValue).toBe('typeGroup:DYNAMIC TABLE:snowflake');
        });
    });

    describe('handleDrag', () => {
        it('should set data transfer for netezza items', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection'
            );

            const dataTransfer = {
                set: jest.fn()
            } as unknown as vscode.DataTransfer;

            const token = { isCancellationRequested: false } as vscode.CancellationToken;

            schemaProvider.handleDrag([item], dataTransfer, token);

            expect(dataTransfer.set).toHaveBeenCalledWith(
                'application/vnd.code.tree.netezza',
                expect.any(Object)
            );
            expect(dataTransfer.set).toHaveBeenCalledWith(
                'text/plain',
                expect.any(Object)
            );
        });

        it('should not set data transfer for empty source', () => {
            const dataTransfer = {
                set: jest.fn()
            } as unknown as vscode.DataTransfer;

            const token = { isCancellationRequested: false } as vscode.CancellationToken;

            schemaProvider.handleDrag([], dataTransfer, token);

            expect(dataTransfer.set).not.toHaveBeenCalled();
        });
    });
});

describe('SchemaItem', () => {
    describe('constructor', () => {
        it('should set basic properties', () => {
            const item = new SchemaItem(
                'TestDB',
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                'TestDB'
            );

            expect(item.label).toBe('TestDB');
            expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
            expect(item.contextValue).toBe('database');
            expect(item.dbName).toBe('TestDB');
        });

        it('should generate stable ID', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection'
            );

            expect(item.id).toContain('TestConnection');
            expect(item.id).toContain('TESTDB');
            expect(item.id).toContain('USERS');
        });

        it('should use rawLabel for stable ID when provided', () => {
            const item = new SchemaItem(
                '"lower_case_name"',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection',
                undefined,
                undefined,
                undefined,
                undefined,
                'ADMIN',
                'lower_case_name'
            );

            expect(item.label).toBe('"lower_case_name"');
            expect(item.rawLabel).toBe('lower_case_name');
            expect(item.id).toContain('lower_case_name');
            expect(item.id).not.toContain('"lower_case_name"');
        });

        it('should set database icon for database context', () => {
            const item = new SchemaItem(
                'TestDB',
                vscode.TreeItemCollapsibleState.Collapsed,
                'database',
                'TestDB'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('database'));
        });

        it('should set server icon for server instance', () => {
            const item = new SchemaItem(
                'TestConnection',
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('server'));
            expect(item.resourceUri?.toString()).toBe('netezza-connection-accent:/TestConnection');
        });

        it('should set folder icon for type group', () => {
            const item = new SchemaItem(
                'TABLE',
                vscode.TreeItemCollapsibleState.Collapsed,
                'typeGroup:TABLE'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('folder'));
        });

        it('should set table icon for TABLE type', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('table'));
        });

        it('should set eye icon for VIEW type', () => {
            const item = new SchemaItem(
                'USER_VIEW',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:VIEW',
                'TESTDB',
                'VIEW'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('eye'));
        });

        it('should set gear icon for PROCEDURE type', () => {
            const item = new SchemaItem(
                'GET_USERS',
                vscode.TreeItemCollapsibleState.None,
                'netezza:PROCEDURE',
                'TESTDB',
                'PROCEDURE'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('gear'));
        });

        it('should set key icon for primary key column', () => {
            const item = new SchemaItem(
                'ID',
                vscode.TreeItemCollapsibleState.None,
                'column',
                'TESTDB',
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection',
                'USERS',
                undefined,
                true,  // isPk
                false,  // isFk
                undefined,
                undefined,
                'INTEGER'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow')));
            expect(item.tooltip).toContain('Primary Key');
            expect(item.tooltip).toContain('Type: INTEGER');
            expect(item.description).toBe('123');
        });

        it('should set link icon for foreign key column', () => {
            const item = new SchemaItem(
                'USER_ID',
                vscode.TreeItemCollapsibleState.None,
                'column',
                'TESTDB',
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection',
                'ORDERS',
                undefined,
                false,  // isPk
                true,    // isFk
                undefined,
                undefined,
                'INTEGER'
            );

            expect(item.iconPath).toEqual(new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.blue')));
            expect(item.tooltip).toContain('Foreign Key');
            expect(item.tooltip).toContain('Type: INTEGER');
        });

        it('should build tooltip with description', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                'Contains all user accounts',
                'TestConnection'
            );

            expect(item.tooltip).toContain('Contains all user accounts');
            expect(item.tooltip).toContain('TestConnection');
            expect(item.tooltip).toContain('PUBLIC');
        });

        it('should set description as schema name', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC'
            );

            expect(item.description).toBe('(PUBLIC)');
        });

        it('should show inline table and column descriptions using secondary text', () => {
            const tableItem = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                'Contains all user accounts',
                'TestConnection'
            );
            const columnItem = new SchemaItem(
                'CREATED_AT',
                vscode.TreeItemCollapsibleState.None,
                'column',
                'TESTDB',
                undefined,
                undefined,
                undefined,
                'Record creation time',
                'TestConnection',
                'USERS',
                undefined,
                false,
                false,
                undefined,
                undefined,
                'TIMESTAMP'
            );

            expect(tableItem.description).toBe('(PUBLIC) - Contains all user accounts');
            expect(columnItem.description).toBe('📅 - Record creation time');
            expect(columnItem.tooltip).toContain('Type: TIMESTAMP');
        });

        it('should include owner in tooltip', () => {
            const item = new SchemaItem(
                'USERS',
                vscode.TreeItemCollapsibleState.Collapsed,
                'netezza:TABLE',
                'TESTDB',
                'TABLE',
                'PUBLIC',
                1,
                undefined,
                'TestConnection',
                undefined,
                undefined,
                undefined,
                undefined,
                'ADMIN'  // owner
            );

            expect(item.tooltip).toContain('Owner: ADMIN');
        });

        it('should use custom icon when provided', () => {
            const customIcon = { fsPath: '/test/custom-icon.png' } as vscode.Uri;
            const item = new SchemaItem(
                'TestConnection',
                vscode.TreeItemCollapsibleState.Collapsed,
                'serverInstance',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'TestConnection',
                undefined,
                customIcon
            );

            expect(item.iconPath).toBe(customIcon);
        });
    });
});
