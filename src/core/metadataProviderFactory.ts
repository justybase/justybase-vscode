import type {
    DatabaseColumnLookupParams,
    DatabaseColumnQueryOptions,
    DatabaseMetadataProvider,
    DatabaseMirroredSystemCatalog,
    DatabaseSourceSearchQueryOptions
} from '../contracts/database';

export interface DelegatingMetadataProviderConfig {
    defaultObjectTypes: readonly string[];
    defaultColumnObjectTypes: readonly string[];
    listDatabases: () => string;
    listSchemas: (database?: string) => string;
    listTables: (database: string, schema?: string) => string;
    listViews: (database: string, schema?: string) => string;
    listProcedures: (database: string, schema?: string) => string;
    objectType: (database: string, objectType: string) => string;
    typeGroups: (database: string) => string;
    columnsWithKeys: (database: string, options?: DatabaseColumnQueryOptions) => string;
    tableColumns: (database: string, schema: string, tableName: string) => string;
    columnMetadata: (database: string, schema: string, tableName: string) => string;
    lookupColumns: (params: DatabaseColumnLookupParams) => string;
    tableComment: (database: string, schema: string, tableName: string) => string;
    objectSearch: (database: string, likePattern: string) => string;
    viewSourceSearch: (database: string, options: DatabaseSourceSearchQueryOptions) => string;
    procedureSourceSearch: (database: string, options: DatabaseSourceSearchQueryOptions) => string;
    mirroredSystemCatalog?: DatabaseMirroredSystemCatalog;
}

export function createDelegatingMetadataProvider(
    config: DelegatingMetadataProviderConfig
): DatabaseMetadataProvider {
    return {
        defaultObjectTypes: config.defaultObjectTypes,
        defaultColumnObjectTypes: config.defaultColumnObjectTypes,
        buildListDatabasesQuery(): string {
            return config.listDatabases();
        },
        buildListSchemasQuery(database: string): string {
            return config.listSchemas(database);
        },
        buildListTablesQuery(database: string, schema?: string): string {
            return config.listTables(database, schema);
        },
        buildListViewsQuery(database: string, schema?: string): string {
            return config.listViews(database, schema);
        },
        buildListProceduresQuery(database: string, schema?: string): string {
            return config.listProcedures(database, schema);
        },
        buildObjectTypeQuery(database: string, objectType: string): string {
            return config.objectType(database, objectType);
        },
        buildTypeGroupsQuery(database: string): string {
            return config.typeGroups(database);
        },
        buildColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string {
            return config.columnsWithKeys(database, options);
        },
        buildTableColumnsQuery(database: string, schema: string, tableName: string): string {
            return config.tableColumns(database, schema, tableName);
        },
        buildColumnMetadataQuery(database: string, schema: string, tableName: string): string {
            return config.columnMetadata(database, schema, tableName);
        },
        buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
            return config.lookupColumns(params);
        },
        buildTableCommentQuery(database: string, schema: string, tableName: string): string {
            return config.tableComment(database, schema, tableName);
        },
        buildObjectSearchQuery(database: string, likePattern: string): string {
            return config.objectSearch(database, likePattern);
        },
        buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
            return config.viewSourceSearch(database, options);
        },
        buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string {
            return config.procedureSourceSearch(database, options);
        },
        mirroredSystemCatalog: config.mirroredSystemCatalog
    };
}
