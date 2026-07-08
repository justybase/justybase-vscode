import { handleMetadataRequest } from '../activation/lspRegistration'
import type { ConnectionManager } from '../core/connectionManager'
import type { MetadataCache } from '../metadataCache'
import type { TableMetadata } from '../metadata/types'
import type { MetadataProvider } from '../providers/providers/metadataProvider'

jest.mock('../utils/logger', () => ({
    getLogger: () => ({
        error: jest.fn()
    })
}))

jest.mock('../dialects/netezza/metadata/netezzaSchemaContext', () => ({
    resolveNetezzaSchemasEnabled: jest.fn(async () => false),
    resolveNetezzaDefaultSchema: jest.fn(async () => 'ADMIN'),
}))

const mockExtensionContext = { subscriptions: [] } as unknown as import('vscode').ExtensionContext

function createConnectionManager(
    databaseKind: 'db2' | 'oracle' | 'postgresql' | 'netezza',
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
                databaseKind
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

describe('handleMetadataRequest cachedTableInfo', () => {
    it('resolves uppercase cache keys when SQL identifiers are lowercase', async () => {
        const columnStore = new Map<string, Array<{ ATTNAME: string; FORMAT_TYPE: string }>>([
            ['CONN_1|DB1.PUBLIC.ORDERS', [{ ATTNAME: 'ID', FORMAT_TYPE: 'INT4' }]],
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

        expect(metadataCache.getColumns).toHaveBeenCalledWith('CONN_1', 'DB1.PUBLIC.ORDERS')
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
            ['CONN_1|DB1.ADMIN.DIMACCOUNT', [{ ATTNAME: 'ACCOUNT_ID', FORMAT_TYPE: 'INT4' }]],
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
            'DB1.ADMIN.DIMACCOUNT',
        )
        expect(response).toEqual({
            exists: true,
            table: 'DIMACCOUNT',
            database: 'db1',
            schema: 'ADMIN',
            columns: [{ name: 'ACCOUNT_ID', type: 'INT4' }],
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
