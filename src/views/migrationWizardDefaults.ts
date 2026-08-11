import type { MigrationWizardConnection } from '../contracts/webviews/migrationWizardContracts';

export function resolveMigrationTargetDatabase(
    explicitDatabase: string | undefined,
    targetConnectionName: string,
    connections: readonly MigrationWizardConnection[],
): string | undefined {
    if (explicitDatabase !== undefined) {
        return explicitDatabase;
    }
    return connections.find(connection => connection.name === targetConnectionName)?.database;
}

