import { createDelegatingMetadataProvider } from '../../../src/core/metadataProviderFactory';
import {
    SNOWFLAKE_DEFAULT_COLUMN_OBJECT_TYPES,
    SNOWFLAKE_DEFAULT_OBJECT_TYPES,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectSearchQuery,
    buildObjectTypeQuery,
    buildProcedureSourceSearchQuery,
    buildTableColumnsQuery,
    buildTableCommentQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery
} from './snowflakeSystemQueries';

export const snowflakeMetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: SNOWFLAKE_DEFAULT_OBJECT_TYPES,
    defaultColumnObjectTypes: SNOWFLAKE_DEFAULT_COLUMN_OBJECT_TYPES,
    listDatabases: buildListDatabasesQuery,
    listSchemas: buildListSchemasQuery,
    listTables: buildListTablesQuery,
    listViews: buildListViewsQuery,
    listProcedures: buildListProceduresQuery,
    objectType: buildObjectTypeQuery,
    typeGroups: () => buildTypeGroupsQuery(),
    columnsWithKeys: (database, options) => buildColumnsWithKeysQuery(database, options?.schema, options?.tableName, options?.objTypes),
    tableColumns: buildTableColumnsQuery,
    columnMetadata: buildColumnMetadataQuery,
    lookupColumns: buildLookupColumnsQuery,
    tableComment: buildTableCommentQuery,
    objectSearch: buildObjectSearchQuery,
    viewSourceSearch: buildViewSourceSearchQuery,
    procedureSourceSearch: buildProcedureSourceSearchQuery
});
