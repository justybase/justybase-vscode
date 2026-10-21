/**
 * Schema Commands - Read-only catalog reports
 * Commands: showTableSize, showTablePrivileges, showTableMaintenanceStatus, showLockWaits, showInvalidObjects
 *
 * Each dialect supplies the SQL through its metadata provider
 * (`buildTableReportQuery` / `buildDatabaseReportQuery`); the result opens in SQL Results.
 */

import * as vscode from 'vscode';
import { getDatabaseMetadataProvider } from '../../core/connectionFactory';
import type { DatabaseCapabilities } from '../../contracts/database';
import type { DatabaseReportKind, DatabaseTableReportKind } from '../../contracts/database/metadataProvider';
import { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getItemObjectName, openAndRunSql } from './helpers';

interface TableReportCommand {
    command: string;
    report: DatabaseTableReportKind;
    capability: keyof DatabaseCapabilities;
    title: string;
}

interface DatabaseReportCommand {
    command: string;
    report: DatabaseReportKind;
    capability: keyof DatabaseCapabilities;
    title: string;
}

const TABLE_REPORTS: readonly TableReportCommand[] = [
    { command: 'netezza.showTableSize', report: 'size', capability: 'supportsTableSizeReport', title: 'table size' },
    { command: 'netezza.showTablePrivileges', report: 'privileges', capability: 'supportsTablePrivilegesReport', title: 'table privileges' },
    { command: 'netezza.showTableMaintenanceStatus', report: 'maintenance', capability: 'supportsTableMaintenanceReport', title: 'maintenance status' },
];

const DATABASE_REPORTS: readonly DatabaseReportCommand[] = [
    { command: 'netezza.showLockWaits', report: 'locks', capability: 'supportsLockReport', title: 'lock waits' },
    { command: 'netezza.showInvalidObjects', report: 'invalidObjects', capability: 'supportsInvalidObjectsReport', title: 'invalid objects' },
];

/**
 * Register read-only report commands
 */
export function registerReportCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { connectionManager } = deps;

    const providerFor = (item: SchemaItemData, capability: keyof DatabaseCapabilities, title: string) => {
        const connectionName = item?.connectionName;
        const databaseKind = connectionName ? connectionManager.getConnectionDatabaseKind(connectionName) : undefined;
        if (!connectionName || !databaseKind || !connectionManager.supportsCapability(capability, undefined, connectionName)) {
            vscode.window.showWarningMessage(`The ${title} report is not available for this database type.`);
            return undefined;
        }
        return { connectionName, provider: getDatabaseMetadataProvider(databaseKind) };
    };

    const run = async (connectionName: string, database: string, sql: string | undefined, title: string, target: string) => {
        if (!sql) {
            vscode.window.showWarningMessage(`The ${title} report is not available for this database type.`);
            return;
        }
        await openAndRunSql(connectionManager, { connectionName, database }, sql, `${title[0].toUpperCase()}${title.slice(1)}: ${target}`);
    };

    return [
        ...TABLE_REPORTS.map(({ command, report, capability, title }) =>
            vscode.commands.registerCommand(command, async (item: SchemaItemData) => {
                const name = item ? getItemObjectName(item) : '';
                if (!item?.dbName || !item.schema || !name) {
                    vscode.window.showErrorMessage(`Right-click a table to show its ${title}.`);
                    return;
                }
                const resolved = providerFor(item, capability, title);
                if (!resolved) return;
                const sql = resolved.provider.buildTableReportQuery?.(item.dbName, item.schema, name, report);
                await run(resolved.connectionName, item.dbName, sql, title, `${item.schema}.${name}`);
            })),
        ...DATABASE_REPORTS.map(({ command, report, capability, title }) =>
            vscode.commands.registerCommand(command, async (item: SchemaItemData) => {
                const database = item?.dbName || item?.label;
                if (!database) {
                    vscode.window.showErrorMessage(`Right-click a database to show its ${title}.`);
                    return;
                }
                const resolved = providerFor(item, capability, title);
                if (!resolved) return;
                const sql = resolved.provider.buildDatabaseReportQuery?.(database, report);
                await run(resolved.connectionName, database, sql, title, database);
            })),
    ];
}
