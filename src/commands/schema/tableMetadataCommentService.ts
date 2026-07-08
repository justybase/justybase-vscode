import type { ColumnMetadata } from '../../metadata/types';
import { getCachedColumnsFromMetadataCacheAsync } from '../../metadata/columnCacheLookup';
import { buildColumnCacheKey } from '../../metadata/columnRowMapping';
import { normalizeColumnCacheEntry } from '../../metadata/cache/schemaTreeDataSource';
import { runQueryRaw } from '../../core/queryRunner';
import {
    buildColumnMetadataQuery,
    parseColumnMetadata,
} from '../../providers/tableMetadataProvider';
import type { SchemaCommandsDependencies } from './types';
import type { SchemaItemData } from './types';
import { executeWithProgress, getFullName, getItemObjectName } from './helpers';
import {
    buildTableMetadataCommentBlock,
    type TableMetadataCommentColumn,
} from './tableMetadataCommentBuilder';

function toCommentColumn(column: ColumnMetadata): TableMetadataCommentColumn {
    const name = column.label || column.ATTNAME;
    const dataType = column.detail || column.FORMAT_TYPE || '';
    const description =
        (typeof column.documentation === 'string' && column.documentation.trim())
            ? column.documentation
            : typeof column.DESCRIPTION === 'string'
              ? column.DESCRIPTION
              : undefined;

    return {
        name,
        dataType,
        description,
        isPk: column.isPk,
        isFk: column.isFk,
        isDistributionKey: column.isDistributionKey,
    };
}

function resolveTableDescription(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    tableName: string,
): string | undefined {
    const inlineDescription = item.objectDescription?.trim();
    if (inlineDescription) {
        return inlineDescription;
    }

    const connectionName = item.connectionName;
    const dbName = item.dbName;
    if (!connectionName || !dbName) {
        return undefined;
    }

    const objects = deps.metadataCache.getObjectsWithSchema(connectionName, dbName);
    if (!objects) {
        return undefined;
    }

    const normalizedTable = tableName.toUpperCase();
    const normalizedSchema = (item.schema || '').toUpperCase();
    for (const objectInfo of objects) {
        const name =
            typeof objectInfo.item.label === 'string'
                ? objectInfo.item.label
                : typeof objectInfo.item.label === 'object'
                  ? objectInfo.item.label.label
                  : objectInfo.item.OBJNAME || objectInfo.item.TABLENAME;
        if (!name || name.toUpperCase() !== normalizedTable) {
            continue;
        }
        if (normalizedSchema && objectInfo.schema.toUpperCase() !== normalizedSchema) {
            continue;
        }
        const description = objectInfo.description?.trim();
        if (description) {
            return description;
        }
    }

    return undefined;
}

async function loadTableColumns(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    tableName: string,
): Promise<ColumnMetadata[]> {
    const connectionName = item.connectionName;
    const dbName = item.dbName;
    const schemaName = item.schema;
    if (!connectionName || !dbName) {
        return [];
    }

    const databaseKind = deps.connectionManager.getConnectionDatabaseKind(connectionName);
    const cached = await getCachedColumnsFromMetadataCacheAsync(
        deps.metadataCache,
        connectionName,
        dbName,
        schemaName,
        tableName,
        databaseKind,
    );
    if (cached && cached.length > 0) {
        return cached;
    }

    const resolvedSchema =
        schemaName
        || deps.metadataCache.findObjectWithType(
            connectionName,
            dbName,
            undefined,
            tableName,
        )?.schema;
    if (!resolvedSchema) {
        return cached ?? [];
    }

    const query = buildColumnMetadataQuery(
        dbName,
        resolvedSchema,
        tableName,
        databaseKind,
    );
    const result = await executeWithProgress(
        `Loading columns for ${tableName}...`,
        async () => runQueryRaw(
            deps.context,
            query,
            true,
            deps.connectionManager,
            connectionName,
        ),
    );
    const parsedColumns = parseColumnMetadata(result);
    const cacheItems = parsedColumns.map((column) =>
        normalizeColumnCacheEntry({
            ATTNAME: column.attname,
            FORMAT_TYPE: column.formatType,
            label: column.attname,
            kind: 5,
            detail: column.formatType,
            documentation: column.description,
            isPk: column.isPk,
            isFk: column.isFk,
            isDistributionKey: column.isDistributionKey,
        }),
    );
    deps.metadataCache.setColumns(
        connectionName,
        buildColumnCacheKey(dbName, schemaName, tableName),
        cacheItems,
    );
    return cacheItems;
}

export async function buildSchemaItemMetadataComment(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
): Promise<string | undefined> {
    const tableName = getItemObjectName(item);
    if (!tableName || !item.dbName) {
        return undefined;
    }

    const columns = await loadTableColumns(deps, item, tableName);
    return buildTableMetadataCommentBlock({
        tableName,
        qualifiedName: getFullName(item, deps.connectionManager),
        tableDescription: resolveTableDescription(deps, item, tableName),
        objectType: item.objType,
        columns: columns.map(toCommentColumn),
    });
}
