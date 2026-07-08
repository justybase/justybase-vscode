
import { SchemaSearchProvider, buildEscapedLikePattern } from '../providers/schemaSearchProvider';
import { MockNzConnection } from '../__mocks__/mockNzConnection';
import { MockDataFactory } from '../__mocks__/mockDataFactories';
import { NZ_QUERIES } from '../metadata/systemQueries';
import { getDatabaseMetadataProvider } from '../core/connectionFactory';
import { queryResultToRows } from '../core/queryRunner';
import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import type { SchemaSearchResultItem } from '../contracts/webviews';

// Mock types helper
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockType = any;

// Mock vscode
jest.mock('vscode', () => ({
    Uri: { parse: jest.fn() },
    EventEmitter: jest.fn().mockImplementation(() => ({
        event: jest.fn(),
        fire: jest.fn()
    })),
    window: {
        activeTextEditor: undefined,
        createStatusBarItem: jest.fn().mockReturnValue({
            show: jest.fn(),
            hide: jest.fn()
        })
    },
    commands: {
        executeCommand: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'searchAllDatabases') {
                    return true;
                }
                return defaultValue;
            })
        })
    }
}), { virtual: true });

jest.mock('../core/connectionFactory', () => ({
    ...jest.requireActual('../core/connectionFactory'),
    createConnectedDatabaseConnectionFromDetails: jest.fn(),
    getDatabaseMetadataProvider: jest.fn((kind?: string) => {
        if (kind === 'sqlite') {
            return jest.requireActual('../dialects/sqlite/metadata/provider').sqliteMetadataProvider;
        }
        if (kind === 'db2') {
            return jest.requireActual('../../extensions/db2/src/db2SchemaProvider').db2MetadataProvider;
        }
        if (kind === 'snowflake') {
            return jest.requireActual('../../extensions/snowflake/src/snowflakeSchemaProvider').snowflakeMetadataProvider;
        }
        return jest.requireActual('../dialects/netezza/metadata/provider').netezzaMetadataProvider;
    })
}));

import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { runQueryRaw } from '../core/queryRunner';

jest.mock('../core/queryRunner', () => ({
    ...jest.requireActual('../core/queryRunner'),
    runQueryRaw: jest.fn(),
}));

describe('SchemaSearchProvider with Mock DB', () => {
    let provider: SchemaSearchProvider;
    let mockContext: MockType;
    let mockCache: MockType;
    let mockConnManager: MockType;
    let mockDbConnection: MockNzConnection;
    let mockWebview: MockType;

    beforeEach(() => {
        // Setup mocks
        mockContext = {
            extensionUri: {},
            // Mock globalState for QueryHistoryManager
            globalState: {
                get: jest.fn().mockReturnValue(undefined),
                update: jest.fn().mockResolvedValue(undefined)
            },
            globalStorageUri: { fsPath: '/tmp/test-storage' }
        };
        mockCache = {
            tableCache: new Map(),
            columnCache: new Map(),
            schemaCache: new Map(),
            search: jest.fn().mockReturnValue([]),
            hasAllObjectsPrefetchTriggered: jest.fn().mockReturnValue(true),
            isConnectionPrefetchFresh: jest.fn().mockReturnValue(true),
            prefetchAllObjects: jest.fn(),
            getColumns: jest.fn().mockReturnValue(undefined),
        };
        mockConnManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
            getConnectionForExecution: jest.fn(),
            getConnections: jest.fn().mockResolvedValue([
                {
                    name: 'test-connection',
                    database: 'TEST_DB',
                    dbType: 'netezza'
                }
            ]),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            resolveConnectionName: jest.fn((_documentUri?: string, name?: string) => name || 'test-connection'),
            onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeActiveConnection: jest.fn(() => ({ dispose: jest.fn() })),
            onDidChangeDocumentConnection: jest.fn(() => ({ dispose: jest.fn() })),
            getConnection: jest.fn().mockResolvedValue({
                host: 'host',
                database: 'TEST_DB',
                user: 'user',
                password: 'password'
            })
        };

        // Setup mock DB connection
        mockDbConnection = new MockNzConnection();
        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(mockDbConnection);
        (runQueryRaw as jest.Mock).mockImplementation(async (_context, sql: string) => {
            if (sql.includes('SHOW DATABASES')) {
                const databases = mockDbConnection['mockData'].get('SHOW DATABASES') as Array<{ DATABASE: string }> | undefined;
                if (databases) {
                    return {
                        columns: [{ name: 'DATABASE' }],
                        data: databases.map((row) => [row.DATABASE]),
                    };
                }
            }
            if (sql.includes('ORDER BY DATABASE') && !sql.includes('UNION ALL')) {
                const databases = mockDbConnection['mockData'].get(NZ_QUERIES.LIST_DATABASES) as Array<{ DATABASE: string }> | undefined;
                if (databases) {
                    return {
                        columns: [{ name: 'DATABASE' }],
                        data: databases.map((row) => [row.DATABASE]),
                    };
                }
            }
            return undefined;
        });

        // Setup mock webview structure
        mockWebview = {
            webview: {
                options: {},
                html: '',
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn()
            }
        };

        provider = new SchemaSearchProvider(
            {} as vscode.Uri,
            mockContext as vscode.ExtensionContext,
            mockCache as MetadataCache,
            mockConnManager as ConnectionManager
        );

        // Initialize view - this connects the onDidReceiveMessage handler
        provider.resolveWebviewView(mockWebview, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should escape LIKE wildcard characters in pattern builder', () => {
        expect(buildEscapedLikePattern(`fact_100%\\a'`)).toBe(`%FACT\\_100\\%\\\\A''%`);
    });

    it('should handle initial requestConnections posted while the webview HTML is loading', async () => {
        const eagerWebview = {
            webview: {
                options: {},
                onDidReceiveMessage: jest.fn(),
                postMessage: jest.fn()
            }
        } as MockType;

        let registeredHandler: ((message: Record<string, unknown>) => Promise<void>) | undefined;
        eagerWebview.webview.onDidReceiveMessage.mockImplementation((handler: (message: Record<string, unknown>) => Promise<void>) => {
            registeredHandler = handler;
            return { dispose: jest.fn() };
        });

        Object.defineProperty(eagerWebview.webview, 'html', {
            configurable: true,
            get: () => '',
            set: () => {
                if (registeredHandler) {
                    void registeredHandler({ type: 'requestConnections' });
                }
            }
        });

        const eagerProvider = new SchemaSearchProvider(
            {} as vscode.Uri,
            mockContext as vscode.ExtensionContext,
            mockCache as MetadataCache,
            mockConnManager as ConnectionManager
        );

        eagerProvider.resolveWebviewView(eagerWebview, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
        await Promise.resolve();

        expect(eagerWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'connections',
                connections: expect.arrayContaining([
                    expect.objectContaining({ name: 'test-connection' })
                ])
            })
        );
    });

    it('should search across multiple databases using UNION ALL', async () => {
        // 1. Mock list of databases
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1'),
            MockDataFactory.createDatabaseRow('DB2')
        ]);

        // 2. Mock search results (the big UNION ALL query)
        const mockSearchResults = [
            {
                PRIORITY: 1,
                NAME: 'CUSTOMER_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME'
            },
            {
                PRIORITY: 1,
                NAME: 'CUSTOMER_VIEW',
                SCHEMA: 'PUBLIC',
                DATABASE: 'DB2',
                TYPE: 'VIEW',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME'
            }
        ];

        mockDbConnection.setMockData('UNION ALL', mockSearchResults);
        mockDbConnection.setMockData('%CUSTOMER%', mockSearchResults);

        // Verify handler was attached
        if (mockWebview.webview.onDidReceiveMessage.mock.calls.length === 0) {
            throw new Error('Webview message handler was not attached!');
        }

        // Access the message handler to trigger search
        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];

        await messageHandler({ type: 'search', value: 'CUSTOMER' });

        // Verify results were posted to webview
        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'CUSTOMER_TABLE', DATABASE: 'DB1' }),
                    expect.objectContaining({ NAME: 'CUSTOMER_VIEW', DATABASE: 'DB2' })
                ])
            })
        );
    });

    it('should treat underscore as literal in database object search', async () => {
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);

        mockDbConnection.setMockData(`LIKE '%FACT\\_%' ESCAPE '\\'`, [
            {
                PRIORITY: 1,
                NAME: 'FACT_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME'
            }
        ]);

        if (mockWebview.webview.onDidReceiveMessage.mock.calls.length === 0) {
            throw new Error('Webview message handler was not attached!');
        }

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'fact_' });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'FACT_TABLE', DATABASE: 'DB1' })
                ])
            })
        );
    });

    it('should search source code in view definitions', async () => {
        // 1. Mock list of databases
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);

        // 2. Mock view search result
        // 2. Mock view search result
        const viewRow = MockDataFactory.createViewRow('MY_VIEW', 'ADMIN', 'DB1', 'CREATE VIEW MY_VIEW AS SELECT * FROM CUSTOMERS');
        const mockViews = [{ ...viewRow, NAME: viewRow.VIEWNAME }];

        // Match the specific query structure for view definition search
        mockDbConnection.setMockData('_V_VIEW', mockViews);

        // Verify handler was attached
        if (mockWebview.webview.onDidReceiveMessage.mock.calls.length === 0) {
            throw new Error('Webview message handler was not attached!');
        }

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];

        // Search for 'CUSTOMERS' inside view definition
        await messageHandler({
            type: 'searchSource',
            value: 'CUSTOMERS',
            mode: 'raw'
        });

        // Verify result
        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({
                        NAME: 'MY_VIEW',
                        MATCH_TYPE: 'SOURCE_CODE',
                        DATABASE: 'DB1'
                    })
                ])
            })
        );
    });

    it('should search DB2 objects across tables, procedures, and columns', async () => {
        mockConnManager.getConnectionDatabaseKind.mockReturnValue('db2');
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        mockDbConnection.setMockData('FETCH FIRST 200 ROWS ONLY', [
            {
                PRIORITY: 1,
                NAME: 'REMOTE_CUSTOMERS',
                SCHEMA: 'FED',
                DATABASE: 'DB1',
                TYPE: 'NICKNAME',
                PARENT: '',
                DESCRIPTION: 'Federated customer table',
                MATCH_TYPE: 'NAME'
            },
            {
                PRIORITY: 1,
                NAME: 'SYNC_CUSTOMERS',
                SCHEMA: 'APP',
                DATABASE: 'DB1',
                TYPE: 'PROCEDURE',
                PARENT: '',
                DESCRIPTION: 'Sync customer data',
                MATCH_TYPE: 'NAME'
            },
            {
                PRIORITY: 2,
                NAME: 'CUSTOMER_ID',
                SCHEMA: 'APP',
                DATABASE: 'DB1',
                TYPE: 'COLUMN',
                PARENT: 'CUSTOMERS',
                DESCRIPTION: 'Customer identifier',
                MATCH_TYPE: 'NAME'
            }
        ]);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'CUSTOMER' });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'REMOTE_CUSTOMERS', TYPE: 'NICKNAME', DATABASE: 'DB1' }),
                    expect.objectContaining({ NAME: 'SYNC_CUSTOMERS', TYPE: 'PROCEDURE', DATABASE: 'DB1' }),
                    expect.objectContaining({ NAME: 'CUSTOMER_ID', TYPE: 'COLUMN', DATABASE: 'DB1', PARENT: 'CUSTOMERS' })
                ])
            })
        );
    });

    it('should preserve returned routine types when searching DB2 raw source code', async () => {
        mockConnManager.getConnectionDatabaseKind.mockReturnValue('db2');
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        mockDbConnection.setMockData(`FROM SYSCAT.VIEWS
            WHERE REGEXP_LIKE(TEXT, 'products', 'i')`, [
            {
                NAME: 'V_PRODUCTS_CATEGORIES',
                SCHEMA: 'DB2INST1',
                DATABASE: 'DB1'
            }
        ]);
        mockDbConnection.setMockData(`ROUTINETYPE IN ('P', 'F')
              AND REGEXP_LIKE(TEXT, 'products', 'i')`, [
            {
                NAME: 'SYNC_PRODUCTS',
                SCHEMA: 'DB2INST1',
                DATABASE: 'DB1',
                TYPE: 'PROCEDURE'
            },
            {
                NAME: 'FORMAT_PRODUCTS',
                SCHEMA: 'DB2INST1',
                DATABASE: 'DB1',
                TYPE: 'FUNCTION'
            }
        ]);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({
            type: 'searchSource',
            value: 'products',
            mode: 'raw'
        });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'V_PRODUCTS_CATEGORIES', TYPE: 'VIEW', MATCH_TYPE: 'SOURCE_CODE' }),
                    expect.objectContaining({ NAME: 'SYNC_PRODUCTS', TYPE: 'PROCEDURE', MATCH_TYPE: 'SOURCE_CODE' }),
                    expect.objectContaining({ NAME: 'FORMAT_PRODUCTS', TYPE: 'FUNCTION', MATCH_TYPE: 'SOURCE_CODE' })
                ])
            })
        );
    });

    it('should supplement Snowflake object search with stream and task type queries', async () => {
        mockConnManager.getConnectionDatabaseKind.mockReturnValue('snowflake');
        mockConnManager.getConnection.mockResolvedValue({
            host: 'host',
            database: 'DB1',
            user: 'user',
            password: 'password'
        });
        mockDbConnection.setMockData('SHOW DATABASES', [
            { DATABASE: 'DB1' }
        ]);
        mockDbConnection.setMockData('SHOW STREAMS IN DATABASE "DB1"\n->>', [
            {
                OBJNAME: 'ORDERS_STREAM',
                SCHEMA: 'PUBLIC',
                OBJTYPE: 'STREAM',
                DESCRIPTION: 'Tracks order changes',
                DATABASE: 'DB1'
            }
        ]);
        mockDbConnection.setMockData('SHOW TASKS IN DATABASE "DB1"\n->>', [
            {
                OBJNAME: 'ORDERS_TASK',
                SCHEMA: 'PUBLIC',
                OBJTYPE: 'TASK',
                DESCRIPTION: 'Refreshes order snapshots',
                DATABASE: 'DB1'
            }
        ]);

        const streamSql = getDatabaseMetadataProvider('snowflake').buildObjectTypeQuery('DB1', 'STREAM');
        const streamReader = await mockDbConnection.createCommand(streamSql).executeReader();
        const streamColumns = Array.from({ length: streamReader.fieldCount }, (_, index) => ({ name: streamReader.getName(index) }));
        const streamData: Array<Array<unknown>> = [];
        while (await streamReader.read()) {
            streamData.push(Array.from({ length: streamReader.fieldCount }, (_, index) => streamReader.getValue(index)));
        }
        await streamReader.close();
        expect(queryResultToRows(streamColumns.length > 0 ? { columns: streamColumns, data: streamData, sql: streamSql, limitReached: false } : { columns: [], data: [], sql: streamSql, limitReached: false })).toHaveLength(1);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'orders' });

        expect(createConnectedDatabaseConnectionFromDetails).toHaveBeenCalled();
        expect((createConnectedDatabaseConnectionFromDetails as jest.Mock).mock.calls.length).toBeGreaterThan(1);
        const resultPayloads = mockWebview.webview.postMessage.mock.calls
            .map(([message]: [{ type: string; data?: SchemaSearchResultItem[] }]) => message)
            .filter((message: { type: string }) => message.type === 'results');
        const allResults = resultPayloads.flatMap((message: { data?: SchemaSearchResultItem[] }) => message.data ?? []);

        expect(allResults).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ NAME: 'ORDERS_STREAM', TYPE: 'STREAM', DATABASE: 'DB1' }),
                expect.objectContaining({ NAME: 'ORDERS_TASK', TYPE: 'TASK', DATABASE: 'DB1' }),
            ]),
        );
    });

    it('should use explicitly selected connection for search requests', async () => {
        mockConnManager.getConnectionForExecution.mockReturnValue('sql-tab-connection');
        mockConnManager.getActiveConnectionName.mockReturnValue('active-connection');
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        mockDbConnection.setMockData('UNION ALL', [
            {
                PRIORITY: 1,
                NAME: 'CUSTOMER_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME'
            }
        ]);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'CUSTOMER', connectionName: 'selected-connection' });

        expect(mockConnManager.resolveConnectionName).toHaveBeenCalledWith(undefined, 'selected-connection');
        expect(mockConnManager.getConnection).toHaveBeenCalledWith('selected-connection');
    });

    it('should fall back to the only saved connection when no active connection is resolved', async () => {
        mockConnManager.getConnectionForExecution.mockReturnValue(undefined);
        mockConnManager.getActiveConnectionName.mockReturnValue(null);
        mockConnManager.getConnections.mockResolvedValue([
            {
                name: 'only-connection',
                database: 'TEST_DB',
                dbType: 'netezza'
            }
        ]);
        mockConnManager.getConnection.mockResolvedValue({
            host: 'host',
            database: 'TEST_DB',
            user: 'user',
            password: 'password'
        });

        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        mockDbConnection.setMockData('UNION ALL', [
            {
                PRIORITY: 1,
                NAME: 'CUSTOMER_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'DB1',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME'
            }
        ]);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'CUSTOMER' });

        expect(mockConnManager.getConnection).toHaveBeenCalledWith('only-connection');
        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'CUSTOMER_TABLE', DATABASE: 'DB1' })
                ])
            })
        );
    });

    it('should fall back to unscoped cache results when auto connection cache lookup misses', async () => {
        mockConnManager.getActiveConnectionName.mockReturnValue('active-connection');
        mockCache.tableCache.set('tab-connection|JUST_DATA.ADMIN', {
            data: [{ label: 'DIMACCOUNT', objType: 'TABLE', kind: 6, SCHEMA: 'ADMIN' }],
            timestamp: Date.now(),
        });
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, []);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'DIMACCOUNT' });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'results',
                append: false,
                data: expect.arrayContaining([
                    expect.objectContaining({
                        NAME: 'DIMACCOUNT',
                        DATABASE: 'JUST_DATA',
                        connectionName: 'tab-connection'
                    })
                ])
            })
        );
    });

    it('should not overwrite cached results with an empty result payload when no databases can be resolved', async () => {
        mockCache.tableCache.set('test-connection|JUST_DATA.ADMIN', {
            data: [{ label: 'DIMACCOUNT', objType: 'TABLE', kind: 6, SCHEMA: 'ADMIN' }],
            timestamp: Date.now(),
        });
        mockConnManager.getConnection.mockResolvedValue({
            host: 'host',
            database: undefined,
            user: 'user',
            password: 'password'
        });
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, []);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'DIMACCOUNT' });

        const resultMessages = mockWebview.webview.postMessage.mock.calls
            .map((call: [Record<string, unknown>]) => call[0])
            .filter((message: Record<string, unknown>) => message.type === 'results');

        expect(resultMessages).toHaveLength(1);
        expect(resultMessages[0]).toEqual(
            expect.objectContaining({
                append: false,
                data: expect.arrayContaining([
                    expect.objectContaining({ NAME: 'DIMACCOUNT', DATABASE: 'JUST_DATA' })
                ])
            })
        );
    });

    it('should surface an error when a stale selected connection is requested', async () => {
        mockConnManager.resolveConnectionName.mockReturnValue('missing-connection');
        mockConnManager.getConnection.mockResolvedValue(undefined);

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'CUSTOMER', connectionName: 'missing-connection' });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining("missing-connection")
            })
        );
    });

    it('should surface a timeout error when object search hangs', async () => {
        jest.useFakeTimers();
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        mockConnManager.getConnection.mockImplementation(() => new Promise(() => {}));

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        const pending = messageHandler({ type: 'search', value: 'CUSTOMER' });

        await jest.advanceTimersByTimeAsync(60000);
        await pending;

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining('timed out')
            })
        );
    });

    it('should send error when search term is shorter than 2 characters', async () => {
        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        await messageHandler({ type: 'search', value: 'X' });

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining('at least 2 characters')
            })
        );
    });

    it('should await combined search sub-tasks so timeout protection covers them', async () => {
        jest.useFakeTimers();
        mockDbConnection.setMockData(NZ_QUERIES.LIST_DATABASES, [
            MockDataFactory.createDatabaseRow('DB1')
        ]);
        // getConnection hangs — simulates unreachable server during combined search
        mockConnManager.getConnection.mockImplementation(() => new Promise(() => {}));

        const messageHandler = mockWebview.webview.onDidReceiveMessage.mock.calls[0][0];
        const pending = messageHandler({ type: 'searchCombined', value: 'CUSTOMER', mode: 'raw' });

        await jest.advanceTimersByTimeAsync(60000);
        await pending;

        expect(mockWebview.webview.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                message: expect.stringContaining('timed out')
            })
        );
    });

    it('should stop scheduling additional tasks when cancellation stop condition is met', async () => {
        const executed: number[] = [];
        const tasks = [1, 2, 3].map(value => async () => {
            executed.push(value);
            return value;
        });

        const results = await (provider as unknown as {
            runWithConcurrencyLimit: (
                t: Array<() => Promise<number>>,
                c: number,
                shouldStop?: () => boolean
            ) => Promise<number[]>;
        }).runWithConcurrencyLimit(tasks, 1, () => executed.length >= 1);

        expect(executed).toEqual([1]);
        expect(results).toEqual([1]);
    });

    it('should schedule each task once when maxConcurrency is greater than one', async () => {
        const executed: number[] = [];
        const tasks = [1, 2, 3, 4].map(value => async () => {
            executed.push(value);
            await Promise.resolve();
            return value;
        });

        const results = await (provider as unknown as {
            runWithConcurrencyLimit: (
                t: Array<() => Promise<number>>,
                c: number,
                shouldStop?: () => boolean
            ) => Promise<number[]>;
        }).runWithConcurrencyLimit(tasks, 2);

        expect(executed).toHaveLength(4);
        expect([...executed].sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
        expect(results).toEqual([1, 2, 3, 4]);
    });
});
