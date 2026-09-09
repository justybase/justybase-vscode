import type {
  DatabaseDdlProvider,
  DatabaseKind,
  DatabaseMaintenanceServices,
  DatabaseMaintenanceTarget,
} from '@justybase/contracts';

export function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Generate and open a recreate-table script using only host-provided
 * services. The host owns provider lookup; this package never reaches into a
 * desktop registry.
 */
export async function openRecreateTableScript(
  target: DatabaseMaintenanceTarget,
  services: DatabaseMaintenanceServices,
  kind: DatabaseKind,
): Promise<void> {
  const connectionDetails = await services.getConnectionDetails(target.connectionName);
  if (!connectionDetails) {
    throw new Error(`Connection details not found for ${target.connectionName}.`);
  }

  const ddlProvider: DatabaseDdlProvider | undefined = services.getDdlProvider?.(kind);
  if (!ddlProvider) {
    throw new Error(`Database dialect '${kind}' does not provide a host DDL provider.`);
  }

  const result = await ddlProvider.generateDDL(
    connectionDetails,
    target.databaseName,
    target.schemaName,
    target.tableName,
    'TABLE',
  );

  if (!result.success || !result.ddlCode) {
    throw new Error(result.error || `Failed to generate DDL for ${target.qualifiedName}.`);
  }

  await services.openSqlDocument(result.ddlCode);
}
