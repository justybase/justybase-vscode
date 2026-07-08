import { createDelegatingMetadataProvider } from '../../../src/core/metadataProviderFactory';
import {
    ORACLE_DEFAULT_COLUMN_OBJECT_TYPES,
    ORACLE_DEFAULT_OBJECT_TYPES,
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectTypeQuery,
    buildTableColumnsQuery,
    buildTableCommentQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery
} from './oracleSystemQueries';

export const oracleMetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: ORACLE_DEFAULT_OBJECT_TYPES,
    defaultColumnObjectTypes: ORACLE_DEFAULT_COLUMN_OBJECT_TYPES,
    listDatabases: buildListDatabasesQuery,
    listSchemas: () => buildListSchemasQuery(),
    listTables: (_database, schema) => buildListTablesQuery(schema),
    listViews: (_database, schema) => buildListViewsQuery(schema),
    listProcedures: buildListProceduresQuery,
    objectType: (database, objectType) => buildObjectTypeQuery(objectType, database),
    typeGroups: () => buildTypeGroupsQuery(),
    columnsWithKeys: (database, options) => buildColumnsWithKeysQuery(database, options?.schema, options?.tableName, options?.objTypes),
    tableColumns: (_database, schema, tableName) => buildTableColumnsQuery(schema, tableName),
    columnMetadata: (_database, schema, tableName) => buildColumnMetadataQuery(schema, tableName),
    lookupColumns: params => buildLookupColumnsQuery({
        schema: params.schema,
        tableName: params.tableName,
        objectId: params.objectId
    }),
    tableComment: (_database, schema, tableName) => buildTableCommentQuery(schema, tableName),
    objectSearch: buildObjectSearchQuery,
    viewSourceSearch: buildViewSourceSearchQuery,
    procedureSourceSearch: buildProcedureSourceSearchQuery
});
