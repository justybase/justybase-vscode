import type {
    DatabaseColumnLookupParams,
    DatabaseColumnQueryOptions,
    DatabaseMetadataProvider,
    DatabaseSourceSearchQueryOptions,
} from '@justybase/contracts';

/**
 * Metadata provider for Microsoft Access databases.
 *
 * Access has a single flat catalog: tables and saved queries. The metadata
 * engine executes these "marker" queries through the connection, which routes
 * them to the UCanAccess bridge (JDBC DatabaseMetaData) instead of running
 * them as SQL. The bridge returns rows in the same DATABASE/SCHEMA/TABLENAME
 * shape used by the SQLite provider so the shared metadata cache needs no
 * Access-specific logic.
 */

function quoteLiteral(value: string | undefined): string {
    return `'${(value ?? '').replace(/'/g, "''")}'`;
}

function normalizeObjectType(objectType: string): 'table' | 'view' {
    return objectType.trim().toLowerCase() === 'view' ? 'view' : 'table';
}

function metadataQuery(kind: string): string {
    return `SELECT * FROM _access_metadata.${kind}`;
}

function buildColumnsMarker(tableName: string | undefined, objectTypes?: readonly string[]): string {
    const types = (objectTypes ?? ['TABLE', 'VIEW'])
        .map(type => type.trim().toUpperCase())
        .filter(type => type === 'TABLE' || type === 'VIEW');
    const objTypeClause = types.length > 0 ? ` AND OBJTYPES = ${quoteLiteral(types.join(','))}` : '';
    return `SELECT * FROM _access_metadata.columns WHERE TABLE = ${quoteLiteral(tableName)}${objTypeClause}`;
}

export const accessMetadataProvider: DatabaseMetadataProvider = {
    defaultObjectTypes: ['TABLE', 'VIEW'],
    defaultColumnObjectTypes: ['TABLE', 'VIEW'],
    buildListDatabasesQuery(): string {
        return metadataQuery('databases');
    },
    buildListSchemasQuery(): string {
        return metadataQuery('schemas');
    },
    buildListTablesQuery(): string {
        return metadataQuery('tables');
    },
    buildListViewsQuery(): string {
        return metadataQuery('views');
    },
    buildListProceduresQuery(): string {
        return metadataQuery('procedures');
    },
    buildObjectTypeQuery(_database: string, objectType: string): string {
        return `${metadataQuery('object_type')} WHERE TYPE = ${quoteLiteral(normalizeObjectType(objectType).toUpperCase())}`;
    },
    buildTypeGroupsQuery(): string {
        return metadataQuery('type_groups');
    },
    buildColumnsWithKeysQuery(_database: string, options?: DatabaseColumnQueryOptions): string {
        return buildColumnsMarker(options?.tableName, options?.objTypes);
    },
    buildTableColumnsQuery(_database: string, _schema: string, tableName: string): string {
        return `SELECT * FROM _access_metadata.table_columns WHERE TABLE = ${quoteLiteral(tableName)}`;
    },
    buildColumnMetadataQuery(_database: string, _schema: string, tableName: string): string {
        return `SELECT * FROM _access_metadata.column_metadata WHERE TABLE = ${quoteLiteral(tableName)}`;
    },
    buildLookupColumnsQuery(params: DatabaseColumnLookupParams): string {
        return buildColumnsMarker(params.tableName, ['TABLE', 'VIEW']);
    },
    buildTableCommentQuery(_database: string, _schema: string, tableName: string): string {
        return `SELECT * FROM _access_metadata.table_comment WHERE TABLE = ${quoteLiteral(tableName)}`;
    },
    buildObjectSearchQuery(_database: string, likePattern: string): string {
        return `SELECT * FROM _access_metadata.object_search WHERE PATTERN = ${quoteLiteral(likePattern)}`;
    },
    buildViewSourceSearchQuery(_database: string, options: DatabaseSourceSearchQueryOptions): string {
        const serverSide = options.useServerSideFilter ? '1' : '0';
        return `SELECT * FROM _access_metadata.view_source_search WHERE PATTERN = ${quoteLiteral(options.likePattern)} AND SERVER_SIDE = ${serverSide}`;
    },
    buildProcedureSourceSearchQuery(): string {
        return metadataQuery('procedure_source_search');
    },
};
