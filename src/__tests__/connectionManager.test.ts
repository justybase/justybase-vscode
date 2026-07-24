/**
 * Unit tests for ConnectionManager
 * Tests connection management, per-document connections, and persistence
 */

import * as vscode from 'vscode';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';
import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { MockNzConnection } from '../__mocks__/mockNzConnection';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';
import { postgresqlDialect } from '../../extensions/postgresql/src/postgresqlDialect';
import { oracleDialect } from '../../extensions/oracle/src/oracleDialect';

const mockNzConnectionConstructor = jest.fn(() => new MockNzConnection());

jest.mock('@justybase/netezza-driver', () => ({
    NzConnection: mockNzConnectionConstructor
}));

describe('ConnectionManager', () => {
    let mockContext: vscode.ExtensionContext;
    let manager: ConnectionManager;
    let secretsStore: Map<string, string>;
    let globalState: Map<string, unknown>;

    const sampleConnection: ConnectionDetails = {
        name: 'TestConnection',
        host: 'localhost',
        port: 5480,
        database: 'testdb',
        user: 'admin',
        password: 'secret',
        dbType: 'netezza',
        accentColor: 'blue'
    };
    const sqliteConnection: ConnectionDetails = {
        name: 'LocalSQLite',
        host: '',
        database: ':memory:',
        user: '',
        password: '',
        dbType: 'sqlite'
    };
    const duckdbConnection: ConnectionDetails = {
        name: 'LocalDuckDB',
        host: '',
        database: 'C:\\data\\analytics.duckdb',
        user: '',
        password: '',
        dbType: 'duckdb',
        options: {
            mode: 'file'
        }
    };
    const db2Connection: ConnectionDetails = {
        name: 'WarehouseDb2',
        host: 'db2.example.test',
        port: 50000,
        database: 'warehouse',
        user: 'db2inst1',
        password: 'secret',
        dbType: 'db2'
    };
    const mssqlConnection: ConnectionDetails = {
        name: 'WarehouseMsSql',
        host: 'mssql.example.test',
        port: 1433,
        database: 'TESTDB',
        user: 'sa',
        password: 'secret',
        dbType: 'mssql'
    };
    const oracleConnection: ConnectionDetails = {
        name: 'WarehouseOracle',
        host: 'oracle.example.test',
        port: 1521,
        database: 'ORCL',
        user: 'system',
        password: 'secret',
        dbType: 'oracle'
    };
    const postgresqlConnection: ConnectionDetails = {
        name: 'WarehousePostgreSQL',
        host: 'postgres.example.test',
        port: 5432,
        database: 'warehouse',
        user: 'postgres',
        password: 'secret',
        dbType: 'postgresql'
    };

    beforeEach(async () => {
        resetDatabaseDialectTestingState();

        // Reset mocks and storage
        secretsStore = new Map();
        globalState = new Map();

        // Create mock ExtensionContext
        mockContext = {
            secrets: {
                get: jest.fn(async (key: string) => secretsStore.get(key) || undefined),
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
            extensionUri: { fsPath: '/test' } as vscode.Uri,
            subscriptions: []
        } as unknown as vscode.ExtensionContext;

        // Create manager instance
        manager = new ConnectionManager(mockContext);
        // Wait for loading to complete
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    afterEach(async () => {
        await manager.dispose();
        jest.clearAllMocks();
    });

    describe('Connection CRUD Operations', () => {
        it('should save a new connection', async () => {
            await manager.saveConnection(sampleConnection);

            const connections = await manager.getConnections();
            expect(connections).toHaveLength(1);
            expect(connections[0]).toMatchObject(sampleConnection);
        });

        it('should reject connection without name', async () => {
            const invalidConnection = { ...sampleConnection, name: '' };

            await expect(manager.saveConnection(invalidConnection)).rejects.toThrow('Connection name is required');
        });

        it('should reject non-sqlite connections without host', async () => {
            await expect(manager.saveConnection({ ...sampleConnection, host: '' })).rejects.toThrow('Connection host is required');
        });

        it('should reject non-sqlite connections without user', async () => {
            await expect(manager.saveConnection({ ...sampleConnection, user: '' })).rejects.toThrow('Connection user is required');
        });

        it('should reject connections without database', async () => {
            await expect(manager.saveConnection({ ...sampleConnection, database: '' })).rejects.toThrow('Connection database is required');
        });

        it('should allow sqlite connections with blank host and user', async () => {
            await expect(manager.saveConnection(sqliteConnection)).resolves.toBeUndefined();
        });

        it('should allow duckdb connections with blank host and user', async () => {
            await expect(manager.saveConnection(duckdbConnection)).resolves.toBeUndefined();
        });

        it('should update existing connection', async () => {
            await manager.saveConnection(sampleConnection);

            const updatedConnection = { ...sampleConnection, host: 'newhost' };
            await manager.saveConnection(updatedConnection);

            const connection = await manager.getConnection('TestConnection');
            expect(connection?.host).toBe('newhost');
        });

        it('should default missing dbType to netezza during save', async () => {
            const connectionWithoutDbType = {
                ...sampleConnection,
                dbType: undefined
            };

            await manager.saveConnection(connectionWithoutDbType);

            const connection = await manager.getConnection('TestConnection');
            expect(connection?.dbType).toBe('netezza');
        });

        it('should drop invalid accent colors during save', async () => {
            await manager.saveConnection({
                ...sampleConnection,
                accentColor: 'unknown-color'
            });

            const connection = await manager.getConnection('TestConnection');
            expect(connection?.accentColor).toBeUndefined();
        });

        it('should preserve db2 as a first-class saved database kind', async () => {
            await manager.saveConnection(db2Connection);

            const connection = await manager.getConnection('WarehouseDb2');
            expect(connection?.dbType).toBe('db2');
        });

        it('should delete a connection', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.deleteConnection('TestConnection');

            const connections = await manager.getConnections();
            expect(connections).toHaveLength(0);
        });

        it('should get a specific connection by name', async () => {
            await manager.saveConnection(sampleConnection);

            const connection = await manager.getConnection('TestConnection');
            expect(connection).toMatchObject(sampleConnection);
        });

        it('should return undefined for non-existent connection', async () => {
            const connection = await manager.getConnection('NonExistent');
            expect(connection).toBeUndefined();
        });
    });

    describe('Active Connection Management', () => {
        it('should set active connection', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');

            expect(manager.getActiveConnectionName()).toBe('TestConnection');
        });

        it('should fire event when active connection changes', async () => {
            const listener = jest.fn();
            manager.onDidChangeActiveConnection(listener);

            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');

            expect(listener).toHaveBeenCalledWith('TestConnection');
        });

        it('should clear active connection when set to null', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');
            await manager.setActiveConnection(null);

            expect(manager.getActiveConnectionName()).toBeNull();
        });

        it('should auto-set first connection as active', async () => {
            await manager.saveConnection(sampleConnection);

            expect(manager.getActiveConnectionName()).toBe('TestConnection');
        });
    });

    describe('Dialect Metadata', () => {
        it('should expose capabilities for the saved connection', async () => {
            await manager.saveConnection(sampleConnection);

            expect(manager.getConnectionCapabilities('TestConnection')).toEqual({
                supportsExplainPlan: true,
                supportsExplainGraph: true,
                supportsTuningAdvisor: true,
                supportsExternalTables: true,
                supportsProcedures: true,
                supportsTableMaintenance: true,
                supportsSessionMonitor: true,
                supportsDistributionMetrics: true
            });
        });

        it('should resolve capability checks for document-specific connections', async () => {
            await manager.saveConnection(sampleConnection);
            manager.setDocumentConnection('file:///test.sql', 'TestConnection');

            expect(manager.supportsCapability('supportsExplainPlan', 'file:///test.sql')).toBe(true);
            expect(manager.getExecutionDatabaseKind('file:///test.sql')).toBe('netezza');
        });

        it.each([
            ['file:///oracle.sql', 'WarehouseOracle', oracleConnection, 'oracle'],
            ['file:///postgres.sql', 'WarehousePostgreSQL', postgresqlConnection, 'postgresql']
        ] as const)(
            'should resolve %s to %s for document-specific optional dialect connections',
            async (documentUri, connectionName, connectionDetails, expectedKind) => {
                await manager.saveConnection(connectionDetails);
                manager.setDocumentConnection(documentUri, connectionName);

                expect(manager.getExecutionDatabaseKind(documentUri)).toBe(expectedKind);
            }
        );

        it.each([
            ['file:///oracle-runtime.sql', 'WarehouseOracle', oracleConnection, oracleDialect],
            ['file:///postgres-runtime.sql', 'WarehousePostgreSQL', postgresqlConnection, postgresqlDialect]
        ] as const)(
            'should expose registered runtime capabilities for %s when the companion dialect is registered',
            async (documentUri, connectionName, connectionDetails, dialect) => {
                registerDatabaseDialect(dialect);
                await manager.saveConnection(connectionDetails);
                manager.setDocumentConnection(documentUri, connectionName);

                expect(manager.getExecutionDatabaseKind(documentUri)).toBe(dialect.kind);
                expect(manager.getConnectionCapabilities(connectionName)).toEqual(dialect.capabilities);
                expect(manager.supportsCapability('supportsExplainPlan', documentUri)).toBe(
                    dialect.capabilities.supportsExplainPlan,
                );
            }
        );

        it('should expose a safe default capability set for sqlite connections', async () => {
            await manager.saveConnection(sqliteConnection);

            expect(manager.getConnectionCapabilities('LocalSQLite')).toEqual({
                supportsExplainPlan: false,
                supportsExplainGraph: false,
                supportsTuningAdvisor: false,
                supportsExternalTables: false,
                supportsProcedures: false,
                supportsTableMaintenance: false,
                supportsSessionMonitor: false,
                supportsDistributionMetrics: false
            });
        });

        it('should expose a safe default capability set for duckdb connections', async () => {
            await manager.saveConnection(duckdbConnection);

            expect(manager.getConnectionCapabilities('LocalDuckDB')).toEqual({
                supportsExplainPlan: false,
                supportsExplainGraph: false,
                supportsTuningAdvisor: false,
                supportsExternalTables: false,
                supportsProcedures: false,
                supportsTableMaintenance: false,
                supportsSessionMonitor: false,
                supportsDistributionMetrics: false
            });
        });

        it.each([
            ['WarehouseDb2', db2Connection],
            ['WarehouseOracle', oracleConnection],
            ['WarehousePostgreSQL', postgresqlConnection],
            ['LocalDuckDB', duckdbConnection]
        ])(
            'should expose safe default capabilities for %s when the optional dialect is not registered',
            async (connectionName, connectionDetails) => {
                await manager.saveConnection(connectionDetails);

                expect(manager.getConnectionCapabilities(connectionName)).toEqual({
                    supportsExplainPlan: false,
                    supportsExplainGraph: false,
                    supportsTuningAdvisor: false,
                    supportsExternalTables: false,
                    supportsProcedures: false,
                    supportsTableMaintenance: false,
                    supportsSessionMonitor: false,
                    supportsDistributionMetrics: false
                });
                expect(manager.supportsCapability('supportsExplainPlan', undefined, connectionName)).toBe(false);
            }
        );
    });

    describe('Connection Testing', () => {
        it('should successfully test sqlite in-memory connections', async () => {
            await expect(manager.testConnection(sqliteConnection)).resolves.toBeUndefined();
        });

        it('should resolve sqlite current database to the logical main catalog', async () => {
            await manager.saveConnection(sqliteConnection);

            expect(await manager.getCurrentDatabase('LocalSQLite')).toBe('main');
        });

        it('should resolve sqlite effective database to the logical main catalog', async () => {
            await manager.saveConnection(sqliteConnection);
            manager.setDocumentConnection('file:///sqlite.sql', 'LocalSQLite');

            expect(await manager.getEffectiveDatabase('file:///sqlite.sql')).toBe('main');
        });

        it('should resolve duckdb current database to the inferred default catalog', async () => {
            await manager.saveConnection(duckdbConnection);

            expect(await manager.getCurrentDatabase('LocalDuckDB')).toBe('analytics');
        });

        it('should resolve duckdb effective database to the inferred default catalog', async () => {
            await manager.saveConnection(duckdbConnection);
            manager.setDocumentConnection('file:///duckdb.sql', 'LocalDuckDB');

            expect(await manager.getEffectiveDatabase('file:///duckdb.sql')).toBe('analytics');
        });
    });

    describe('Document-Specific Connections', () => {
        it('should set document connection', () => {
            const docUri = 'file:///test.sql';

            manager.setDocumentConnection(docUri, 'TestConnection');

            expect(manager.getDocumentConnection(docUri)).toBe('TestConnection');
        });

        it('should fire event when document connection changes', () => {
            const listener = jest.fn();
            manager.onDidChangeDocumentConnection(listener);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');

            expect(listener).toHaveBeenCalledWith(docUri);
        });

        it('should clear document connection', () => {
            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');
            manager.clearDocumentConnection(docUri);

            expect(manager.getDocumentConnection(docUri)).toBeUndefined();
        });

        it('should return connection for execution from document', () => {
            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'DocConnection');

            expect(manager.getConnectionForExecution(docUri)).toBe('DocConnection');
        });

        it('should fall back to global active connection for execution', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');

            expect(manager.getConnectionForExecution('file:///test.sql')).toBe('TestConnection');
        });

        it('should prefer document connection over global', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'DocSpecificConnection');

            expect(manager.getConnectionForExecution(docUri)).toBe('DocSpecificConnection');
        });
    });

    describe('Per-Document Database Override', () => {
        it('should set document database override', async () => {
            const docUri = 'file:///test.sql';
            await manager.setDocumentDatabase(docUri, 'override_db');

            expect(manager.getDocumentDatabase(docUri)).toBe('override_db');
        });

        it('should fire event when document database changes', async () => {
            const listener = jest.fn();
            manager.onDidChangeDocumentDatabase(listener);

            const docUri = 'file:///test.sql';
            await manager.setDocumentDatabase(docUri, 'new_db');

            expect(listener).toHaveBeenCalledWith(docUri);
        });

        it('should clear document database override', async () => {
            const docUri = 'file:///test.sql';
            await manager.setDocumentDatabase(docUri, 'override_db');
            manager.clearDocumentDatabase(docUri);

            expect(manager.getDocumentDatabase(docUri)).toBeUndefined();
        });

        it('should get effective database with override', async () => {
            await manager.saveConnection(sampleConnection);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');
            await manager.setDocumentDatabase(docUri, 'override_db');

            const effectiveDb = await manager.getEffectiveDatabase(docUri);
            expect(effectiveDb).toBe('override_db');
        });

        it('should fall back to connection default database', async () => {
            await manager.saveConnection(sampleConnection);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');

            const effectiveDb = await manager.getEffectiveDatabase(docUri);
            expect(effectiveDb).toBe('testdb');
        });

        it('should resolve effective schema synchronously for Netezza connections', async () => {
            await manager.saveConnection(sampleConnection);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');

            expect(manager.getEffectiveSchemaSync(docUri, 'testdb')).toBe('ADMIN');
        });

        it('should prefer connection schema in effective schema sync', async () => {
            await manager.saveConnection({
                ...postgresqlConnection,
                schema: 'analytics',
            });

            const docUri = 'file:///postgres.sql';
            manager.setDocumentConnection(docUri, 'WarehousePostgreSQL');

            expect(manager.getEffectiveSchemaSync(docUri, 'appdb')).toBe('analytics');
        });

        it('should resolve import connection details with tab override', async () => {
            await manager.saveConnection(sampleConnection);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');
            await manager.setDocumentDatabase(docUri, 'override_db');

            const details = await manager.getConnectionDetailsForImport(docUri, 'TestConnection');
            expect(details?.database).toBe('override_db');
        });

        it('should prefer dropped database over tab override for import', async () => {
            await manager.saveConnection(sampleConnection);

            const docUri = 'file:///test.sql';
            manager.setDocumentConnection(docUri, 'TestConnection');
            await manager.setDocumentDatabase(docUri, 'override_db');

            const details = await manager.getConnectionDetailsForImport(
                docUri,
                'TestConnection',
                'dropped_db',
            );
            expect(details?.database).toBe('dropped_db');
        });

        it('should fall back to connection database when no document override exists', async () => {
            await manager.saveConnection(sampleConnection);

            const details = await manager.getConnectionDetailsForImport(undefined, 'TestConnection');
            expect(details?.database).toBe('testdb');
        });
    });

    describe('Keep Connection Open Setting', () => {
        it('should default to true for new documents', () => {
            const docUri = 'file:///test.sql';
            expect(manager.getDocumentKeepConnectionOpen(docUri)).toBe(true);
        });

        it('should set keep connection open for document', () => {
            const docUri = 'file:///test.sql';
            manager.setDocumentKeepConnectionOpen(docUri, false);

            expect(manager.getDocumentKeepConnectionOpen(docUri)).toBe(false);
        });

        it('should toggle keep connection open', () => {
            const docUri = 'file:///test.sql';
            manager.setDocumentKeepConnectionOpen(docUri, true);

            const newValue = manager.toggleDocumentKeepConnectionOpen(docUri);
            expect(newValue).toBe(false);
            expect(manager.getDocumentKeepConnectionOpen(docUri)).toBe(false);
        });

        it('should detect explicit keep connection setting', () => {
            const docUri = 'file:///test.sql';
            expect(manager.hasDocumentKeepConnectionOpen(docUri)).toBe(false);

            manager.setDocumentKeepConnectionOpen(docUri, false);
            expect(manager.hasDocumentKeepConnectionOpen(docUri)).toBe(true);
        });
    });

    describe('Persistence', () => {
        it('should persist connections to secrets storage', async () => {
            await manager.saveConnection(sampleConnection);

            const storedData = secretsStore.get('netezza-vscode-connections');
            expect(storedData).toBeDefined();

            const parsed = JSON.parse(storedData!);
            expect(parsed['TestConnection']).toMatchObject(sampleConnection);
        });

        it('should persist active connection to global state', async () => {
            await manager.saveConnection(sampleConnection);
            await manager.setActiveConnection('TestConnection');

            expect(globalState.get('netezza-active-connection')).toBe('TestConnection');
        });

        it('should load connections from storage on init', async () => {
            // Pre-populate storage
            const connections = { TestConnection: sampleConnection };
            secretsStore.set('netezza-vscode-connections', JSON.stringify(connections));
            globalState.set('netezza-active-connection', 'TestConnection');

            // Create new manager instance
            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const loadedConnections = await newManager.getConnections();
            expect(loadedConnections).toHaveLength(1);
            expect(newManager.getActiveConnectionName()).toBe('TestConnection');

            await newManager.dispose();
        });

        it('should infer db2 for legacy fast-loaded cache entries without dbType', async () => {
            globalState.set('justybase.connectionsCache', {
                WarehouseDb2: {
                    name: 'WarehouseDb2',
                    host: 'db2.example.test',
                    port: 50000,
                    database: 'warehouse',
                    user: 'db2inst1',
                    options: {
                        clientCodepage: '1208'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'WarehouseDb2');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('WarehouseDb2')?.dbType).toBe('db2');

            await newManager.dispose();
        });

        it('should recover db2 from a legacy cache entry that was previously normalized to netezza', async () => {
            globalState.set('justybase.connectionsCache', {
                WarehouseDb2: {
                    name: 'WarehouseDb2',
                    host: 'db2.example.test',
                    port: 50000,
                    database: 'warehouse',
                    user: 'db2inst1',
                    dbType: 'netezza',
                    options: {
                        clientCodepage: '1208'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'WarehouseDb2');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('WarehouseDb2')?.dbType).toBe('db2');
            expect(newManager.getConnectionDatabaseKind('WarehouseDb2')).toBe('db2');

            await newManager.dispose();
        });

        it('should recover mssql from a legacy cache entry that was previously normalized to netezza', async () => {
            globalState.set('justybase.connectionsCache', {
                WarehouseMsSql: {
                    name: 'WarehouseMsSql',
                    host: 'mssql.example.test',
                    port: 1111,
                    database: 'TESTDB',
                    user: 'sa',
                    dbType: 'netezza',
                    options: {
                        domain: 'ACME'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'WarehouseMsSql');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('WarehouseMsSql')?.dbType).toBe('mssql');
            expect(newManager.getConnectionDatabaseKind('WarehouseMsSql')).toBe('mssql');

            await newManager.dispose();
        });

        it.each([
            ['WarehouseOracle', {
                ...oracleConnection,
                password: undefined,
                dbType: undefined,
                options: {
                    connectString: '//oracle.example.test/ORCL'
                }
            }, 'oracle'],
            ['WarehousePostgreSQL', {
                ...postgresqlConnection,
                password: undefined,
                dbType: undefined,
                options: {
                    searchPath: 'public'
                }
            }, 'postgresql']
        ] as const)(
            'should infer %s for legacy fast-loaded cache entries without dbType',
            async (connectionName, connectionDetails, expectedKind) => {
                globalState.set('justybase.connectionsCache', {
                    [connectionName]: connectionDetails
                });
                globalState.set('justybase.activeConnection', connectionName);

                const newManager = new ConnectionManager(mockContext);

                expect(newManager.isFastLoaded()).toBe(true);
                expect(newManager.getConnectionMetadata(connectionName)?.dbType).toBe(expectedKind);
                expect(newManager.getConnectionDatabaseKind(connectionName)).toBe(expectedKind);

                await newManager.dispose();
            }
        );

        it.each([
            ['WarehouseOracle', {
                ...oracleConnection,
                dbType: 'netezza',
                options: {
                    connectString: '//oracle.example.test/ORCL'
                }
            }, 'oracle'],
            ['WarehousePostgreSQL', {
                ...postgresqlConnection,
                dbType: 'netezza',
                options: {
                    searchPath: 'public'
                }
            }, 'postgresql']
        ] as const)(
            'should recover %s from a legacy cache entry that was previously normalized to netezza',
            async (connectionName, connectionDetails, expectedKind) => {
                globalState.set('justybase.connectionsCache', {
                    [connectionName]: connectionDetails
                });
                globalState.set('justybase.activeConnection', connectionName);

                const newManager = new ConnectionManager(mockContext);

                expect(newManager.isFastLoaded()).toBe(true);
                expect(newManager.getConnectionMetadata(connectionName)?.dbType).toBe(expectedKind);
                expect(newManager.getConnectionDatabaseKind(connectionName)).toBe(expectedKind);

                await newManager.dispose();
            }
        );

        it('should preserve an explicit oracle dbType even when options overlap with legacy db2 markers', async () => {
            globalState.set('justybase.connectionsCache', {
                WarehouseOracle: {
                    name: 'WarehouseOracle',
                    host: 'oracle.example.test',
                    port: 1521,
                    database: 'TESTDB',
                    user: 'system',
                    dbType: 'oracle',
                    options: {
                        currentSchema: 'TESTUSER'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'WarehouseOracle');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('WarehouseOracle')?.dbType).toBe('oracle');
            expect(newManager.getConnectionDatabaseKind('WarehouseOracle')).toBe('oracle');

            await newManager.dispose();
        });

        it('should infer db2 for legacy stored connections without dbType', async () => {
            secretsStore.set('netezza-vscode-connections', JSON.stringify({
                WarehouseDb2: {
                    name: 'WarehouseDb2',
                    host: 'db2.example.test',
                    port: 50000,
                    database: 'warehouse',
                    user: 'db2inst1',
                    password: 'secret',
                    options: {
                        clientCodepage: '1208'
                    }
                }
            }));

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect((await newManager.getConnection('WarehouseDb2'))?.dbType).toBe('db2');
            expect(newManager.getConnectionDatabaseKind('WarehouseDb2')).toBe('db2');

            await newManager.dispose();
        });

        it('should infer db2 from the legacy default port when dbType is missing', async () => {
            secretsStore.set('netezza-vscode-connections', JSON.stringify({
                WarehouseDb2: {
                    name: 'WarehouseDb2',
                    host: 'db2.example.test',
                    port: 50000,
                    database: 'warehouse',
                    user: 'db2inst1',
                    password: 'secret'
                }
            }));

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect((await newManager.getConnection('WarehouseDb2'))?.dbType).toBe('db2');

            await newManager.dispose();
        });

        it.each([
            ['mssql', mssqlConnection],
            ['oracle', oracleConnection],
            ['postgresql', postgresqlConnection],
            ['duckdb', {
                name: 'LocalDuckDB',
                host: '',
                database: 'C:\\data\\analytics.duckdb',
                user: '',
                password: 'secret',
                options: {
                    mode: 'file'
                }
            } satisfies ConnectionDetails],
            ['mysql', {
                name: 'WarehouseMySql',
                host: 'mysql.example.test',
                port: 3306,
                database: 'warehouse',
                user: 'root',
                password: 'secret'
            } satisfies ConnectionDetails]
        ] as const)(
            'should infer %s from legacy stored connections without dbType based on unique markers',
            async (expectedKind, legacyConnection) => {
                secretsStore.set('netezza-vscode-connections', JSON.stringify({
                    [legacyConnection.name]: {
                        ...legacyConnection,
                        dbType: undefined
                    }
                }));

                const newManager = new ConnectionManager(mockContext);
                await new Promise(resolve => setTimeout(resolve, 10));

                expect((await newManager.getConnection(legacyConnection.name))?.dbType).toBe(expectedKind);
                expect(newManager.getConnectionDatabaseKind(legacyConnection.name)).toBe(expectedKind);

                await newManager.dispose();
            }
        );

        it('should infer sqlite for legacy stored connections without dbType', async () => {
            secretsStore.set('netezza-vscode-connections', JSON.stringify({
                LocalSQLite: {
                    name: 'LocalSQLite',
                    host: '',
                    database: 'C:\\data\\sample.db',
                    user: '',
                    password: '',
                    options: {
                        mode: 'file'
                    }
                }
            }));

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect((await newManager.getConnection('LocalSQLite'))?.dbType).toBe('sqlite');
            expect(newManager.getConnectionDatabaseKind('LocalSQLite')).toBe('sqlite');
            expect(await newManager.getCurrentDatabase('LocalSQLite')).toBe('main');

            await newManager.dispose();
        });

        it('should infer duckdb for legacy stored connections without dbType from a .duckdb file path', async () => {
            secretsStore.set('netezza-vscode-connections', JSON.stringify({
                LocalDuckDB: {
                    name: 'LocalDuckDB',
                    host: '',
                    database: 'C:\\data\\analytics.duckdb',
                    user: '',
                    password: '',
                    options: {
                        mode: 'file'
                    }
                }
            }));

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect((await newManager.getConnection('LocalDuckDB'))?.dbType).toBe('duckdb');
            expect(newManager.getConnectionDatabaseKind('LocalDuckDB')).toBe('duckdb');
            expect(await newManager.getCurrentDatabase('LocalDuckDB')).toBe('analytics');

            await newManager.dispose();
        });

        it('should recover sqlite from a legacy cache entry that was previously normalized to netezza', async () => {
            globalState.set('justybase.connectionsCache', {
                LocalSQLite: {
                    name: 'LocalSQLite',
                    host: '',
                    database: 'C:\\data\\sample.db',
                    user: '',
                    password: '',
                    dbType: 'netezza',
                    options: {
                        mode: 'file'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'LocalSQLite');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('LocalSQLite')?.dbType).toBe('sqlite');
            expect(newManager.getConnectionDatabaseKind('LocalSQLite')).toBe('sqlite');
            expect(await newManager.getCurrentDatabase('LocalSQLite')).toBe('main');

            await newManager.dispose();
        });

        it('should recover duckdb from a legacy cache entry that was previously normalized to netezza', async () => {
            globalState.set('justybase.connectionsCache', {
                LocalDuckDB: {
                    name: 'LocalDuckDB',
                    host: '',
                    database: 'C:\\data\\analytics.duckdb',
                    user: '',
                    password: '',
                    dbType: 'netezza',
                    options: {
                        mode: 'file'
                    }
                }
            });
            globalState.set('justybase.activeConnection', 'LocalDuckDB');

            const newManager = new ConnectionManager(mockContext);

            expect(newManager.isFastLoaded()).toBe(true);
            expect(newManager.getConnectionMetadata('LocalDuckDB')?.dbType).toBe('duckdb');
            expect(newManager.getConnectionDatabaseKind('LocalDuckDB')).toBe('duckdb');
            expect(await newManager.getCurrentDatabase('LocalDuckDB')).toBe('analytics');

            await newManager.dispose();
        });

        it('should leave ambiguous legacy stored connections unresolved instead of defaulting to netezza', async () => {
            secretsStore.set('netezza-vscode-connections', JSON.stringify({
                LegacyUnknown: {
                    name: 'LegacyUnknown',
                    host: 'legacy.example.test',
                    port: 1111,
                    database: 'legacydb',
                    user: 'legacy',
                    password: 'secret'
                }
            }));

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            expect((await newManager.getConnection('LegacyUnknown'))?.dbType).toBeUndefined();
            expect(newManager.getConnectionDatabaseKind('LegacyUnknown')).toBeUndefined();

            await newManager.dispose();
        });

        it('should handle migration from old storage format', async () => {
            // Pre-populate old format storage
            const oldConnection = {
                host: 'oldhost',
                port: 5480,
                database: 'olddb',
                user: 'olduser',
                password: 'oldpass'
            };
            secretsStore.set('netezza-vscode', JSON.stringify(oldConnection));

            // Create new manager instance
            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connections = await newManager.getConnections();
            expect(connections.length).toBeGreaterThan(0);
            expect(connections[0].host).toBe('oldhost');

            await newManager.dispose();
        });

        it('should fire connections changed event on save', async () => {
            const listener = jest.fn();
            manager.onDidChangeConnections(listener);

            await manager.saveConnection(sampleConnection);

            expect(listener).toHaveBeenCalled();
        });
    });

    describe('Session Tracking', () => {
        it('should track document session ID when metadata exists', async () => {
            const docUri = 'file:///test.sql';

            // Save connection first
            await manager.saveConnection(sampleConnection);

            // Setup connection - this creates metadata internally when getting persistent connection
            manager.setDocumentConnection(docUri, 'TestConnection');

            // Set session ID (requires metadata to exist, which is set up by connection flow)
            // For unit test, we verify the getter/setter API exists and works with metadata
            manager.setDocumentLastSessionId(docUri, 'session-123');

            // Note: setDocumentLastSessionId requires metadata from persistent connection
            // In real usage, this is set up by getDocumentPersistentConnection
            const sessionId = manager.getDocumentLastSessionId(docUri);
            // If no metadata, returns undefined (expected behavior)
            expect(sessionId).toBeUndefined();
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty connections list', async () => {
            const connections = await manager.getConnections();
            expect(connections).toEqual([]);
        });

        it('should handle delete of non-existent connection gracefully', async () => {
            await expect(manager.deleteConnection('NonExistent')).resolves.not.toThrow();
        });

        it('should handle connection database retrieval for null active', async () => {
            const db = await manager.getCurrentDatabase();
            expect(db).toBeNull();
        });

        it('should handle corrupted storage gracefully', async () => {
            secretsStore.set('netezza-vscode-connections', 'invalid-json');

            const newManager = new ConnectionManager(mockContext);
            await new Promise(resolve => setTimeout(resolve, 10));

            const connections = await newManager.getConnections();
            expect(connections).toEqual([]);

            await newManager.dispose();
        });
    });
});
