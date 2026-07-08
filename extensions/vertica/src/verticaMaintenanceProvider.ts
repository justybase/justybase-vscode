import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import { getRequiredDatabaseDdlProvider } from '../../../src/core/connectionFactory';

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function toVerticaQualifiedLiteral(schemaName: string, tableName: string): string {
    return `${schemaName}.${tableName}`;
}

async function analyzeTableInternal(target: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[0], services: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[1]): Promise<void> {
    const objectRef = toVerticaQualifiedLiteral(target.schemaName, target.tableName);
    const sql = `SELECT ANALYZE_STATISTICS('${escapeSqlLiteral(objectRef)}');`;
    await services.executeAndReport(
        target,
        sql,
        `Analyzing ${target.qualifiedName}...`,
        'ANALYZE_STATISTICS completed successfully',
        'Error during ANALYZE_STATISTICS',
    );
}

export const verticaMaintenanceProvider: DatabaseMaintenanceProvider = {
    async vacuumTable(target, services): Promise<void> {
        const objectRef = toVerticaQualifiedLiteral(target.schemaName, target.tableName);
        const sql = `SELECT PURGE_TABLE('${escapeSqlLiteral(objectRef)}');`;
        const confirmation = await vscode.window.showWarningMessage(
            `Purge deleted storage for "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, purge',
            'Cancel',
        );

        if (confirmation !== 'Yes, purge') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Purging ${target.qualifiedName}...`,
            'PURGE_TABLE completed successfully',
            'Error during PURGE_TABLE',
        );
    },

    async generateStatistics(target, services): Promise<void> {
        await analyzeTableInternal(target, services);
    },

    async analyzeTable(target, services): Promise<void> {
        await analyzeTableInternal(target, services);
    },

    async checkSkew(target, services): Promise<void> {
        const ddlProvider = getRequiredDatabaseDdlProvider('vertica');
        const sql = ddlProvider.buildSkewCheckQuery(target.qualifiedName);
        await services.openSqlDocument(`${sql};\n`);
    },

    async recreateTable(target, services): Promise<void> {
        const connectionDetails = await services.getConnectionDetails(target.connectionName);
        if (!connectionDetails) {
            throw new Error(`Connection details not found for ${target.connectionName}.`);
        }

        const ddlProvider = getRequiredDatabaseDdlProvider('vertica');
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
    },

    async reindexTable(target, services): Promise<void> {
        await services.openSqlDocument(`-- Vertica uses projections instead of secondary indexes.\n-- Review or refresh the relevant projections for ${target.qualifiedName}.\nSELECT\n    PROJECTION_SCHEMA,\n    PROJECTION_NAME,\n    ANCHOR_TABLE_NAME,\n    SEGMENT_EXRESSION,\n    IS_UP_TO_DATE\nFROM V_CATALOG.PROJECTIONS\nWHERE UPPER(PROJECTION_SCHEMA) = UPPER('${escapeSqlLiteral(target.schemaName)}')\n  AND UPPER(ANCHOR_TABLE_NAME) = UPPER('${escapeSqlLiteral(target.tableName)}')\nORDER BY PROJECTION_NAME;\n`);
    },
};
