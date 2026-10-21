export interface DatabaseColumnQueryOptions {
    schema?: string;
    tableName?: string;
    objTypes?: string[];
}

/** Catalog FK endpoint pair returned by metadata providers. */
export interface DatabaseForeignKeyColumnReference {
    fromDatabase?: string;
    fromSchema: string;
    fromTable: string;
    fromColumn: string;
    toDatabase?: string;
    toSchema: string;
    toTable: string;
    toColumn: string;
    constraintName?: string;
    ordinalPosition?: number;
}

/**
 * Optional split plan for dialects whose column/key metadata is cheaper to
 * fetch as independent catalog scans and combine in the client.
 */
export interface DatabaseColumnsWithKeysQuerySet {
    columns: string;
    keys: string;
    distribution: string;
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

/** Table sub-folders shown under a table in the schema tree. */
export type DatabaseTableDetailKind = 'keys' | 'indexes' | 'triggers';

/** Read-only reports opened from a table node; the result is shown in SQL Results. */
export type DatabaseTableReportKind = 'size' | 'privileges' | 'maintenance';

/** Read-only reports opened from a database node; the result is shown in SQL Results. */
export type DatabaseReportKind = 'locks' | 'invalidObjects';

export interface DatabaseMetadataProvider {
    readonly defaultObjectTypes: readonly string[];
    readonly defaultColumnObjectTypes: readonly string[];
    buildListDatabasesQuery(): string;
    buildListSchemasQuery(database: string): string;
    buildListTablesQuery(database: string, schema?: string): string;
    buildListViewsQuery(database: string, schema?: string): string;
    /**
     * Builds the relation-like objects that are legal after FROM/JOIN.
     * Dialects without a distinct source catalog can leave this undefined and
     * use the regular table/view queries instead.
     */
    buildListSourceObjectsQuery?(database: string, schema?: string): string;
    buildSynonymTargetQuery?(database: string, synonymName: string, schema?: string): string;
    buildListProceduresQuery(database: string, schema?: string): string;
    buildObjectTypeQuery(database: string, objectType: string): string;
    buildTypeGroupsQuery(database: string): string;
    buildColumnsWithKeysQuery(database: string, options?: DatabaseColumnQueryOptions): string;
    buildColumnsWithKeysQueries?(
        database: string,
        options?: DatabaseColumnQueryOptions,
    ): DatabaseColumnsWithKeysQuerySet;
    /**
     * Optional exact FK endpoint query. It runs during metadata refresh and its
     * rows are persisted with the source column cache; completion never calls it.
     * The query must expose FROM_SCHEMA/FROM_TABLE/FROM_COLUMN and
     * TO_SCHEMA/TO_TABLE/TO_COLUMN aliases (database and ordering aliases are
     * optional).
     */
    buildForeignKeyRelationshipsQuery?(
        database: string,
        options?: DatabaseColumnQueryOptions,
    ): string | undefined;
    /**
     * Builds a companion query for external/foreign-object columns across a
     * database (Netezza). It is executed separately and merged in code.
     */
    buildExternalColumnsWithKeysQuery?(database: string, options?: DatabaseColumnQueryOptions): string;
    buildTableColumnsQuery(database: string, schema: string, tableName: string): string;
    /**
     * Builds a companion query for external/foreign-object columns (Netezza).
     * It is executed separately (never UNIONed) and merged with
     * `buildTableColumnsQuery` results in code. Dialects without this concept
     * can leave it undefined.
     */
    buildExternalTableColumnsQuery?(database: string, schema: string, tableName: string): string;
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
    /**
     * Lists one table's keys/constraints, indexes or triggers for the schema
     * tree. Rows expose NAME, KIND and DETAIL (a short human-readable summary).
     */
    buildTableDetailQuery?(database: string, schema: string, tableName: string, detail: DatabaseTableDetailKind): string | undefined;
    /**
     * Catalog-recorded object dependencies for impact analysis. Rows expose
     * SOURCE_SCHEMA/SOURCE_NAME/SOURCE_TYPE (the dependent object),
     * TARGET_SCHEMA/TARGET_NAME/TARGET_TYPE (what it uses) and an optional
     * TARGET_COLUMN. Types are normalized to TABLE, VIEW, PROCEDURE or SEQUENCE.
     */
    buildObjectDependenciesQuery?(database: string): string | undefined;
    /**
     * Read-only report about one table, run as-is in SQL Results. Column
     * names are free-form but should read well as grid headers.
     */
    buildTableReportQuery?(database: string, schema: string, tableName: string, report: DatabaseTableReportKind): string | undefined;
    /** Read-only database-wide report (lock waits, invalid objects), run as-is in SQL Results. */
    buildDatabaseReportQuery?(database: string, report: DatabaseReportKind): string | undefined;
}
