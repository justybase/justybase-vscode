import type { DatabaseKind } from '../../contracts/database';
import { getDatabaseDialectTraits } from '../../core/dialectTraits';
import type { ConnectionDetails } from '../../types';
import { parseImportTargetTable, composeQualifiedImportTargetDisplayName } from '../batchImportSupport';
import { resolveImportDialect, type SupportedImportDialect } from '../importDispatcher';

export interface ImportTargetLocation {
    database?: string;
    schema?: string;
    tableName: string;
}

export interface ImportTargetLocationCapabilities {
    supportsDatabaseSelection: boolean;
    supportsSchemaSelection: boolean;
    enforceActiveDatabase: boolean;
}

const ENFORCE_ACTIVE_DATABASE: Partial<Record<SupportedImportDialect, boolean>> = {
    db2: true,
    postgresql: true,
    mssql: true,
};

export function getImportTargetLocationCapabilities(
    kind: DatabaseKind,
): ImportTargetLocationCapabilities {
    const traits = getDatabaseDialectTraits(kind).qualification;
    const dialect = resolveImportDialect(kind);

    return {
        supportsDatabaseSelection:
            traits.supportsThreePartName || traits.twoPartNameStyle === 'database-object',
        supportsSchemaSelection:
            traits.supportsThreePartName || traits.twoPartNameStyle === 'schema-object',
        enforceActiveDatabase: ENFORCE_ACTIVE_DATABASE[dialect] ?? false,
    };
}

export function parseImportTargetLocation(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    kind: DatabaseKind,
): ImportTargetLocation {
    const parsed = parseImportTargetTable(targetTable, connectionDetails, kind);
    const caps = getImportTargetLocationCapabilities(kind);
    const activeDatabase = connectionDetails.database?.trim() || undefined;

    if (parsed.providedDatabase && caps.supportsDatabaseSelection) {
        return {
            database: parsed.providedDatabase,
            schema: caps.supportsSchemaSelection ? parsed.schema : undefined,
            tableName: parsed.table,
        };
    }

    if (parsed.schema && caps.supportsSchemaSelection) {
        return {
            database: activeDatabase,
            schema: parsed.schema,
            tableName: parsed.table,
        };
    }

    return {
        database: caps.supportsDatabaseSelection
            ? parsed.providedDatabase || activeDatabase
            : undefined,
        schema: undefined,
        tableName: parsed.table,
    };
}

export function composeImportTargetTable(
    location: ImportTargetLocation,
    connectionDetails: ConnectionDetails,
    kind: DatabaseKind,
): string {
    const caps = getImportTargetLocationCapabilities(kind);
    const tableName = location.tableName.trim();

    if (!tableName) {
        throw new Error('Target table name is required.');
    }

    const activeDatabase = connectionDetails.database?.trim() || undefined;
    const database = caps.supportsDatabaseSelection
        ? caps.enforceActiveDatabase
            ? activeDatabase || location.database?.trim()
            : location.database?.trim()
        : undefined;
    const schema = caps.supportsSchemaSelection ? location.schema?.trim() : undefined;

    return composeQualifiedImportTargetDisplayName(
        database,
        schema,
        tableName,
        kind,
    );
}

export function resolveDefaultImportTargetLocation(
    location: ImportTargetLocation,
    connectionDetails: ConnectionDetails,
    kind: DatabaseKind,
    availableDatabases: readonly string[],
    availableSchemas: readonly string[],
): ImportTargetLocation {
    const caps = getImportTargetLocationCapabilities(kind);
    const activeDatabase = connectionDetails.database?.trim() || undefined;
    let database = location.database?.trim();
    let schema = location.schema?.trim();

    if (caps.supportsDatabaseSelection) {
        if (caps.enforceActiveDatabase && activeDatabase) {
            database = activeDatabase;
        } else if (availableDatabases.length > 0) {
            if (
                database &&
                !availableDatabases.some((item) => item.toUpperCase() === database!.toUpperCase())
            ) {
                database = availableDatabases[0] || activeDatabase;
            } else if (!database) {
                database =
                    (activeDatabase &&
                    availableDatabases.some((item) => item.toUpperCase() === activeDatabase.toUpperCase())
                        ? activeDatabase
                        : availableDatabases[0]) || activeDatabase;
            }
        }
    } else {
        database = undefined;
    }

    if (caps.supportsSchemaSelection) {
        if (availableSchemas.length > 0) {
            if (
                schema &&
                !availableSchemas.some((item) => item.toUpperCase() === schema!.toUpperCase())
            ) {
                schema = availableSchemas[0];
            } else if (!schema) {
                schema = availableSchemas[0];
            }
        }
    } else {
        schema = undefined;
    }

    return {
        database,
        schema,
        tableName: location.tableName,
    };
}
