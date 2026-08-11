import type { MigrationWizardConnection } from './hostContracts.js';

export function getMigrationWizardTargetDatabase(
    connections: readonly MigrationWizardConnection[],
    connectionName: string,
): string | undefined {
    return connections.find(connection => connection.name === connectionName)?.database;
}

