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

/**
 * Shared source-search inputs prepared by SchemaSearchProvider.
 * `rawTerm` preserves the original search token, while `likePattern` is already escaped for LIKE.
 */
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
    /**
     * Builds object-name search SQL. Returned rows should expose uppercase aliases expected by SchemaSearchProvider
     * such as NAME, SCHEMA, TYPE, DATABASE, and PRIORITY when those fields apply.
     */
    buildObjectSearchQuery(database: string, likePattern: string): string;
    /**
     * Builds view-source search SQL. Returned rows should expose uppercase aliases such as NAME, SCHEMA, TYPE,
     * MATCH_TYPE, DATABASE, and SOURCE so the shared search mapper can consume them consistently.
     */
    buildViewSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string;
    /**
     * Builds routine/procedure source search SQL using the same uppercase alias conventions as view-source search.
     */
    buildProcedureSourceSearchQuery(database: string, options: DatabaseSourceSearchQueryOptions): string;
    mirroredSystemCatalog?: DatabaseMirroredSystemCatalog;
}
