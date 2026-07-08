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
} from './postgresqlSystemQueries';

export const postgresqlMetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: ['TABLE', 'VIEW', 'SEQUENCE', 'FUNCTION', 'PROCEDURE'],
    defaultColumnObjectTypes: ['TABLE', 'VIEW'],
    listDatabases: buildListDatabasesQuery,
    listSchemas: () => buildListSchemasQuery(),
    listTables: (_database, schema) => buildListTablesQuery(schema),
    listViews: (_database, schema) => buildListViewsQuery(schema),
    listProcedures: (_database, schema) => buildListProceduresQuery(schema),
    objectType: (_database, objectType) => buildObjectTypeQuery(objectType),
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
