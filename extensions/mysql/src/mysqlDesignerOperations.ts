import type {
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget,
} from '@justybase/contracts';
import type {
    MysqlDesignerColumn,
    MysqlDesignerExistingIndex,
    MysqlIndexDesignerInitialContext,
} from '../../../src/contracts/webviews/mysqlIndexDesignerContracts';
import type {
    MysqlDesignerPartition,
    MysqlPartitionCapabilities,
    MysqlPartitionDesignerInitialContext,
    MysqlPartitionMethod,
} from '../../../src/contracts/webviews/mysqlPartitionDesignerContracts';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import {
    buildColumnMetadataQuery,
    buildListIndexesQuery,
    buildListPartitionsQuery,
    buildTablePropertiesQuery,
} from './mysqlSystemQueries';

interface MysqlRow extends Record<string, unknown> {
    [key: string]: unknown;
}

interface MysqlTablePropertiesRow extends MysqlRow {
    ENGINE?: unknown;
    SERVER_VERSION?: unknown;
}

interface MysqlIndexRow extends MysqlRow {
    INDEX_NAME?: unknown;
    COLUMN_NAME?: unknown;
    EXPRESSION?: unknown;
    COLLATION?: unknown;
    SUB_PART?: unknown;
    NON_UNIQUE?: unknown;
    INDEX_TYPE?: unknown;
    INDEX_COMMENT?: unknown;
    INDEX_DEFINITION_COMMENT?: unknown;
    CARDINALITY?: unknown;
    IS_VISIBLE?: unknown;
}

interface MysqlPartitionRow extends MysqlRow {
    PARTITION_NAME?: unknown;
    SUBPARTITION_NAME?: unknown;
    PARTITION_ORDINAL_POSITION?: unknown;
    SUBPARTITION_ORDINAL_POSITION?: unknown;
    PARTITION_METHOD?: unknown;
    SUBPARTITION_METHOD?: unknown;
    PARTITION_EXPRESSION?: unknown;
    SUBPARTITION_EXPRESSION?: unknown;
    PARTITION_DESCRIPTION?: unknown;
    TABLE_ROWS?: unknown;
    DATA_LENGTH?: unknown;
    INDEX_LENGTH?: unknown;
    TABLESPACE_NAME?: unknown;
    PARTITION_COMMENT?: unknown;
}

function rowValue(row: MysqlRow, name: string): unknown {
    if (name in row) {
        return row[name];
    }
    const key = Object.keys(row).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? row[key] : undefined;
}

function text(value: unknown): string {
    return value == null ? '' : String(value).trim();
}

function optionalText(value: unknown): string | undefined {
    const result = text(value);
    return result || undefined;
}

function numberValue(value: unknown): number | undefined {
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
        return undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    return ['1', 'true', 'yes', 'y'].includes(text(value).toLowerCase());
}

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
    }
    return trimmed.toLowerCase();
}

function normalizeMethod(value: unknown): MysqlPartitionMethod {
    const method = text(value).toUpperCase();
    switch (method) {
        case 'RANGE':
        case 'LIST':
        case 'HASH':
        case 'LINEAR HASH':
        case 'KEY':
        case 'LINEAR KEY':
        case 'AUTO':
            return method;
        default:
            return 'UNKNOWN';
    }
}

export function parseMysqlVersion(value: string): { major: number; minor: number; patch: number } | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) {
        return undefined;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function supportsDescendingIndexes(engine: string, serverVersion: string): boolean {
    const version = parseMysqlVersion(serverVersion);
    if (engine.toUpperCase() !== 'INNODB' || !version) {
        return false;
    }
    return version.major >= 8;
}

function mapColumns(rows: MysqlRow[]): MysqlDesignerColumn[] {
    const columns = new Map<string, MysqlDesignerColumn>();
    rows.forEach((row, index) => {
        const column = {
            name: text(rowValue(row, 'ATTNAME') ?? rowValue(row, 'COLUMN_NAME')),
            type: text(rowValue(row, 'FORMAT_TYPE') ?? rowValue(row, 'COLUMN_TYPE') ?? rowValue(row, 'DATA_TYPE')),
            notNull: booleanValue(rowValue(row, 'IS_NOT_NULL')),
            ordinal: numberValue(rowValue(row, 'ATTNUM') ?? rowValue(row, 'ORDINAL_POSITION')) ?? index + 1,
            defaultValue: text(rowValue(row, 'COLDEFAULT') ?? rowValue(row, 'COLUMN_DEFAULT')),
            description: text(rowValue(row, 'DESCRIPTION') ?? rowValue(row, 'COLUMN_COMMENT')),
            isPrimaryKey: booleanValue(rowValue(row, 'IS_PK')),
            isForeignKey: booleanValue(rowValue(row, 'IS_FK')),
        } satisfies MysqlDesignerColumn;
        if (!column.name) {
            return;
        }
        const key = identifierKey(column.name);
        const existing = columns.get(key);
        if (!existing) {
            columns.set(key, column);
            return;
        }
        existing.notNull ||= column.notNull;
        existing.isPrimaryKey ||= column.isPrimaryKey;
        existing.isForeignKey ||= column.isForeignKey;
        if (!existing.type && column.type) {
            existing.type = column.type;
        }
        if (!existing.defaultValue && column.defaultValue) {
            existing.defaultValue = column.defaultValue;
        }
        if (!existing.description && column.description) {
            existing.description = column.description;
        }
        existing.ordinal = Math.min(existing.ordinal, column.ordinal);
    });
    return Array.from(columns.values()).sort((left, right) => left.ordinal - right.ordinal);
}

function mapIndexes(rows: MysqlIndexRow[]): MysqlDesignerExistingIndex[] {
    const indexes = new Map<string, MysqlDesignerExistingIndex>();
    for (const row of rows) {
        const name = text(rowValue(row, 'INDEX_NAME'));
        if (!name) {
            continue;
        }
        const indexKey = identifierKey(name);
        const existing = indexes.get(indexKey) ?? {
            name,
            parts: [],
            isUnique: numberValue(rowValue(row, 'NON_UNIQUE')) === 0,
            isPrimary: name.toUpperCase() === 'PRIMARY',
            indexType: text(rowValue(row, 'INDEX_TYPE')) || 'UNKNOWN',
            cardinality: numberValue(rowValue(row, 'CARDINALITY')),
            isVisible: text(rowValue(row, 'IS_VISIBLE')).toUpperCase() !== 'NO',
            comment: optionalText(rowValue(row, 'INDEX_DEFINITION_COMMENT') ?? rowValue(row, 'INDEX_COMMENT')),
        };
        const columnName = optionalText(rowValue(row, 'COLUMN_NAME'));
        const expression = optionalText(rowValue(row, 'EXPRESSION'));
        const collation = text(rowValue(row, 'COLLATION')).toUpperCase();
        existing.parts.push({
            name: columnName ?? expression ?? '',
            expression,
            order: collation === 'D' ? 'DESC' : 'ASC',
            prefixLength: numberValue(rowValue(row, 'SUB_PART')),
        });
        if (existing.cardinality === undefined) {
            existing.cardinality = numberValue(rowValue(row, 'CARDINALITY'));
        }
        indexes.set(indexKey, existing);
    }
    return Array.from(indexes.values());
}

function mapPartitions(rows: MysqlPartitionRow[]): MysqlDesignerPartition[] {
    const partitions: MysqlDesignerPartition[] = [];
    for (const row of rows) {
        const name = optionalText(rowValue(row, 'PARTITION_NAME'));
        if (!name) {
            continue;
        }
        partitions.push({
                name,
                subpartitionName: optionalText(rowValue(row, 'SUBPARTITION_NAME')),
                ordinal: numberValue(rowValue(row, 'PARTITION_ORDINAL_POSITION')) ?? 0,
                subpartitionOrdinal: numberValue(rowValue(row, 'SUBPARTITION_ORDINAL_POSITION')),
                method: normalizeMethod(rowValue(row, 'PARTITION_METHOD')),
                subpartitionMethod: optionalText(rowValue(row, 'SUBPARTITION_METHOD')),
                partitionExpression: optionalText(rowValue(row, 'PARTITION_EXPRESSION')),
                subpartitionExpression: optionalText(rowValue(row, 'SUBPARTITION_EXPRESSION')),
                description: optionalText(rowValue(row, 'PARTITION_DESCRIPTION')),
                rowCount: numberValue(rowValue(row, 'TABLE_ROWS')),
                dataLength: numberValue(rowValue(row, 'DATA_LENGTH')),
                indexLength: numberValue(rowValue(row, 'INDEX_LENGTH')),
                tablespace: optionalText(rowValue(row, 'TABLESPACE_NAME')),
                comment: optionalText(rowValue(row, 'PARTITION_COMMENT')),
        });
    }
    return partitions.sort((left, right) => left.ordinal - right.ordinal || (left.subpartitionOrdinal ?? 0) - (right.subpartitionOrdinal ?? 0));
}

async function loadTableProperties(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<{ engine: string; serverVersion: string }> {
    const rows = await services.executeQuery<MysqlTablePropertiesRow>(
        buildTablePropertiesQuery(target.schemaName, target.tableName),
        target.connectionName,
    );
    const row = rows[0];
    if (!row) {
        throw new Error(`MySQL table ${target.qualifiedName} was not found.`);
    }
    return {
        engine: text(rowValue(row, 'ENGINE')) || 'UNKNOWN',
        serverVersion: text(rowValue(row, 'SERVER_VERSION')) || 'UNKNOWN',
    };
}

export async function loadMysqlIndexDesignerContext(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<MysqlIndexDesignerInitialContext> {
    const [properties, columnRows, indexRows] = await Promise.all([
        loadTableProperties(target, services),
        services.executeQuery<MysqlRow>(
            buildColumnMetadataQuery(target.databaseName, target.schemaName, target.tableName),
            target.connectionName,
        ),
        services.executeQuery<MysqlIndexRow>(
            buildListIndexesQuery(target.schemaName, target.tableName),
            target.connectionName,
        ),
    ]);
    const columns = mapColumns(columnRows);
    if (columns.length === 0) {
        throw new Error(`MySQL did not return columns for ${target.qualifiedName}.`);
    }
    return {
        schema: target.schemaName,
        tableName: target.tableName,
        qualifiedTable: formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'mysql'),
        engine: properties.engine,
        serverVersion: properties.serverVersion,
        supportsDescendingIndexes: supportsDescendingIndexes(properties.engine, properties.serverVersion),
        columns,
        existingIndexes: mapIndexes(indexRows),
    };
}

function createPartitionCapabilities(
    properties: { engine: string; serverVersion: string },
    partitions: MysqlDesignerPartition[],
): MysqlPartitionCapabilities {
    const topLevelPartitions = partitions.filter(partition => !partition.subpartitionName);
    const firstPartition = topLevelPartitions[0] ?? partitions[0];
    const method = firstPartition?.method ?? null;
    const subpartitionMethod = firstPartition?.subpartitionMethod ?? null;
    const isPartitioned = partitions.length > 0;
    const hasSubpartitions = Boolean(subpartitionMethod) || partitions.some(partition => Boolean(partition.subpartitionName));
    const isRangeOrList = method === 'RANGE' || method === 'LIST';
    const isHashOrKey = method === 'HASH'
        || method === 'LINEAR HASH'
        || method === 'KEY'
        || method === 'LINEAR KEY';
    const hasMaxValue = topLevelPartitions.some(partition => (partition.description ?? '').toUpperCase().includes('MAXVALUE'));
    const isNdb = properties.engine.toUpperCase() === 'NDB' || properties.engine.toUpperCase() === 'NDBCLUSTER';

    if (!isPartitioned) {
        return {
            engine: properties.engine,
            serverVersion: properties.serverVersion,
            isPartitioned: false,
            partitionMethod: null,
            subpartitionMethod: null,
            partitionExpression: null,
            canAddPartition: false,
            canDropPartition: false,
            dropMode: 'none',
            reason: 'This table is not partitioned. Creating a new partitioning scheme is not available in this panel.',
        };
    }

    if (hasSubpartitions) {
        return {
            engine: properties.engine,
            serverVersion: properties.serverVersion,
            isPartitioned: true,
            partitionMethod: method,
            subpartitionMethod,
            partitionExpression: firstPartition?.partitionExpression ?? null,
            canAddPartition: false,
            canDropPartition: false,
            dropMode: 'none',
            reason: 'Subpartitioned tables are currently read-only in the Partition Manager.',
        };
    }

    if (!isRangeOrList && !isHashOrKey) {
        return {
            engine: properties.engine,
            serverVersion: properties.serverVersion,
            isPartitioned: true,
            partitionMethod: method,
            subpartitionMethod,
            partitionExpression: firstPartition?.partitionExpression ?? null,
            canAddPartition: false,
            canDropPartition: false,
            dropMode: 'none',
            reason: `Partition method ${method ?? 'UNKNOWN'} is not supported by this panel.`,
        };
    }

    return {
        engine: properties.engine,
        serverVersion: properties.serverVersion,
        isPartitioned: true,
        partitionMethod: method,
        subpartitionMethod,
        partitionExpression: firstPartition?.partitionExpression ?? null,
        canAddPartition: isHashOrKey || !hasMaxValue,
        canDropPartition: !isNdb,
        dropMode: isNdb ? 'none' : isHashOrKey ? 'coalesce' : 'named',
        reason: hasMaxValue && isRangeOrList
            ? 'The last RANGE partition uses MAXVALUE. Adding a partition requires REORGANIZE PARTITION, which is outside this version.'
            : isNdb
                ? 'NDB does not support DROP PARTITION.'
                : undefined,
    };
}

export async function loadMysqlPartitionDesignerContext(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<MysqlPartitionDesignerInitialContext> {
    const [properties, columnRows, partitionRows] = await Promise.all([
        loadTableProperties(target, services),
        services.executeQuery<MysqlRow>(
            buildColumnMetadataQuery(target.databaseName, target.schemaName, target.tableName),
            target.connectionName,
        ),
        services.executeQuery<MysqlPartitionRow>(
            buildListPartitionsQuery(target.schemaName, target.tableName),
            target.connectionName,
        ),
    ]);
    const columns = mapColumns(columnRows);
    const partitions = mapPartitions(partitionRows);
    const capabilities = createPartitionCapabilities(properties, partitions);
    return {
        schema: target.schemaName,
        tableName: target.tableName,
        qualifiedTable: formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'mysql'),
        columns,
        capabilities,
        partitions,
    };
}
