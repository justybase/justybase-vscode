/**
 * Schema Commands - Table Data Export
 *
 * Exports all rows of a schema-tree table or view through the shared
 * streaming exporters (CSV, JSON, XML, SQL INSERT, Markdown, Excel) and the
 * Parquet exporter. Uses an isolated temporary connection like the
 * schema-tree exports in the Tauri shell; rows stream straight from the
 * database session into the output file.
 */

import * as vscode from 'vscode';
import { getConnectionForDocument } from '../../core/queryRunnerHelpers';
import { getExtensionConfiguration } from '../../compatibility/configuration';
import type { QueryStreamExportFormat } from '../../export/queryStreamExporter';
import type { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName } from './helpers';

interface ExportFormatChoice {
    label: string;
    description: string;
    value: QueryStreamExportFormat | 'parquet';
    extension: string;
}

const EXPORT_FORMATS: ExportFormatChoice[] = [
    { label: 'CSV', description: 'Comma-separated values', value: 'csv', extension: 'csv' },
    { label: 'CSV.GZ', description: 'Gzip-compressed CSV', value: 'csv.gz', extension: 'csv.gz' },
    { label: 'CSV.ZST', description: 'Zstandard-compressed CSV', value: 'csv.zst', extension: 'csv.zst' },
    { label: 'JSON', description: 'JSON array of objects', value: 'json', extension: 'json' },
    { label: 'XML', description: 'XML document', value: 'xml', extension: 'xml' },
    { label: 'SQL INSERT', description: 'SQL INSERT statements', value: 'sql', extension: 'sql' },
    { label: 'Markdown', description: 'Markdown table', value: 'markdown', extension: 'md' },
    { label: 'Excel (XLSB)', description: 'Excel Binary Workbook', value: 'xlsb', extension: 'xlsb' },
    { label: 'Excel (XLSX)', description: 'Excel Workbook', value: 'xlsx', extension: 'xlsx' },
    { label: 'Parquet', description: 'Apache Parquet columnar file', value: 'parquet', extension: 'parquet' },
];

const EXPORTABLE_OBJECT_TYPES: ReadonlySet<string> = new Set([
    'TABLE',
    'VIEW',
    'MATERIALIZED VIEW',
    'FOREIGN TABLE',
]);

export function registerTableExportCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.exportTableData', async (item: SchemaItemData) => {
            if (!item || !item.label || !item.dbName || !item.objType || !EXPORTABLE_OBJECT_TYPES.has(item.objType)) {
                vscode.window.showErrorMessage('Select a table or view to export.');
                return;
            }
            const connectionName = deps.connectionManager.resolveConnectionName(undefined, item.connectionName);
            if (!connectionName) {
                vscode.window.showErrorMessage('No database connection. Please connect first.');
                return;
            }

            const format = await vscode.window.showQuickPick(EXPORT_FORMATS, {
                placeHolder: `Export all rows of ${item.label} as...`,
            });
            if (!format) {
                return;
            }

            const defaultFileName = `${item.rawLabel || item.label}.${format.extension}`;
            const uri = await vscode.window.showSaveDialog({
                filters: { [`${format.label} Files`]: [format.extension] },
                defaultUri: vscode.Uri.file(defaultFileName),
                saveLabel: `Export table to ${format.label}`,
            });
            if (!uri) {
                return;
            }

            const fullName = getFullName(item, deps.connectionManager);
            const query = `SELECT * FROM ${fullName};`;
            const databaseKind = deps.connectionManager.getConnectionDatabaseKind(connectionName);
            const timeout = getExtensionConfiguration().get<number>('query.executionTimeout', 1800);

            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Exporting ${item.label} to ${format.label}...`,
                        cancellable: true,
                    },
                    async (progress, token) => {
                        const report = (message: string): void => progress.report({ message });
                        if (format.value === 'parquet') {
                            const connectionDetails = await deps.connectionManager.getConnection(connectionName);
                            if (!connectionDetails) {
                                throw new Error(`Connection '${connectionName}' not found.`);
                            }
                            const { exportQueryToParquet } = await import('../../export/parquetExporter');
                            const result = await exportQueryToParquet(
                                connectionDetails,
                                query,
                                uri.fsPath,
                                false,
                                report,
                                timeout,
                                token,
                            );
                            if (!result.success) {
                                throw new Error(result.message);
                            }
                            return;
                        }
                        const { connection, shouldCloseConnection } = await getConnectionForDocument(
                            deps.connectionManager,
                            connectionName,
                            false,
                        );
                        try {
                            const { exportQueryToStreamFile } = await import('../../export/queryStreamExporter');
                            await exportQueryToStreamFile({
                                connection,
                                query,
                                filePath: uri.fsPath,
                                format: format.value as QueryStreamExportFormat,
                                sql: query,
                                sqlTargetTable: format.value === 'sql' ? fullName : undefined,
                                sqlDialect: databaseKind,
                                timeoutSeconds: timeout,
                                cancellationToken: token,
                                progress: report,
                            });
                        } finally {
                            if (shouldCloseConnection) {
                                await connection.close();
                            }
                        }
                    },
                );
                vscode.window.showInformationMessage(`Exported ${item.label} to ${uri.fsPath}`);
            } catch (error) {
                if (error instanceof vscode.CancellationError) {
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Export failed: ${message}`);
            }
        }),
    ];
}
