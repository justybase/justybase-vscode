/**
 * Integration test framework for JustyBase
 * Tests end-to-end workflows with mocked components
 */

import * as vscode from 'vscode';
import { ConnectionManager, ConnectionDetails } from '../../core/connectionManager';
import { runQueryRaw } from '../../core/queryRunner';
import { ExportManager } from '../../export/exportManager';
import type { ResultSet } from '../../types';
import { MockNzConnection } from '../../__mocks__/mockNzConnection';
import { EditDataItem } from '../../views/editDataProvider';

// Mock the nzConnectionFactory
jest.mock('../../core/nzConnectionFactory', () => ({
    createNzConnection: jest.fn(() => new MockNzConnection())
}));

// Mock query runner
jest.mock('../../core/queryRunner', () => ({
    runQuery: jest.fn(),
    runQueryRaw: jest.fn(),
    runQueriesSequentially: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryResultToRows: jest.fn((result: any) => {
        if (!result || !result.data) return [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return result.data.map((row: any[]) => {
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

jest.mock('../../export/resultExporter', () => ({
    exportResultSetToFile: jest.fn().mockResolvedValue(undefined)
}));

describe('Integration Tests - Connection → Query → Results Flow', () => {
    let mockContext: vscode.ExtensionContext;
    let secretsStore: Map<string, string>;
    let globalState: Map<string, unknown>;

    beforeEach(() => {
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
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
    });

    describe('Workflow 1: Connection → Query → Results', () => {
        it('should complete full workflow from connection to results', async () => {
            // Step 1: Setup connection
            const connectionManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connectionDetails: ConnectionDetails = {
                name: 'IntegrationTest',
                host: 'test.netezza.local',
                port: 5480,
                database: 'testdb',
                user: 'testuser',
                password: 'testpass'
            };

            await connectionManager.saveConnection(connectionDetails);
            await connectionManager.setActiveConnection('IntegrationTest');

            // Verify connection is saved and active
            expect(connectionManager.getActiveConnectionName()).toBe('IntegrationTest');
            const connections = await connectionManager.getConnections();
            expect(connections).toHaveLength(1);

            // Step 2: Document connection assignment
            const docUri = 'file:///integration-test.sql';
            connectionManager.setDocumentConnection(docUri, 'IntegrationTest');
            expect(connectionManager.getConnectionForExecution(docUri)).toBe('IntegrationTest');

            // Step 3: Database selection
            const effectiveDb = await connectionManager.getEffectiveDatabase(docUri);
            expect(effectiveDb).toBe('testdb');

            // Step 4: Document database override
            await connectionManager.setDocumentDatabase(docUri, 'otherdb');
            const overrideDb = await connectionManager.getEffectiveDatabase(docUri);
            expect(overrideDb).toBe('otherdb');

            await connectionManager.dispose();
        });

        it('should handle multiple connections and document assignments', async () => {
            const connectionManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            // Setup multiple connections
            const conn1: ConnectionDetails = {
                name: 'DevDB',
                host: 'dev.netezza.local',
                port: 5480,
                database: 'devdb',
                user: 'devuser',
                password: 'devpass'
            };

            const conn2: ConnectionDetails = {
                name: 'ProdDB',
                host: 'prod.netezza.local',
                port: 5480,
                database: 'proddb',
                user: 'produser',
                password: 'prodpass'
            };

            await connectionManager.saveConnection(conn1);
            await connectionManager.saveConnection(conn2);

            // Assign different connections to different documents
            const doc1 = 'file:///dev-work.sql';
            const doc2 = 'file:///prod-work.sql';

            connectionManager.setDocumentConnection(doc1, 'DevDB');
            connectionManager.setDocumentConnection(doc2, 'ProdDB');

            // Verify isolation
            expect(connectionManager.getConnectionForExecution(doc1)).toBe('DevDB');
            expect(connectionManager.getConnectionForExecution(doc2)).toBe('ProdDB');

            const devDb = await connectionManager.getEffectiveDatabase(doc1);
            const prodDb = await connectionManager.getEffectiveDatabase(doc2);

            expect(devDb).toBe('devdb');
            expect(prodDb).toBe('proddb');

            await connectionManager.dispose();
        });

        it('should persist workflow state across sessions', async () => {
            // Session 1: Setup
            const manager1 = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connectionDetails: ConnectionDetails = {
                name: 'PersistentConn',
                host: 'persistent.netezza.local',
                port: 5480,
                database: 'persistdb',
                user: 'user',
                password: 'pass'
            };

            await manager1.saveConnection(connectionDetails);
            await manager1.setActiveConnection('PersistentConn');
            await manager1.dispose();

            // Session 2: Verify persistence
            const manager2 = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(manager2.getActiveConnectionName()).toBe('PersistentConn');
            const connections = await manager2.getConnections();
            expect(connections).toHaveLength(1);
            expect(connections[0].host).toBe('persistent.netezza.local');

            await manager2.dispose();
        });
    });

    describe('Workflow 2: Schema Exploration Flow', () => {
        it('should navigate schema hierarchy', async () => {
            const connectionManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            // Setup connection
            const connectionDetails: ConnectionDetails = {
                name: 'SchemaTest',
                host: 'schema.netezza.local',
                port: 5480,
                database: 'testdb',
                user: 'user',
                password: 'pass'
            };

            await connectionManager.saveConnection(connectionDetails);

            // Document with connection
            const docUri = 'file:///schema-exploration.sql';
            connectionManager.setDocumentConnection(docUri, 'SchemaTest');

            // Verify connection is ready for schema exploration
            const connName = connectionManager.getConnectionForExecution(docUri);
            expect(connName).toBe('SchemaTest');

            const connection = await connectionManager.getConnection(connName!);
            expect(connection).toBeDefined();
            expect(connection?.database).toBe('testdb');

            await connectionManager.dispose();
        });
    });

    describe('Workflow 3: Data Editing Flow', () => {
        it('should validate edit data item requirements', () => {
            // Valid item
            const validItem: EditDataItem = {
                label: 'users',
                dbName: 'testdb',
                schema: 'public',
                connectionName: 'TestConnection'
            };

            expect(validItem.label).toBeTruthy();
            expect(validItem.dbName).toBeTruthy();
            expect(validItem.schema).toBeTruthy();

            // Invalid items
            const invalidItems: EditDataItem[] = [
                { ...validItem, label: '' },
                { ...validItem, dbName: '' },
                { ...validItem, schema: '' }
            ];

            for (const item of invalidItems) {
                expect(item.label && item.dbName && item.schema).toBeFalsy();
            }
        });

        it('should construct full table names correctly', () => {
            const item: EditDataItem = {
                label: 'users',
                dbName: 'testdb',
                schema: 'public',
                connectionName: 'TestConnection'
            };

            const fullTableName = `${item.dbName}.${item.schema}.${item.label}`;
            expect(fullTableName).toBe('testdb.public.users');
        });
    });

    describe('Workflow 4: Export Workflow', () => {
        it('should handle document connection for exports', async () => {
            const connectionManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connectionDetails: ConnectionDetails = {
                name: 'ExportDB',
                host: 'export.netezza.local',
                port: 5480,
                database: 'exportdb',
                user: 'user',
                password: 'pass'
            };

            await connectionManager.saveConnection(connectionDetails);

            // Document with connection
            const docUri = 'file:///export-work.sql';
            connectionManager.setDocumentConnection(docUri, 'ExportDB');

            // Verify connection context for export
            const connForExport = connectionManager.getConnectionForExecution(docUri);
            expect(connForExport).toBe('ExportDB');

            const effectiveDb = await connectionManager.getEffectiveDatabase(docUri);
            expect(effectiveDb).toBe('exportdb');

            await connectionManager.dispose();
        });
    });

    describe('Workflow 5: Connection → Query → Export', () => {
        it('should execute a query with document connection and export the result set', async () => {
            const connectionManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connectionDetails: ConnectionDetails = {
                name: 'QueryExportDB',
                host: 'query-export.netezza.local',
                port: 5480,
                database: 'queryexportdb',
                user: 'user',
                password: 'pass'
            };

            await connectionManager.saveConnection(connectionDetails);
            await connectionManager.setActiveConnection('QueryExportDB');

            const docUri = 'file:///query-export.sql';
            connectionManager.setDocumentConnection(docUri, 'QueryExportDB');

            const queryResult: ResultSet = {
                columns: [{ name: 'ID' }, { name: 'NAME' }],
                data: [[1, 'Alice']],
                sql: 'SELECT 1 AS ID, \'Alice\' AS NAME'
            };

            const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
            runQueryRawMock.mockResolvedValueOnce(queryResult);

            const returnedResult = await runQueryRaw(mockContext, queryResult.sql || '', true, connectionManager, 'QueryExportDB', docUri);
            expect(returnedResult.columns).toEqual(queryResult.columns);
            expect(returnedResult.data).toEqual(queryResult.data);

            const vscodeWindow = vscode.window as unknown as {
                showSaveDialog: jest.Mock;
                withProgress: jest.Mock;
                showInformationMessage: jest.Mock;
            };
            const vscodeNamespace = vscode as unknown as {
                ProgressLocation: { Notification: number };
            };
            vscodeNamespace.ProgressLocation = { Notification: 15 };
            vscodeWindow.showSaveDialog = jest.fn().mockResolvedValue({ fsPath: 'D:\\tmp\\query-export.csv' } as vscode.Uri);
            vscodeWindow.withProgress = jest.fn(async (_options, task) =>
                task({ report: jest.fn() }, { isCancellationRequested: false } as vscode.CancellationToken)
            );

            const exportManager = new ExportManager(new Map([[docUri, [returnedResult]]]));
            await exportManager.handleExport({
                sourceUri: docUri,
                resultSetIndex: 0,
                format: 'csv'
            });

            const resultExporterModule = jest.requireMock('../../export/resultExporter') as {
                exportResultSetToFile: jest.Mock;
            };
            expect(resultExporterModule.exportResultSetToFile).toHaveBeenCalledWith(
                returnedResult,
                'D:\\tmp\\query-export.csv',
                expect.objectContaining({ format: 'csv' })
            );
            expect(vscodeWindow.showInformationMessage).toHaveBeenCalledWith('Results exported to D:\\tmp\\query-export.csv');

            await connectionManager.dispose();
        });
    });
});

/**
 * Integration test utilities
 */
export class IntegrationTestUtils {
    /**
     * Create a mock ExtensionContext for testing
     */
    static createMockContext(): vscode.ExtensionContext {
        const secretsStore = new Map<string, string>();
        const globalState = new Map<string, unknown>();

        return {
            secrets: {
                get: async (key: string) => secretsStore.get(key),
                store: async (key: string, value: string) => {
                    secretsStore.set(key, value);
                },
                delete: async (key: string) => {
                    secretsStore.delete(key);
                }
            },
            globalState: {
                get: (key: string) => globalState.get(key),
                update: async (key: string, value: unknown) => {
                    if (value === undefined) {
                        globalState.delete(key);
                    } else {
                        globalState.set(key, value);
                    }
                }
            },
            extensionUri: { fsPath: '/test', toString: () => 'file:///test' } as vscode.Uri,
            subscriptions: []
        } as unknown as vscode.ExtensionContext;
    }

    /**
     * Create a sample connection for testing
     */
    static createSampleConnection(overrides?: Partial<ConnectionDetails>): ConnectionDetails {
        return {
            name: 'TestConnection',
            host: 'localhost',
            port: 5480,
            database: 'testdb',
            user: 'testuser',
            password: 'testpass',
            ...overrides
        };
    }

    /**
     * Wait for a promise to resolve with timeout
     */
    static async waitForPromise<T>(promise: Promise<T>, timeoutMs: number = 5000): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
        ]);
    }
}
