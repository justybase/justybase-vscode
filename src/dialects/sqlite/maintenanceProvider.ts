import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '../../contracts/database';
import { openRecreateTableScript } from '../../core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../utils/identifierUtils';

type MaintenanceTarget = Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[0];
type MaintenanceServices = Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[1];

function qualifiedTable(target: MaintenanceTarget): string {
    // SQLite temp tables live in the "temp" catalog; the maintenance target
    // reports them under schemaName === 'temp' while databaseName stays
    // "main", so prefer the temp catalog instead of silently falling back.
    const catalog = target.schemaName.trim().toLowerCase() === 'temp'
        ? 'temp'
        : (target.databaseName || 'main');
    return formatQualifiedObjectName(catalog, undefined, target.tableName, 'sqlite');
}

async function executeConfirmed(
    target: MaintenanceTarget,
    services: MaintenanceServices,
    sql: string,
    question: string,
    confirmation: string,
    progressTitle: string,
    successMessage: string,
    errorPrefix: string,
): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
        `${question}\n\n${sql}`,
        { modal: true },
        confirmation,
        'Cancel',
    );
    if (answer !== confirmation) {
        return;
    }
    await services.executeAndReport(target, sql, progressTitle, successMessage, errorPrefix);
}

export const sqliteMaintenanceProvider: DatabaseMaintenanceProvider = {
    async generateStatistics(target, services): Promise<void> {
        await executeConfirmed(
            target,
            services,
            `ANALYZE ${qualifiedTable(target)};`,
            `Generate SQLite statistics for "${target.qualifiedName}"?`,
            'Yes, generate',
            `Generating statistics for ${target.qualifiedName}...`,
            'SQLite statistics generated successfully',
            'Error generating SQLite statistics',
        );
    },

    async analyzeTable(target, services): Promise<void> {
        await executeConfirmed(
            target,
            services,
            `ANALYZE ${qualifiedTable(target)};`,
            `Analyze SQLite table "${target.qualifiedName}"?`,
            'Yes, analyze',
            `ANALYZE ${target.qualifiedName}...`,
            'SQLite ANALYZE completed successfully',
            'Error during SQLite ANALYZE',
        );
    },

    async reindexTable(target, services): Promise<void> {
        await executeConfirmed(
            target,
            services,
            `REINDEX ${qualifiedTable(target)};`,
            `Rebuild indexes for SQLite table "${target.qualifiedName}"?`,
            'Yes, reindex',
            `REINDEX ${target.qualifiedName}...`,
            'SQLite REINDEX completed successfully',
            'Error during SQLite REINDEX',
        );
    },

    async vacuumTable(target, services): Promise<void> {
        await executeConfirmed(
            target,
            services,
            'VACUUM;',
            'VACUUM operates on the entire SQLite database. Continue?',
            'Yes, vacuum database',
            'Vacuuming SQLite database...',
            'SQLite VACUUM completed successfully',
            'Error during SQLite VACUUM',
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'sqlite');
    },
};
