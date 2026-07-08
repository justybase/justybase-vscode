import { createDelegatingMetadataProvider } from '../../../src/core/metadataProviderFactory';
import {
    buildObjectSearchQuery,
    buildProcedureSourceSearchQuery,
    buildColumnMetadataQuery,
    buildColumnsWithKeysQuery,
    buildListDatabasesQuery,
    buildListProceduresQuery,
    buildListSchemasQuery,
    buildListTablesQuery,
    buildListViewsQuery,
    buildObjectTypeQuery,
    buildViewSourceSearchQuery,
    buildTableCommentQuery,
    buildTableColumnsQuery,
    buildTypeGroupsQuery
} from './db2SystemQueries';

const DB2_DEFAULT_OBJECT_TYPES = [
    'TABLE',
    'VIEW',
    'NICKNAME',
    'ALIAS',
    'PROCEDURE',
    'FUNCTION',
    'SERVER',
    'SERVER OPTION',
    'WRAPPER',
    'WRAPPER OPTION',
    'USER MAPPING',
    'PASSTHRU AUTH'
] as const;

const DB2_DEFAULT_COLUMN_OBJECT_TYPES = ['TABLE', 'VIEW', 'NICKNAME', 'ALIAS'] as const;

export const db2MetadataProvider = createDelegatingMetadataProvider({
    defaultObjectTypes: DB2_DEFAULT_OBJECT_TYPES,
    defaultColumnObjectTypes: DB2_DEFAULT_COLUMN_OBJECT_TYPES,
    listDatabases: buildListDatabasesQuery,
    listSchemas: () => buildListSchemasQuery(),
    listTables: (_database, schema) => buildListTablesQuery(schema),
    listViews: (_database, schema) => buildListViewsQuery(schema),
    listProcedures: (_database, schema) => buildListProceduresQuery(schema),
    objectType: (database, objectType) => buildObjectTypeQuery(objectType, database),
    typeGroups: buildTypeGroupsQuery,
    columnsWithKeys: (database, options) => buildColumnsWithKeysQuery(database, options?.schema, options?.tableName, options?.objTypes),
    tableColumns: (_database, schema, tableName) => buildTableColumnsQuery(schema, tableName),
    columnMetadata: (_database, schema, tableName) => buildColumnMetadataQuery(schema, tableName),
    lookupColumns: params => buildColumnsWithKeysQuery(params.database, params.schema, params.tableName, DB2_DEFAULT_COLUMN_OBJECT_TYPES),
    tableComment: (_database, schema, tableName) => buildTableCommentQuery(schema, tableName),
    objectSearch: buildObjectSearchQuery,
    viewSourceSearch: buildViewSourceSearchQuery,
    procedureSourceSearch: buildProcedureSourceSearchQuery
});
