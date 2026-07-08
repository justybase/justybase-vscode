import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import { openRecreateTableScript } from '../../../src/core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

function getMysqlQualifiedTableName(target: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[0]): string {
    return formatQualifiedObjectName(undefined, target.schemaName || target.databaseName, target.tableName, 'mysql');
}

async function runAnalyze(
    target: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[0],
    services: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[1],
    actionLabel: string,
    confirmationLabel: string,
    progressTitle: string,
    successMessage: string,
    errorPrefix: string
): Promise<void> {
    const sql = `ANALYZE TABLE ${getMysqlQualifiedTableName(target)};`;
    const confirmation = await vscode.window.showInformationMessage(
        `${actionLabel} "${target.qualifiedName}"?\n\n${sql}`,
        { modal: true },
        confirmationLabel,
        'Cancel'
    );

    if (confirmation !== confirmationLabel) {
        return;
    }

    await services.executeAndReport(target, sql, progressTitle, successMessage, errorPrefix);
}

export const mysqlMaintenanceProvider: DatabaseMaintenanceProvider = {
    async generateStatistics(target, services): Promise<void> {
        await runAnalyze(
            target,
            services,
            'Generate statistics for table',
            'Yes, generate',
            `Generating statistics for ${target.qualifiedName}...`,
            'Statistics generated successfully',
            'Error generating statistics'
        );
    },

    async vacuumTable(target, services): Promise<void> {
        const sql = `OPTIMIZE TABLE ${getMysqlQualifiedTableName(target)};`;
        const confirmation = await vscode.window.showWarningMessage(
            `Optimize table "${target.qualifiedName}" to reclaim space?\n\n${sql}`,
            { modal: true },
            'Yes, optimize',
            'Cancel'
        );

        if (confirmation !== 'Yes, optimize') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `OPTIMIZE TABLE ${target.qualifiedName}...`,
            'OPTIMIZE TABLE completed successfully',
            'Error during OPTIMIZE TABLE'
        );
    },

    async analyzeTable(target, services): Promise<void> {
        await runAnalyze(
            target,
            services,
            'Analyze table',
            'Yes, analyze',
            `ANALYZE TABLE ${target.qualifiedName}...`,
            'ANALYZE TABLE completed successfully',
            'Error during ANALYZE TABLE'
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'mysql');
    }
};
