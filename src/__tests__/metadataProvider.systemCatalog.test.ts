import * as vscode from 'vscode'
import { runQueryRaw, queryResultToRows } from '../core/queryRunner'
import { MetadataProvider } from '../providers/providers/metadataProvider'
import { parseColumnMetadata } from '../providers/tableMetadataProvider'
import type { ConnectionManager } from '../core/connectionManager'
import type { MetadataCache } from '../metadataCache'
import type { TableMetadata } from '../metadata/types'

function completionItemLabel(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label
}
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}))

jest.mock('../providers/tableMetadataProvider', () => ({
    buildColumnMetadataQuery: jest.fn((database: string, schema: string, tableName: string) =>
        `SELECT ${database}.${schema}.${tableName} COLUMN METADATA`
    ),
    parseColumnMetadata: jest.fn()
}))

type RunQueryRawResult = Awaited<ReturnType<typeof runQueryRaw>>

describe('MetadataProvider system catalog mirroring', () => {
    let metadataCache: jest.Mocked<MetadataCache>
    let provider: MetadataProvider
    let runQueryRawMock: jest.MockedFunction<typeof runQueryRaw>
    let queryResultToRowsMock: jest.MockedFunction<typeof queryResultToRows>
    let parseColumnMetadataMock: jest.MockedFunction<typeof parseColumnMetadata>

    beforeEach(() => {
        jest.clearAllMocks()

        metadataCache = {
            getTables: jest.fn(),
            getTablesAllSchemas: jest.fn(),
            setTables: jest.fn(),
            getColumns: jest.fn(),
            getColumnsAnySchema: jest.fn(),
            ensureColumnsLoaded: jest.fn().mockResolvedValue(undefined),
            setColumns: jest.fn(),
            findTableId: jest.fn(),
            findObjectWithType: jest.fn(),
            triggerFullColumnPrefetch: jest.fn(),
            isDatabaseDead: jest.fn().mockReturnValue(false),
            markDatabaseDead: jest.fn(),
            isViewsCatalogLoaded: jest.fn().mockReturnValue(false),
            markViewsCatalogLoaded: jest.fn(),
            areViewsCatalogLoadedForDatabase: jest.fn().mockReturnValue(false),
        } as unknown as jest.Mocked<MetadataCache>

        provider = new MetadataProvider(
            {} as vscode.ExtensionContext,
            metadataCache,
            {
                ensureFullyLoaded: jest.fn().mockResolvedValue(undefined),
                getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza')
            } as unknown as ConnectionManager
        )

        runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>
        queryResultToRowsMock = queryResultToRows as jest.MockedFunction<typeof queryResultToRows>
        parseColumnMetadataMock = parseColumnMetadata as jest.MockedFunction<typeof parseColumnMetadata>

        runQueryRawMock.mockImplementation(async (...args: Parameters<typeof runQueryRaw>) => {
            return { query: args[1] } as unknown as RunQueryRawResult
        })

        queryResultToRowsMock.mockImplementation((result: unknown) => {
            const query = (result as { query?: string }).query || ''

            if (query.includes('FROM TARGET_DB.._V_OBJECT_DATA')) {
                return [
                    { OBJNAME: 'ORDERS', OBJID: 11, OBJTYPE: 'TABLE', SCHEMA: 'PUBLIC', DESCRIPTION: 'Orders table' },
                    {
                        OBJNAME: 'ORDERS_SYNONYM',
                        OBJID: 12,
                        OBJTYPE: 'SYNONYM',
                        SCHEMA: 'PUBLIC',
                        DESCRIPTION: 'Orders synonym',
                        REFOBJNAME: 'PUBLIC.ORDERS'
                    }
                ]
            }

            if (query.includes('FROM SYSTEM.._V_OBJECT_DATA')) {
                return [
                    { OBJNAME: '_V_SESSION', OBJID: 101, OBJTYPE: 'VIEW', DESCRIPTION: 'Active sessions' },
                    { OBJNAME: '_V_TABLE', OBJID: 102, OBJTYPE: 'VIEW', DESCRIPTION: 'Catalog tables' }
                ]
            }

            if (query.includes('FROM SYSTEM.._V_RELATION_COLUMN')) {
                return [
                    { ATTNAME: 'SESSIONID', FORMAT_TYPE: 'INTEGER' },
                    { ATTNAME: 'USERNAME', FORMAT_TYPE: 'VARCHAR(128)' }
                ]
            }

            if (query.includes('.._V_SYNONYM')) {
                return [{ REFOBJNAME: 'PUBLIC.ORDERS' }]
            }

            return []
        })
        parseColumnMetadataMock.mockReset()
    })

    it('adds mirrored system catalog objects to database-level table completion', async () => {
        const items = await provider.getTables('CONN_1', 'TARGET_DB')
        const labels = items.map(item => completionItemLabel(item))

        expect(labels).toEqual(expect.arrayContaining(['ORDERS', 'ORDERS_SYNONYM', '_V_SESSION', '_V_TABLE']))

        const executedQueries = runQueryRawMock.mock.calls.map(call => call[1])
        expect(executedQueries.some(query => query.includes('TARGET_DB.._V_OBJECT_DATA'))).toBe(true)
        expect(executedQueries.some(query => query.includes('SYSTEM.._V_OBJECT_DATA'))).toBe(true)
        expect(metadataCache.setTables).toHaveBeenCalled()
    })

    it('loads mirrored system catalog columns from SYSTEM for arbitrary database prefixes', async () => {
        const columns = await provider.getTableColumnsMetadata('CONN_1', 'TARGET_DB', undefined, '_V_SESSION')

        expect(columns.map(column => column.ATTNAME)).toEqual(['SESSIONID', 'USERNAME'])

        const executedQueries = runQueryRawMock.mock.calls.map(call => call[1])
        expect(executedQueries.some(query => query.includes('FROM SYSTEM.._V_RELATION_COLUMN'))).toBe(true)
        expect(metadataCache.setColumns).toHaveBeenCalledWith(
            'CONN_1',
            'TARGET_DB.._V_SESSION',
            expect.any(Array)
        )
    })

    it('merges fetched views back into the shared table-like cache for schema completions', async () => {
        metadataCache.getTables.mockReturnValue([
            {
                OBJNAME: 'EMPLOYEES',
                OBJID: 11,
                SCHEMA: 'DB2INST1',
                label: 'EMPLOYEES',
                kind: vscode.CompletionItemKind.Class,
                objType: 'TABLE',
                detail: 'Table'
            }
        ])

        ;(provider as unknown as {
            getMetadataProvider: () => { buildListViewsQuery: () => string }
        }).getMetadataProvider = jest.fn(() => ({
            buildListViewsQuery: () => 'SELECT DB2 VIEWS'
        }))

        runQueryRawMock.mockResolvedValue({ query: 'SELECT DB2 VIEWS' } as unknown as RunQueryRawResult)
        queryResultToRowsMock.mockReturnValue([
            {
                OBJNAME: 'EMP_VIEW',
                OBJID: 21,
                SCHEMA: 'DB2INST1',
                DESCRIPTION: 'Employee view'
            }
        ])

        const items = await provider.getViews('CONN_1', 'TESTDB', 'DB2INST1')

        expect(items.map(item => completionItemLabel(item))).toEqual(expect.arrayContaining(['EMP_VIEW']))
        expect(metadataCache.setTables).toHaveBeenCalledWith(
            'CONN_1',
            'TESTDB.DB2INST1',
            expect.arrayContaining([
                expect.objectContaining({ label: 'EMPLOYEES', objType: 'TABLE' }),
                expect.objectContaining({ label: 'EMP_VIEW', objType: 'VIEW' })
            ]),
            expect.any(Map),
            undefined,
        )
    })

    it('resolves synonym columns from cached REFOBJNAME without a synonym lookup query', async () => {
        metadataCache.getTables.mockReturnValue([
            {
                OBJNAME: 'ORDERS',
                label: 'ORDERS',
                objType: 'TABLE',
                SCHEMA: 'PUBLIC'
            },
            {
                OBJNAME: 'ORDERS_SYNONYM',
                label: 'ORDERS_SYNONYM',
                objType: 'SYNONYM',
                SCHEMA: 'PUBLIC',
                REFOBJNAME: 'PUBLIC.ORDERS'
            }
        ])
        metadataCache.findObjectWithType.mockImplementation((_conn, _db, _schema, objectName) => {
            if (objectName.toUpperCase() === 'ORDERS_SYNONYM') {
                return { objType: 'SYNONYM', schema: 'PUBLIC', name: 'ORDERS_SYNONYM', objId: 12 }
            }
            if (objectName.toUpperCase() === 'ORDERS') {
                return { objType: 'TABLE', schema: 'PUBLIC', name: 'ORDERS', objId: 11 }
            }
            return undefined
        })

        parseColumnMetadataMock.mockReturnValue([
            {
                attname: 'ORDER_ID',
                formatType: 'INTEGER',
                isNotNull: true,
                colDefault: null,
                isPk: true,
                isFk: false,
                description: 'Order key'
            }
        ])

        const columns = await provider.getTableColumnsMetadata('CONN_1', 'TARGET_DB', 'PUBLIC', 'ORDERS_SYNONYM')

        expect(columns).toEqual([
            expect.objectContaining({
                ATTNAME: 'ORDER_ID',
                FORMAT_TYPE: 'INTEGER',
                isPk: true,
                isFk: false,
                documentation: 'Order key'
            })
        ])

        const executedQueries = runQueryRawMock.mock.calls.map(call => call[1])
        expect(executedQueries.some(query => query.includes('.._V_SYNONYM'))).toBe(false)
        expect(executedQueries.some(query => query.includes('SELECT TARGET_DB.PUBLIC.ORDERS COLUMN METADATA'))).toBe(true)
        expect(metadataCache.setColumns).toHaveBeenCalledWith(
            'CONN_1',
            'TARGET_DB.PUBLIC.ORDERS_SYNONYM',
            expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ORDER_ID' })])
        )
    })

    it('falls back to _V_SYNONYM when REFOBJNAME is not cached', async () => {
        metadataCache.findObjectWithType.mockReturnValue({
            objType: 'SYNONYM',
            schema: 'PUBLIC',
            name: 'ORDERS_SYNONYM',
            objId: 12
        })

        parseColumnMetadataMock.mockReturnValue([
            {
                attname: 'ORDER_ID',
                formatType: 'INTEGER',
                isNotNull: true,
                colDefault: null,
                isPk: true,
                isFk: false,
                description: 'Order key'
            }
        ])

        const columns = await provider.getTableColumnsMetadata('CONN_1', 'TARGET_DB', 'PUBLIC', 'ORDERS_SYNONYM')

        expect(columns).toHaveLength(1)
        const executedQueries = runQueryRawMock.mock.calls.map(call => call[1])
        expect(executedQueries.some(query => query.includes('.._V_SYNONYM'))).toBe(true)
        expect(executedQueries.some(query => query.includes('SELECT TARGET_DB.PUBLIC.ORDERS COLUMN METADATA'))).toBe(true)
    })

    it('skips views fetch for DB.. when cache has tables but no views and catalog is complete', async () => {
        metadataCache.getTables.mockReturnValue(undefined)
        metadataCache.getTablesAllSchemas.mockReturnValue([
            {
                OBJNAME: 'DIMACCOUNT',
                label: 'DIMACCOUNT',
                objType: 'TABLE',
                SCHEMA: 'ADMIN',
                kind: vscode.CompletionItemKind.Class,
            },
        ])
        metadataCache.isViewsCatalogLoaded.mockReturnValue(false)
        metadataCache.areViewsCatalogLoadedForDatabase.mockReturnValue(true)

        const buildListViewsQuery = jest.fn(() => 'SELECT USER VIEWS')
        ;(provider as unknown as {
            getMetadataProvider: () => { buildListViewsQuery: () => string }
            mergeMirroredSystemCatalogObjects: (
                connectionName: string,
                dbName: string,
                tables: TableMetadata[],
            ) => Promise<TableMetadata[]>
        }).getMetadataProvider = jest.fn(() => ({
            buildListViewsQuery,
        }))
        jest.spyOn(
            provider as unknown as {
                mergeMirroredSystemCatalogObjects: (
                    connectionName: string,
                    dbName: string,
                    tables: TableMetadata[],
                ) => Promise<TableMetadata[]>
            },
            'mergeMirroredSystemCatalogObjects',
        ).mockImplementation(async (_connectionName, _dbName, tables) => tables)

        const items = await provider.getViews('CONN_1', 'JUST_DATA_3')

        expect(items).toEqual([])
        expect(buildListViewsQuery).not.toHaveBeenCalled()
    })
})
