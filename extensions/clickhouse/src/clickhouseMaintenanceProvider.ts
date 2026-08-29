import * as vscode from 'vscode';
import type { DatabaseMaintenanceProvider } from '@justybase/contracts';
import { openRecreateTableScript } from '../../../src/core/maintenanceProviderUtils';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';

type MaintenanceTarget = Parameters<NonNullable<DatabaseMaintenanceProvider['vacuumTable']>>[0];

function qualifiedTable(target: MaintenanceTarget): string {
    return formatQualifiedObjectName(target.databaseName, undefined, target.tableName, 'clickhouse');
}

export const clickhouseMaintenanceProvider: DatabaseMaintenanceProvider = {
    async vacuumTable(target, services): Promise<void> {
        const sql = `OPTIMIZE TABLE ${qualifiedTable(target)};`;
        const confirmation = await vscode.window.showWarningMessage(
            `Run a background merge for ClickHouse table "${target.qualifiedName}"?\n\n${sql}`,
            { modal: true },
            'Yes, optimize',
            'Cancel',
        );
        if (confirmation !== 'Yes, optimize') {
            return;
        }
        await services.executeAndReport(
            target,
            sql,
            `OPTIMIZE TABLE ${target.qualifiedName}...`,
            'ClickHouse OPTIMIZE TABLE started successfully',
            'Error during ClickHouse OPTIMIZE TABLE',
        );
    },

    async listPartitions(target, services) {
        return services.executeWithProgress(
            `Listing ClickHouse partitions for ${target.qualifiedName}...`,
            async () => {
                const rows = await services.executeQuery<Record<string, unknown>>(`
                    SELECT
                        database AS "SCHEMA",
                        partition AS "NAME",
                        table AS "PARENT_TABLE",
                        partition AS "PARTITION_BOUND",
                        'RANGE' AS "PARTITION_STRATEGY",
                        sum(rows) AS "ROW_COUNT",
                        sum(bytes_on_disk) AS "TOTAL_SIZE"
                    FROM system.parts
                    WHERE active = 1
                      AND database = '${target.databaseName.replace(/'/g, "''")}'
                      AND table = '${target.tableName.replace(/'/g, "''")}'
                    GROUP BY database, table, partition
                    ORDER BY partition
                `, target.connectionName);
                return rows.map(row => ({
                    schema: String(row.SCHEMA ?? target.databaseName),
                    name: String(row.NAME ?? ''),
                    parentTable: String(row.PARENT_TABLE ?? target.tableName),
                    partitionBound: String(row.PARTITION_BOUND ?? ''),
                    partitionStrategy: 'RANGE' as const,
                    rowCount: Number(row.ROW_COUNT ?? 0),
                    totalSize: Number(row.TOTAL_SIZE ?? 0),
                }));
            },
        );
    },

    async recreateTable(target, services): Promise<void> {
        await openRecreateTableScript(target, services, 'clickhouse');
    },
};
