import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import {
    openRecreateTableScript,
    quoteSqlLiteral
} from '../../../src/core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

function getOracleQualifiedTableName(target: Parameters<NonNullable<DatabaseMaintenanceProvider['analyzeTable']>>[0]): string {
    return formatQualifiedObjectName(undefined, target.schemaName, target.tableName, 'oracle');
}

export const oracleMaintenanceProvider: DatabaseMaintenanceProvider = {
    async generateStatistics(target, services): Promise<void> {
        const sql = `
BEGIN
    DBMS_STATS.GATHER_TABLE_STATS(
        ownname => ${quoteSqlLiteral(target.schemaName)},
        tabname => ${quoteSqlLiteral(target.tableName)},
        cascade => TRUE
    );
END;
        `.trim();
        const confirmation = await vscode.window.showInformationMessage(
            `Generate statistics for table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, generate',
            'Cancel'
        );

        if (confirmation !== 'Yes, generate') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Generating statistics for ${target.qualifiedName}...`,
            'Statistics generated successfully',
            'Error generating statistics'
        );
    },

    async vacuumTable(target, services): Promise<void> {
        const sql = `ALTER TABLE ${getOracleQualifiedTableName(target)} MOVE;`;
        const confirmation = await vscode.window.showWarningMessage(
            `Move table "${target.qualifiedName}" to reclaim segment space?\n\n${sql}\n\nWarning: this operation can invalidate dependent indexes until they are rebuilt.`,
            { modal: true },
            'Yes, move',
            'Cancel'
        );

        if (confirmation !== 'Yes, move') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `Moving ${target.qualifiedName}...`,
            'ALTER TABLE MOVE completed successfully',
            'Error during ALTER TABLE MOVE'
        );
    },

    async analyzeTable(target, services): Promise<void> {
        const sql = `ANALYZE TABLE ${getOracleQualifiedTableName(target)} COMPUTE STATISTICS;`;
        const confirmation = await vscode.window.showInformationMessage(
            `Analyze table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, analyze',
            'Cancel'
        );

        if (confirmation !== 'Yes, analyze') {
            return;
        }

        await services.executeAndReport(
            target,
            sql,
            `ANALYZE TABLE ${target.qualifiedName}...`,
            'ANALYZE TABLE completed successfully',
            'Error during ANALYZE TABLE'
        );
    },

    async reindexTable(target, services): Promise<void> {
        const sql = `
BEGIN
    FOR idx IN (
        SELECT OWNER, INDEX_NAME
        FROM ALL_INDEXES
        WHERE TABLE_OWNER = ${quoteSqlLiteral(target.schemaName)}
          AND TABLE_NAME = ${quoteSqlLiteral(target.tableName)}
    ) LOOP
        EXECUTE IMMEDIATE 'ALTER INDEX "' || REPLACE(idx.OWNER, '"', '""') || '"."' || REPLACE(idx.INDEX_NAME, '"', '""') || '" REBUILD';
    END LOOP;
END;
        `.trim();
        const confirmation = await vscode.window.showWarningMessage(
            `Rebuild indexes for table "${target.qualifiedName}"?\n\n${sql}`,
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
        await openRecreateTableScript(target, services, 'oracle');
    }
};
