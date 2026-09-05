import type {
    DatabaseKind,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget
} from '../contracts/database';
import { getRequiredDatabaseDdlProvider } from './connectionFactory';

export function quoteSqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export async function openRecreateTableScript(
    target: DatabaseMaintenanceTarget,
    services: DatabaseMaintenanceServices,
    kind: DatabaseKind
): Promise<void> {
    const connectionDetails = await services.getConnectionDetails(target.connectionName);
    if (!connectionDetails) {
        throw new Error(`Connection details not found for ${target.connectionName}.`);
    }

    // Optional companion extensions are bundled separately from the core
    // extension. Prefer the provider resolved by the host services so the
    // lookup uses the core registry rather than the companion's private copy.
    const ddlProvider = services.getDdlProvider?.(kind) ?? getRequiredDatabaseDdlProvider(kind);
    const result = await ddlProvider.generateDDL(
        connectionDetails,
        target.databaseName,
        target.schemaName,
        target.tableName,
        'TABLE'
    );

    if (!result.success || !result.ddlCode) {
        throw new Error(result.error || `Failed to generate DDL for ${target.qualifiedName}.`);
    }

    await services.openSqlDocument(result.ddlCode);
}
