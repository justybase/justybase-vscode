import { createDelegatingMetadataProvider } from '../../../src/core/metadataProviderFactory';
import {
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildViewSourceSearchQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildLookupColumnsQuery,
    buildObjectTypeQuery,
    buildTableCommentQuery,
    buildTableColumnsQuery,
    buildTypeGroupsQuery
} from './mssqlSystemQueries';

export const mssqlMetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION'],
    defaultColumnObjectTypes: ['TABLE', 'VIEW'],
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
