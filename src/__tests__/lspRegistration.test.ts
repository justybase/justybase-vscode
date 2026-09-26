import { handleMetadataRequest } from '../activation/lspRegistration'
import type { ConnectionManager } from '../core/connectionManager'
import * as vscode from 'vscode'
import { MetadataCache } from '../metadataCache'
import type { TableMetadata } from '../metadata/types'
import type { MetadataProvider } from '../providers/providers/metadataProvider'
import { DEFAULT_JOIN_COMPLETION_SETTINGS } from '../lsp/joinCompletionSettings'

jest.mock('../utils/logger', () => ({
    getLogger: () => ({
        error: jest.fn(),
        info: jest.fn()
    })
}))

jest.mock('../dialects/netezza/metadata/netezzaSchemaContext', () => ({
    resolveNetezzaSchemasEnabled: jest.fn(async () => false),
    resolveNetezzaDefaultSchema: jest.fn(async () => 'ADMIN'),
}))

const mockExtensionContext = { subscriptions: [] } as unknown as import('vscode').ExtensionContext

function createConnectionManager(
    databaseKind: 'access' | 'db2' | 'oracle' | 'postgresql' | 'netezza',
    options: { effectiveDatabase?: string; effectiveSchema?: string } = {}
): ConnectionManager {
    return {
        ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
        getConnectionForExecution: jest.fn().mockReturnValue('CONN_1'),
        getEffectiveDatabase: jest.fn().mockResolvedValue(options.effectiveDatabase ?? 'TESTDB'),
        getExecutionDatabaseKind: jest.fn().mockReturnValue(databaseKind),
        getEffectiveSchema: jest.fn().mockResolvedValue(options.effectiveSchema)
    } as unknown as ConnectionManager
}

function createTableMetadata(name: string, objectType: 'TABLE' | 'VIEW', schema?: string): TableMetadata {
    return {
        OBJNAME: name,
        TABLENAME: name,
        SCHEMA: schema,
        label: name,
        objType: objectType,
        detail: objectType === 'VIEW' ? 'View' : 'Table'
    }
}

describe('handleMetadataRequest view lookups', () => {
    it('does not start a live Netezza list query for cache-only completion', async () => {
        const metadataProvider = {
            getDatabases: jest.fn().mockResolvedValue([])
        } as unknown as MetadataProvider
        const metadataCache = {
            getDatabases: jest.fn().mockReturnValue(undefined)
        } as unknown as MetadataCache

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///completion.sql',
                kind: 'databases',
                cacheOnly: true
            },
            mockExtensionContext,
            metadataProvider,
            metadataCache,
            createConnectionManager('netezza')
        )

        expect(metadataProvider.getDatabases).not.toHaveBeenCalled()
        expect(response).toEqual([])
    })

    it.each([
        ['postgresql', 'APPDB', 'public'],
        ['oracle', 'ORCL', 'HR']
    ] as const)(
        'returns %s context payload with effective schema and database kind',
        async (databaseKind, effectiveDatabase, effectiveSchema) => {
            const connectionManager = createConnectionManager(databaseKind, {
                effectiveDatabase,
                effectiveSchema
            })

            const response = await handleMetadataRequest(
                { documentUri: 'file:///completion.sql', kind: 'context' },
                mockExtensionContext,
                {} as MetadataProvider,
                {} as MetadataCache,
                connectionManager
            )

            expect(connectionManager.ensureFullyLoaded).toHaveBeenCalled()
            expect(connectionManager.getConnectionForExecution).toHaveBeenCalledWith('file:///completion.sql')
            expect(connectionManager.getEffectiveDatabase).toHaveBeenCalledWith('file:///completion.sql')
            expect(connectionManager.getExecutionDatabaseKind).toHaveBeenCalledWith('file:///completion.sql')
            expect(connectionManager.getEffectiveSchema).toHaveBeenCalledWith('file:///completion.sql')
            expect(response).toEqual({
                connectionName: 'CONN_1',
                effectiveDatabase,
                effectiveSchema,
                databaseKind,
                joinCompletionSettings: DEFAULT_JOIN_COMPLETION_SETTINGS,
            })
        }
    )

    it.each(['db2', 'oracle'] as const)(
        'reloads %s database-level views when the shared cache currently contains only tables',
        async databaseKind => {
            const metadataCache = {
                getTables: jest.fn()
                    .mockReturnValueOnce([
                        createTableMetadata('EMPLOYEES', 'TABLE')
                    ])
                    .mockReturnValueOnce([
                        createTableMetadata('EMPLOYEES', 'TABLE'),
                        createTableMetadata('EMP_VIEW', 'VIEW')
                    ]),
                getTablesAllSchemas: jest.fn()
            } as unknown as MetadataCache

            const metadataProvider = {
                getViews: jest.fn().mockResolvedValue([])
            } as unknown as MetadataProvider

            const response = await handleMetadataRequest(
                { documentUri: 'file:///completion.sql', kind: 'views' },
                mockExtensionContext,
                metadataProvider,
                metadataCache,
                createConnectionManager(databaseKind)
            )

            expect((metadataProvider as unknown as { getViews: jest.Mock }).getViews)
                .toHaveBeenCalledWith('CONN_1', 'TESTDB', undefined)
            expect(response).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'EMP_VIEW',
                    database: 'TESTDB',
                    objectType: 'view'
                })
            ]))
        }
    )

    it.each(['db2', 'oracle'] as const)(
        'reloads %s schema-level views when the shared cache currently contains only tables',
        async databaseKind => {
            const metadataCache = {
                getTables: jest.fn()
                    .mockReturnValueOnce([
                        createTableMetadata('EMPLOYEES', 'TABLE', 'DB2INST1')
                    ])
                    .mockReturnValueOnce([
                        createTableMetadata('EMPLOYEES', 'TABLE', 'DB2INST1'),
                        createTableMetadata('EMP_VIEW', 'VIEW', 'DB2INST1')
                    ]),
                getTablesAllSchemas: jest.fn()
            } as unknown as MetadataCache

            const metadataProvider = {
                getViews: jest.fn().mockResolvedValue([])
            } as unknown as MetadataProvider

            const response = await handleMetadataRequest(
                { documentUri: 'file:///completion.sql', kind: 'views', schema: 'DB2INST1' },
                mockExtensionContext,
                metadataProvider,
                metadataCache,
                createConnectionManager(databaseKind)
            )

            expect((metadataProvider as unknown as { getViews: jest.Mock }).getViews)
                .toHaveBeenCalledWith('CONN_1', 'TESTDB', 'DB2INST1')
            expect(response).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'EMP_VIEW',
                    database: 'TESTDB',
                    schema: 'DB2INST1',
                    objectType: 'view'
                })
            ]))
        }
    )
})

describe('handleMetadataRequest cache-backed JOIN targets', () => {
    it('builds exact composite/different-name FK targets once for parallel cold requests', async () => {
        const metadataCache = new MetadataCache({} as vscode.ExtensionContext)
        metadataCache.setTables('CONN_1', 'DB1.PUBLIC', [
            createTableMetadata('CUSTOMER', 'TABLE', 'PUBLIC'),
            createTableMetadata('ORDERS', 'TABLE', 'PUBLIC'),
        ], new Map())
        metadataCache.setColumns('CONN_1', 'DB1.PUBLIC.CUSTOMER', [
            { ATTNAME: 'TENANT_KEY', FORMAT_TYPE: 'INTEGER', isPk: true },
            { ATTNAME: 'CUSTOMER_KEY', FORMAT_TYPE: 'INTEGER', isPk: true },
        ])
        metadataCache.setColumns('CONN_1', 'DB1.PUBLIC.ORDERS', [
            {
                ATTNAME: 'TENANT_ID',
                FORMAT_TYPE: 'INTEGER',
                isFk: true,
                joinReferences: [{
                    fromDatabase: 'DB1', fromSchema: 'PUBLIC', fromTable: 'ORDERS', fromColumn: 'TENANT_ID',
                    toDatabase: 'DB1', toSchema: 'PUBLIC', toTable: 'CUSTOMER', toColumn: 'TENANT_KEY',
                    constraintName: 'FK_ORDERS_CUSTOMER', ordinalPosition: 1,
                }],
            },
            {
                ATTNAME: 'CUSTOMER_ID',
                FORMAT_TYPE: 'INTEGER',
                isFk: true,
                joinReferences: [{
                    fromDatabase: 'DB1', fromSchema: 'PUBLIC', fromTable: 'ORDERS', fromColumn: 'CUSTOMER_ID',
                    toDatabase: 'DB1', toSchema: 'PUBLIC', toTable: 'CUSTOMER', toColumn: 'CUSTOMER_KEY',
                    constraintName: 'FK_ORDERS_CUSTOMER', ordinalPosition: 2,
                }],
            },
        ])
        const getObjectsSpy = jest.spyOn(metadataCache, 'getObjectsByType')
        const getColumnsSpy = jest.spyOn(metadataCache, 'getColumns')
        const request = () => handleMetadataRequest(
            {
                documentUri: 'file:///completion.sql',
                kind: 'cachedJoinTargets',
                joinSources: [{ schema: 'PUBLIC', table: 'CUSTOMER' }],
            },
            mockExtensionContext,
            {} as MetadataProvider,
            metadataCache,
            createConnectionManager('postgresql', { effectiveDatabase: 'DB1', effectiveSchema: 'PUBLIC' }),
        )

        const [left, right] = await Promise.all([request(), request()])
        for (const response of [left, right]) {
            expect(response).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'ORDERS',
                    joinMatches: expect.arrayContaining([
                        expect.objectContaining({
                            sourceTable: 'CUSTOMER',
                            sourceColumn: 'TENANT_KEY',
                            targetColumn: 'TENANT_ID',
                            relationType: 'foreignKey',
                            constraintName: 'FK_ORDERS_CUSTOMER',
                        }),
                        expect.objectContaining({
                            sourceTable: 'CUSTOMER',
                            sourceColumn: 'CUSTOMER_KEY',
                            targetColumn: 'CUSTOMER_ID',
                            relationType: 'foreignKey',
                            ordinalPosition: 2,
                        }),
                    ]),
                }),
            ]))
        }
        expect(getObjectsSpy).toHaveBeenCalledTimes(1)
        expect(getColumnsSpy).toHaveBeenCalledTimes(4)
        await metadataCache.dispose()
    })

    it('includes exact FK targets in referenced schemas but keeps heuristics same-schema only', async () => {
        const metadataCache = new MetadataCache({} as vscode.ExtensionContext)
        metadataCache.setTables('CONN_1', 'DB1.SALES', [
            createTableMetadata('ORDERS', 'TABLE', 'SALES'),
        ], new Map())
        metadataCache.setTables('CONN_1', 'DB1.CRM', [
            createTableMetadata('CUSTOMER', 'TABLE', 'CRM'),
            createTableMetadata('CUSTOMER_ARCHIVE', 'TABLE', 'CRM'),
        ], new Map())
        metadataCache.setColumns('CONN_1', 'DB1.SALES.ORDERS', [
            { ATTNAME: 'CUSTOMER_REF', FORMAT_TYPE: 'INTEGER', isFk: true, joinReferences: [{
                fromDatabase: 'DB1', fromSchema: 'SALES', fromTable: 'ORDERS', fromColumn: 'CUSTOMER_REF',
                toDatabase: 'DB1', toSchema: 'CRM', toTable: 'CUSTOMER', toColumn: 'ID',
                constraintName: 'FK_ORDERS_CUSTOMER', ordinalPosition: 1,
            }] },
        ])
        metadataCache.setColumns('CONN_1', 'DB1.CRM.CUSTOMER', [
            { ATTNAME: 'ID', FORMAT_TYPE: 'INTEGER', isPk: true },
        ])
        metadataCache.setColumns('CONN_1', 'DB1.CRM.CUSTOMER_ARCHIVE', [
            { ATTNAME: 'CUSTOMER_REF', FORMAT_TYPE: 'INTEGER', isPk: true },
        ])

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///completion.sql',
                kind: 'cachedJoinTargets',
                joinSources: [{ schema: 'SALES', table: 'ORDERS' }],
            },
            mockExtensionContext,
            {} as MetadataProvider,
            metadataCache,
            createConnectionManager('postgresql', { effectiveDatabase: 'DB1', effectiveSchema: 'SALES' }),
        )

        expect(response).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'CUSTOMER',
                schema: 'CRM',
                joinMatches: expect.arrayContaining([
                    expect.objectContaining({
                        sourceTable: 'ORDERS',
                        sourceColumn: 'CUSTOMER_REF',
                        targetColumn: 'ID',
                        relationType: 'foreignKey',
                        constraintName: 'FK_ORDERS_CUSTOMER',
                    }),
                ]),
            }),
        ]))
        expect(response).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'CUSTOMER_ARCHIVE', schema: 'CRM' }),
        ]))
        await metadataCache.dispose()
    })

    it('reads updated workspace JOIN settings for each context request', async () => {
        const getConfiguration = vscode.workspace.getConfiguration as jest.Mock
        getConfiguration.mockReturnValueOnce({
            toJSON: () => ({
                joinNameHeuristics: false,
                autoJoinAliases: false,
                joinRelations: [{
                    left: { table: 'CUSTOMER' },
                    right: { table: 'ORDERS' },
                    columns: [{ left: 'ID', right: 'CUSTOMER_ID' }],
                }],
            }),
        })
        const response = await handleMetadataRequest(
            { documentUri: 'file:///completion.sql', kind: 'context' },
            mockExtensionContext,
            {} as MetadataProvider,
            {} as MetadataCache,
            createConnectionManager('postgresql', { effectiveDatabase: 'DB1', effectiveSchema: 'PUBLIC' }),
        )

        expect(response).toEqual(expect.objectContaining({
            joinCompletionSettings: {
                nameHeuristicsEnabled: false,
                autoAliases: false,
                aliases: [],
                relations: [{
                    left: { table: 'CUSTOMER' },
                    right: { table: 'ORDERS' },
                    columns: [{ left: 'ID', right: 'CUSTOMER_ID' }],
                }],
            },
        }))
    })
})

describe('handleMetadataRequest cachedTableInfo', () => {
    it('resolves uppercase cache keys when SQL identifiers are lowercase', async () => {
        const columnStore = new Map<string, Array<{ ATTNAME: string; FORMAT_TYPE: string }>>([
            ['CONN_1|@NZEX@DB1.PUBLIC.ORDERS', [{ ATTNAME: 'ID', FORMAT_TYPE: 'INT4' }]],
        ])
        const metadataCache = {
            getColumns: jest.fn((connectionName: string, key: string) =>
                columnStore.get(`${connectionName}|${key}`),
            ),
            getColumnsAnySchema: jest.fn(),
            getObjectsWithSchema: jest.fn(() => []),
            getTablesAllSchemas: jest.fn(),
            getDatabases: jest.fn(),
        } as unknown as MetadataCache

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///orders.sql',
                kind: 'cachedTableInfo',
                database: 'db1',
                schema: 'public',
                table: 'orders',
            },
            mockExtensionContext,
            {} as MetadataProvider,
            metadataCache,
            createConnectionManager('netezza', { effectiveDatabase: 'db1' }),
        )

        expect(metadataCache.getColumns).toHaveBeenCalledWith('CONN_1', '@NZEX@DB1.PUBLIC.ORDERS')
        expect(response).toEqual({
            exists: true,
            table: 'orders',
            database: 'db1',
            schema: 'public',
            columns: [{ name: 'ID', type: 'INT4' }],
        })
    })

    it('resolves schema from findObjectWithType for unqualified table names', async () => {
        const columnStore = new Map<string, Array<{ ATTNAME: string; FORMAT_TYPE: string }>>([
            ['CONN_1|@NZEX@DB1.ADMIN.DIMACCOUNT', [{ ATTNAME: 'ACCOUNT_ID', FORMAT_TYPE: 'INT4' }]],
        ])
        const metadataCache = {
            findObjectWithType: jest.fn(() => ({
                schema: 'ADMIN',
                objType: 'TABLE',
            })),
            getColumns: jest.fn((connectionName: string, key: string) =>
                columnStore.get(`${connectionName}|${key}`),
            ),
            getColumnsAnySchema: jest.fn(),
            getObjectsWithSchema: jest.fn(() => []),
            getTablesAllSchemas: jest.fn(),
            getDatabases: jest.fn(),
        } as unknown as MetadataCache

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///dimaccount.sql',
                kind: 'cachedTableInfo',
                database: 'db1',
                table: 'DIMACCOUNT',
            },
            mockExtensionContext,
            {} as MetadataProvider,
            metadataCache,
            createConnectionManager('netezza', { effectiveDatabase: 'db1' }),
        )

        expect(metadataCache.findObjectWithType).toHaveBeenCalledWith(
            'CONN_1',
            'db1',
            undefined,
            'DIMACCOUNT',
        )
        expect(metadataCache.getColumns).toHaveBeenCalledWith(
            'CONN_1',
            '@NZEX@DB1.ADMIN.DIMACCOUNT',
        )
        expect(response).toEqual({
            exists: true,
            table: 'DIMACCOUNT',
            database: 'db1',
            schema: 'ADMIN',
            columns: [{ name: 'ACCOUNT_ID', type: 'INT4' }],
        })
    })

    it('marks an explicit empty Netezza column layer as complete', async () => {
        const metadataCache = {
            getColumns: jest.fn().mockReturnValue([]),
            getColumnsAnySchema: jest.fn(),
            getObjectsWithSchema: jest.fn(() => []),
            getTablesAllSchemas: jest.fn(),
            getDatabases: jest.fn(),
        } as unknown as MetadataCache

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///empty-columns.sql',
                kind: 'cachedTableInfo',
                database: 'db1',
                schema: 'public',
                table: 'no_columns',
            },
            mockExtensionContext,
            {} as MetadataProvider,
            metadataCache,
            createConnectionManager('netezza', { effectiveDatabase: 'db1' }),
        )

        expect(response).toEqual({
            exists: true,
            table: 'no_columns',
            database: 'db1',
            schema: 'public',
            columnsComplete: true,
            columns: [],
        })
    })
})

describe('handleMetadataRequest Access metadata mapping', () => {
    it('keeps columns when a cached table description has an invalid type', async () => {
        const metadataCache = {
            getColumns: jest.fn().mockReturnValue(undefined),
            getColumnsAnySchema: jest.fn().mockReturnValue(undefined),
            ensureColumnsLoadedForTableKey: jest.fn().mockResolvedValue(undefined),
            getObjectsWithSchema: jest.fn().mockReturnValue([
                {
                    item: { label: 'Tabela1' },
                    schema: '',
                    description: { invalid: true },
                },
            ]),
            findObjectWithType: jest.fn().mockReturnValue(undefined),
        } as unknown as MetadataCache
        const metadataProvider = {
            getTableColumnsMetadata: jest.fn().mockResolvedValue([
                {
                    ATTNAME: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    documentation: 42,
                    isPk: false,
                    isFk: false,
                },
            ]),
        } as unknown as MetadataProvider

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///access.sql',
                kind: 'tableInfo',
                database: 'default',
                table: 'Tabela1',
            },
            mockExtensionContext,
            metadataProvider,
            metadataCache,
            createConnectionManager('access', { effectiveDatabase: 'default' }),
        )

        expect(response).toEqual({
            exists: true,
            table: 'Tabela1',
            database: 'default',
            schema: undefined,
            description: undefined,
            columns: [
                {
                    name: 'ID',
                    type: 'INTEGER',
                    description: undefined,
                    isPk: false,
                    isFk: false,
                },
            ],
        })
    })
})

describe('handleMetadataRequest warmDatabaseColumns', () => {
    it('delegates batch database warm to MetadataProvider', async () => {
        const warmDatabaseColumns = jest.fn().mockResolvedValue(undefined)
        const metadataProvider = {
            warmDatabaseColumns
        } as unknown as MetadataProvider

        const response = await handleMetadataRequest(
            {
                documentUri: 'file:///warm.sql',
                kind: 'warmDatabaseColumns',
                databases: ['DB1', 'DB2']
            },
            mockExtensionContext,
            metadataProvider,
            {} as MetadataCache,
            createConnectionManager('postgresql')
        )

        expect(warmDatabaseColumns).toHaveBeenCalledWith('CONN_1', ['DB1', 'DB2'])
        expect(response).toBeNull()
    })
})
