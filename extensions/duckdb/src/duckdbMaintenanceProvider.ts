import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import { openRecreateTableScript } from '../../../src/core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

function getDuckDbQualifiedTableName(target: Parameters<NonNullable<DatabaseMaintenanceProvider['vacuumTable']>>[0]): string {
    return formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'duckdb');
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
    const sql = `ANALYZE ${getDuckDbQualifiedTableName(target)};`;
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

export const duckdbMaintenanceProvider: DatabaseMaintenanceProvider = {
    async vacuumTable(target, services): Promise<void> {
        const sql = `VACUUM ${getDuckDbQualifiedTableName(target)};`;
        const confirmation = await vscode.window.showWarningMessage(
            `Run VACUUM on table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, vacuum',
            'Cancel'
        );

        if (confirmation !== 'Yes, vacuum') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `VACUUM ${target.qualifiedName}...`,
            'VACUUM completed successfully',
            'Error during VACUUM'
        );
    },

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

    async analyzeTable(target, services): Promise<void> {
        await runAnalyze(
            target,
            services,
            'Analyze table',
            'Yes, analyze',
            `ANALYZE ${target.qualifiedName}...`,
            'ANALYZE completed successfully',
            'Error during ANALYZE'
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'duckdb');
    }
};
