export interface DatabaseColumnQueryOptions {
  schema?: string;
  tableName?: string;
  objTypes?: string[];
}

export interface DatabaseColumnLookupParams {
  database?: string;
  schema?: string;
  tableName: string;
  objectId?: number;
}

export interface DatabaseMirroredSystemCatalog {
  sourceDatabase: string;
  isMirroredObjectName(name: string | undefined): boolean;
  buildMirroredObjectsQuery(): string;
}

export interface DatabaseSourceSearchQueryOptions {
  rawTerm: string;
  likePattern: string;
  useServerSideFilter: boolean;
}

export interface DatabaseMetadataProvider {
  readonly defaultObjectTypes: readonly string[];
  readonly defaultColumnObjectTypes: readonly string[];
  buildListDatabasesQuery(): string;
  buildListSchemasQuery(database: string): string;
  buildListTablesQuery(database: string, schema?: string): string;
  buildListViewsQuery(database: string, schema?: string): string;
  buildListProceduresQuery(database: string, schema?: string): string;
  buildObjectTypeQuery(database: string, objectType: string): string;
  buildTypeGroupsQuery(database: string): string;
  buildColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string;
  buildTableColumnsQuery(database: string, schema: string, tableName: string): string;
  buildColumnMetadataQuery(database: string, schema: string, tableName: string): string;
  buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string;
  buildTableCommentQuery(database: string, schema: string, tableName: string): string;
  buildObjectSearchQuery(database: string, likePattern: string): string;
  buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string;
  buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string;
  mirroredSystemCatalog?: DatabaseMirroredSystemCatalog;
}
