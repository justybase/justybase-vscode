import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import { openRecreateTableScript } from '../../../src/core/maintenanceProviderUtils';

function getMsSqlQualifiedTableName(target: Parameters<NonNullable<DatabaseMaintenanceProvider['generateStatistics']>>[0]): string {
    const quoteIdentifier = (value: string): string => `[${value.replace(/]/g, ']]')}]`;
    const parts = [target.databaseName, target.schemaName, target.tableName]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(quoteIdentifier);
    return parts.join('.');
}

export const mssqlMaintenanceProvider: DatabaseMaintenanceProvider = {
    async generateStatistics(target, services): Promise<void> {
        const sql = `UPDATE STATISTICS ${getMsSqlQualifiedTableName(target)};`;
        const confirmation = await vscode.window.showInformationMessage(
            `Update statistics for table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, update',
            'Cancel'
        );

        if (confirmation !== 'Yes, update') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `UPDATE STATISTICS ${target.qualifiedName}...`,
            'UPDATE STATISTICS completed successfully',
            'Error during UPDATE STATISTICS'
        );
    },

    async reindexTable(target, services): Promise<void> {
        const sql = `ALTER INDEX ALL ON ${getMsSqlQualifiedTableName(target)} REBUILD;`;
        const confirmation = await vscode.window.showWarningMessage(
            `Rebuild indexes for table "${target.qualifiedName}"?\n\n${sql}\n\nWarning: index rebuilds can be disruptive on busy tables.`,
            { modal: true },
            'Yes, rebuild',
            'Cancel'
        );

        if (confirmation !== 'Yes, rebuild') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Rebuilding indexes for ${target.qualifiedName}...`,
            'Index rebuild completed successfully',
            'Error during index rebuild'
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'mssql');
    }
};
