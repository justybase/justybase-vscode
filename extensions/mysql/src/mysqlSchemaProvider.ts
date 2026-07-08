import { createDelegatingMetadataProvider } from '../../../src/core/metadataProviderFactory';
import {
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
    buildTableCommentQuery,
    buildTableColumnsQuery,
    buildTypeGroupsQuery,
    buildViewSourceSearchQuery
} from './mysqlSystemQueries';

export const mysqlMetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: ['TABLE', 'VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'],
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
