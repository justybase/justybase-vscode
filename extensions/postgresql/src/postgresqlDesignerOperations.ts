import type {
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget,
} from '@justybase/contracts';
import type {
    PostgresqlAlterTableDesignerColumn,
    PostgresqlAlterTableDesignerInitialContext,
} from '../../../src/contracts/webviews/postgresqlAlterTableDesignerContracts';
import type {
    PostgresqlExistingIndex,
    PostgresqlIndexDesignerInitialContext,
    PostgresqlIndexPart,
} from '../../../src/contracts/webviews/postgresqlIndexDesignerContracts';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import {
    buildAlterTablePropertiesQuery,
    buildColumnMetadataQuery,
    buildDesignerListIndexesQuery,
    buildListTablespacesQuery,
} from './postgresqlSystemQueries';

interface PostgresqlRow extends Record<string, unknown> {
    [key: string]: unknown;
}

interface PostgresqlAlterTablePropertiesRow extends PostgresqlRow {
    TABLESPACE?: unknown;
    FILLFACTOR?: unknown;
    TABLE_COMMENT?: unknown;
}

interface PostgresqlTablespaceRow extends PostgresqlRow {
    TABLESPACE?: unknown;
}

interface PostgresqlIndexPartRow extends PostgresqlRow {
    INDEX_NAME?: unknown;
    IS_UNIQUE?: unknown;
    IS_PRIMARY?: unknown;
    INDEX_TYPE?: unknown;
    PREDICATE?: unknown;
    TABLESPACE?: unknown;
    COLUMN_NAME?: unknown;
    SEQ?: unknown;
    IS_KEY?: unknown;
    IS_DESC?: unknown;
    NULLS_FIRST?: unknown;
}

function rowValue(row: PostgresqlRow, name: string): unknown {
    if (name in row) {
        return row[name];
    }
    const key = Object.keys(row).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? row[key] : undefined;
}

function text(value: unknown): string {
    return value == null ? '' : String(value).trim();
}

function booleanValue(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    return ['1', 'true', 'yes', 'y'].includes(text(value).toLowerCase());
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

function mapAlterTableColumns(rows: PostgresqlRow[]): PostgresqlAlterTableDesignerColumn[] {
    return rows.map((row, index) => ({
        name: text(rowValue(row, 'ATTNAME')),
        type: text(rowValue(row, 'FORMAT_TYPE')),
        notNull: booleanValue(rowValue(row, 'IS_NOT_NULL') ?? rowValue(row, 'ATTNOTNULL')),
        defaultValue: text(rowValue(row, 'COLDEFAULT')),
        comment: text(rowValue(row, 'DESCRIPTION')),
        ordinal: numberValue(rowValue(row, 'ATTNUM')) ?? index + 1,
        isPrimaryKey: booleanValue(rowValue(row, 'IS_PK')),
        isForeignKey: booleanValue(rowValue(row, 'IS_FK')),
    })).filter(column => column.name && column.type);
}

async function loadAlterTableProperties(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<{ tablespace: string; fillfactor: string; comment: string }> {
    const rows = await services.executeQuery<PostgresqlAlterTablePropertiesRow>(
        buildAlterTablePropertiesQuery(target.schemaName, target.tableName),
        target.connectionName,
    );
    const row = rows[0];
    if (!row) {
        throw new Error(`PostgreSQL table ${target.qualifiedName} was not found.`);
    }
    return {
        tablespace: text(rowValue(row, 'TABLESPACE')),
        fillfactor: text(rowValue(row, 'FILLFACTOR')),
        comment: text(rowValue(row, 'TABLE_COMMENT')),
    };
}

function mapExistingIndexes(rows: PostgresqlIndexPartRow[]): PostgresqlExistingIndex[] {
    const indexes = new Map<string, PostgresqlExistingIndex>();
    for (const row of rows) {
        const name = text(rowValue(row, 'INDEX_NAME'));
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        const existing = indexes.get(key) ?? {
            name,
            keyParts: [],
            includeParts: [],
            isUnique: booleanValue(rowValue(row, 'IS_UNIQUE')),
            isPrimary: booleanValue(rowValue(row, 'IS_PRIMARY')),
            method: text(rowValue(row, 'INDEX_TYPE')) || 'UNKNOWN',
            tablespace: text(rowValue(row, 'TABLESPACE')),
            predicate: text(rowValue(row, 'PREDICATE')),
        };
        const part: PostgresqlIndexPart = {
            name: text(rowValue(row, 'COLUMN_NAME')),
            order: booleanValue(rowValue(row, 'IS_DESC')) ? 'DESC' : 'ASC',
            nulls: booleanValue(rowValue(row, 'NULLS_FIRST')) ? 'FIRST' : 'LAST',
        };
        if (booleanValue(rowValue(row, 'IS_KEY'))) {
            existing.keyParts.push(part);
        } else {
            existing.includeParts.push(part.name);
        }
        indexes.set(key, existing);
    }
    return Array.from(indexes.values());
}

export async function loadPostgresqlIndexDesignerContext(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<PostgresqlIndexDesignerInitialContext> {
    const [columnRows, indexRows, tablespaceRows] = await Promise.all([
        services.executeQuery<PostgresqlRow>(
            buildColumnMetadataQuery(target.databaseName, target.schemaName, target.tableName),
            target.connectionName,
        ),
        services.executeQuery<PostgresqlIndexPartRow>(
            buildDesignerListIndexesQuery(target.schemaName, target.tableName),
            target.connectionName,
        ),
        services.executeQuery<PostgresqlTablespaceRow>(
            buildListTablespacesQuery(),
            target.connectionName,
        ),
    ]);
    const columns = mapAlterTableColumns(columnRows);
    if (columns.length === 0) {
        throw new Error(`PostgreSQL did not return columns for ${target.qualifiedName}.`);
    }
    return {
        schema: target.schemaName,
        tableName: target.tableName,
        qualifiedTable: formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'postgresql'),
        columns,
        existingIndexes: mapExistingIndexes(indexRows),
        tablespaces: tablespaceRows
            .map(row => text(rowValue(row, 'TABLESPACE')))
            .filter(Boolean),
    };
}

export async function loadPostgresqlAlterTableDesignerContext(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
): Promise<PostgresqlAlterTableDesignerInitialContext> {
    const [properties, columnRows, tablespaceRows] = await Promise.all([
        loadAlterTableProperties(target, services),
        services.executeQuery<PostgresqlRow>(
            buildColumnMetadataQuery(target.databaseName, target.schemaName, target.tableName),
            target.connectionName,
        ),
        services.executeQuery<PostgresqlTablespaceRow>(
            buildListTablespacesQuery(),
            target.connectionName,
        ),
    ]);
    const columns = mapAlterTableColumns(columnRows);
    if (columns.length === 0) {
        throw new Error(`PostgreSQL did not return columns for ${target.qualifiedName}.`);
    }
    return {
        schema: target.schemaName,
        tableName: target.tableName,
        qualifiedTable: formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'postgresql'),
        columns,
        options: {
            tablespace: properties.tablespace,
            fillfactor: properties.fillfactor,
            comment: properties.comment,
        },
        tablespaces: tablespaceRows
            .map(row => text(rowValue(row, 'TABLESPACE')))
            .filter(Boolean),
    };
}