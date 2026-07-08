import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../../../core/connectionManager';
import { exportToCsv } from '../../../export/csvExporter';
import { exportQueryToXlsb, exportStructuredToXlsb } from '../../../export/xlsbExporter';
import { exportCsvToXlsx, exportStructuredToXlsx } from '../../../export/xlsxExporter';
import { exportResultSetToFile } from '../../../export/resultExporter';
import { exportStructuredToParquet, exportQueryToParquet } from '../../../export/parquetExporter';
import { importDataForConnection } from '../../../import/importDispatcher';
import { createTabularDataImporter } from '../../../import/tabularDataImporter';
import { ConnectionDetails, ResultSet } from '../../../types';
import { ResultPanelView } from '../../../views/resultPanelView';

interface StructuredToolPayload {
    summary: string;
    data?: Record<string, unknown>;
    errors?: string[];
    nextActions?: string[];
}

interface SqlResolution {
    sql?: string;
    source: 'inline' | 'file' | 'activeEditor' | 'missing';
    hint?: string;
}

interface CopilotImportExportToolsDeps {
    connectionManager: ConnectionManager;
    context: vscode.ExtensionContext;
    resultPanelProvider?: ResultPanelView;
    getActiveConnectionDetails: () => Promise<{ connectionName: string; connectionDetails: ConnectionDetails }>;
    formatStructuredToolResponse: (payload: StructuredToolPayload) => string;
    resolveSqlInput: (sql?: string, sqlFilePath?: string) => SqlResolution;
    getEditorSqlCandidate: () => string | undefined;
    getActiveResultSetForExport: () => { sourceUri: string; resultSet: ResultSet; resultSetIndex: number };
}

export class CopilotImportExportTools {
    constructor(private readonly deps: CopilotImportExportToolsDeps) { }

    async inspectImportFile(filePath: string, sampleRows: number = 5): Promise<string> {
        const resolvedPath = filePath.trim();
        if (!fs.existsSync(resolvedPath)) {
            return this.deps.formatStructuredToolResponse({
                summary: 'Import inspection failed.',
                errors: [`File not found: ${resolvedPath}`],
                nextActions: ['Check the path and run inspect_import_file again.']
            });
        }

        const importer = createTabularDataImporter(resolvedPath, 'COPILOT_IMPORT_PREVIEW');
        await importer.analyzeDataTypes();

        const previewLimit = Math.max(1, Math.min(sampleRows || 5, 20));
        const previewRows = await importer.getSampleRows(previewLimit);
        const mappings = importer.getColumnMappings();
        const stats = fs.statSync(resolvedPath);

        return this.deps.formatStructuredToolResponse({
            summary: `Inspected import file "${path.basename(resolvedPath)}" (${mappings.length} columns detected).`,
            data: {
                filePath: resolvedPath,
                fileSizeBytes: stats.size,
                fileFormat: path.extname(resolvedPath).toLowerCase(),
                detectedDelimiter: importer.getCsvDelimiter(),
                detectedDecimalDelimiter: importer.getDecimalDelimiter(),
                rowCountEstimate: importer.getRowsCount(),
                columns: mappings,
                sampleRows: previewRows,
                audit: {
                    operation: 'inspect_import_file',
                    sampleRowsRequested: previewLimit
                }
            },
            nextActions: [
                'Use propose_import_mapping with the target table name.',
                'If mapping looks correct, execute_import with dryRun=true first.'
            ]
        });
    }

    async proposeImportMapping(filePath: string, targetTable: string): Promise<string> {
        const resolvedPath = filePath.trim();
        const normalizedTargetTable = targetTable.trim();
        if (!fs.existsSync(resolvedPath)) {
            return this.deps.formatStructuredToolResponse({
                summary: 'Mapping proposal failed.',
                errors: [`File not found: ${resolvedPath}`],
                nextActions: ['Check the file path and retry.']
            });
        }

        const importer = createTabularDataImporter(resolvedPath, normalizedTargetTable);
        await importer.analyzeDataTypes();

        const mappings = importer.getColumnMappings();
        const createTableSql = importer.generateCreateTableSql();

        return this.deps.formatStructuredToolResponse({
            summary: `Proposed import mapping for ${mappings.length} column(s) into ${normalizedTargetTable}.`,
            data: {
                filePath: resolvedPath,
                targetTable: normalizedTargetTable,
                detectedDelimiter: importer.getCsvDelimiter(),
                detectedDecimalDelimiter: importer.getDecimalDelimiter(),
                rowCountEstimate: importer.getRowsCount(),
                mapping: mappings,
                proposedCreateTableSql: createTableSql,
                audit: {
                    operation: 'propose_import_mapping'
                }
            },
            nextActions: [
                'Review proposedCreateTableSql and mapping.',
                'Run execute_import with dryRun=true before final import.'
            ]
        });
    }

    async executeImport(
        filePath: string,
        targetTable: string,
        dryRun: boolean = true,
        timeoutSeconds?: number
    ): Promise<string> {
        const resolvedPath = filePath.trim();
        const normalizedTable = targetTable.trim();
        if (!fs.existsSync(resolvedPath)) {
            return this.deps.formatStructuredToolResponse({
                summary: 'Import execution failed.',
                errors: [`File not found: ${resolvedPath}`],
                nextActions: ['Verify file path and retry execute_import.']
            });
        }

        if (dryRun) {
            try {
                const activeSnowflake = await this.deps.getActiveConnectionDetails();
                if (activeSnowflake.connectionDetails.dbType === 'snowflake') {
                    const { createSnowflakeStagedImportResult } = await import(
                        '../../../../extensions/snowflake/src/snowflakeImportPlanner'
                    );
                    const planResult = await createSnowflakeStagedImportResult(resolvedPath, normalizedTable);

                    return this.deps.formatStructuredToolResponse({
                        summary: `Snowflake staged load plan generated for ${normalizedTable}. No database changes were made.`,
                        data: {
                            filePath: resolvedPath,
                            targetTable: normalizedTable,
                            connectionName: activeSnowflake.connectionName,
                            details: planResult.details,
                            audit: {
                                operation: 'execute_import',
                                dryRun: true,
                                timeoutSeconds: timeoutSeconds ?? null,
                                snowflakeStagedWorkflow: true
                            }
                        },
                        nextActions: planResult.details?.snowflakeWorkflow?.nextSteps ?? [
                            'Upload the file to a Snowflake stage.',
                            'Review and execute the generated CREATE TABLE and COPY INTO statements.'
                        ]
                    });
                }
            } catch {
                // Fall back to the generic offline preview if there is no active Snowflake connection context.
            }

            const importer = createTabularDataImporter(resolvedPath, normalizedTable);
            await importer.analyzeDataTypes();

            return this.deps.formatStructuredToolResponse({
                summary: `Dry-run completed for import into ${normalizedTable}. No database changes were made.`,
                data: {
                    filePath: resolvedPath,
                    targetTable: normalizedTable,
                    rowCountEstimate: importer.getRowsCount(),
                    mapping: importer.getColumnMappings(),
                    proposedCreateTableSql: importer.generateCreateTableSql(),
                    audit: {
                        operation: 'execute_import',
                        dryRun: true,
                        timeoutSeconds: timeoutSeconds ?? null
                    }
                },
                nextActions: [
                    'Review mapping and SQL.',
                    'If approved, call execute_import with dryRun=false.'
                ]
            });
        }

        const { connectionName, connectionDetails } = await this.deps.getActiveConnectionDetails();
        const importResult = await importDataForConnection(
            resolvedPath,
            normalizedTable,
            connectionDetails,
            undefined,
            timeoutSeconds
        );

        if (importResult.details?.snowflakeWorkflow) {
            return this.deps.formatStructuredToolResponse({
                summary: `Snowflake staged load plan generated for ${normalizedTable}. No database changes were made yet.`,
                data: {
                    filePath: resolvedPath,
                    targetTable: normalizedTable,
                    connectionName,
                    details: importResult.details,
                    audit: {
                        operation: 'execute_import',
                        dryRun: false,
                        timeoutSeconds: timeoutSeconds ?? null,
                        snowflakeStagedWorkflow: true
                    }
                },
                nextActions: importResult.details.snowflakeWorkflow.nextSteps ?? [
                    'Upload the file to a Snowflake stage.',
                    'Review and execute the generated CREATE TABLE and COPY INTO statements.'
                ]
            });
        }

        // Refresh schema tree after successful import
        if (importResult.success) {
            void vscode.commands.executeCommand('netezza.refreshSchema');
        }

        return this.deps.formatStructuredToolResponse({
            summary: importResult.success
                ? `Import completed into ${normalizedTable}.`
                : `Import failed for ${normalizedTable}.`,
            data: {
                filePath: resolvedPath,
                targetTable: normalizedTable,
                connectionName,
                details: importResult.details ?? {},
                audit: {
                    operation: 'execute_import',
                    dryRun: false,
                    timeoutSeconds: timeoutSeconds ?? null
                }
            },
            errors: importResult.success ? undefined : [importResult.message],
            nextActions: importResult.success
                ? ['Run validation queries (COUNT, NULL checks, key checks).']
                : ['Fix the reported issue and retry with dryRun=true first.']
        });
    }

    async exportQueryResults(
        sql?: string,
        format?: string,
        outputPath?: string,
        timeoutSeconds?: number,
        source: 'sql' | 'activeResults' = 'sql',
        sqlFilePath?: string
    ): Promise<string> {
        const normalizedFormat = this.normalizeExportFormat(format);
        const resolvedOutputPath = this.resolveExportPath(outputPath, normalizedFormat);
        const desktopSuggestion = this.getDesktopExportSuggestion(normalizedFormat);
        const startedAt = Date.now();
        let tempCsvPath: string | undefined;

        try {
            if (source === 'activeResults') {
                const { sourceUri, resultSet, resultSetIndex } = this.deps.getActiveResultSetForExport();

                if (normalizedFormat === 'csv') {
                    await exportResultSetToFile(resultSet, resolvedOutputPath, { format: 'csv' });
                } else if (normalizedFormat === 'xlsb') {
                    const exportResult = await exportStructuredToXlsb([{
                        columns: resultSet.columns,
                        rows: resultSet.data,
                        sql: resultSet.sql,
                        name: resultSet.name || 'Query Results'
                    }], resolvedOutputPath, false);
                    if (!exportResult.success) {
                        throw new Error(exportResult.message);
                    }
                } else if (normalizedFormat === 'parquet') {
                    const exportResult = await exportStructuredToParquet([{
                        columns: resultSet.columns,
                        rows: resultSet.data,
                        sql: resultSet.sql,
                        name: resultSet.name || 'Query Results'
                    }], resolvedOutputPath, false);
                    if (!exportResult.success) {
                        throw new Error(exportResult.message);
                    }
                } else {
                    const exportResult = await exportStructuredToXlsx([{
                        columns: resultSet.columns,
                        rows: resultSet.data,
                        sql: resultSet.sql,
                        name: resultSet.name || 'Query Results'
                    }], resolvedOutputPath, false);
                    if (!exportResult.success) {
                        throw new Error(exportResult.message);
                    }
                }

                const stats = fs.statSync(resolvedOutputPath);
                return this.deps.formatStructuredToolResponse({
                    summary: `Exported active Netezza Results set to ${normalizedFormat.toUpperCase()}.`,
                    data: {
                        source: 'activeResults',
                        sourceUri,
                        resultSetIndex,
                        rowCount: Array.isArray(resultSet.data) ? resultSet.data.length : 0,
                        columnCount: Array.isArray(resultSet.columns) ? resultSet.columns.length : 0,
                        outputPath: resolvedOutputPath,
                        fileSizeBytes: stats.size,
                        durationMs: Date.now() - startedAt,
                        audit: {
                            operation: 'export_query_results',
                            timeoutSeconds: timeoutSeconds ?? null,
                            source: 'activeResults'
                        }
                    },
                    nextActions: [
                        `If needed, export to another folder (suggested: ${desktopSuggestion}).`,
                        'Open the file and verify column formats.'
                    ]
                });
            }

            const sqlResolution = this.deps.resolveSqlInput(sql, sqlFilePath);
            if (!sqlResolution.sql || sqlResolution.sql.trim().length === 0) {
                const editorSqlCandidate = this.deps.getEditorSqlCandidate();
                const sqlPreview = editorSqlCandidate
                    ? editorSqlCandidate.substring(0, 240) + (editorSqlCandidate.length > 240 ? '...' : '')
                    : '';

                return this.deps.formatStructuredToolResponse({
                    summary: 'Export needs additional input before execution.',
                    data: {
                        source: 'sql',
                        format: normalizedFormat,
                        suggestedOutputFolder: desktopSuggestion,
                        suggestedSqlFromActiveEditor: sqlPreview || null,
                        suggestedSqlSource: 'current SQL selection, otherwise full active SQL document'
                    },
                    errors: ['SQL input is missing.'],
                    nextActions: [
                        `Provide outputPath (folder/file). Suggested location: ${desktopSuggestion}.`,
                        'Provide sql directly or provide sqlFilePath pointing to a SQL file.',
                        'If you skip sql, keep an active SQL editor open (selection is preferred).'
                    ]
                });
            }

            const queryToExport = sqlResolution.sql;
            const { connectionName, connectionDetails } = await this.deps.getActiveConnectionDetails();

            if (normalizedFormat === 'csv') {
                await exportToCsv(connectionDetails, queryToExport, resolvedOutputPath, undefined, timeoutSeconds);
            } else if (normalizedFormat === 'xlsb') {
                const result = await exportQueryToXlsb(
                    connectionDetails,
                    queryToExport,
                    resolvedOutputPath,
                    false,
                    undefined,
                    timeoutSeconds
                );
                if (!result.success) {
                    throw new Error(result.message);
                }
            } else if (normalizedFormat === 'parquet') {
                const result = await exportQueryToParquet(
                    connectionDetails,
                    queryToExport,
                    resolvedOutputPath,
                    false,
                    undefined,
                    timeoutSeconds
                );
                if (!result.success) {
                    throw new Error(result.message);
                }
            } else {
                tempCsvPath = path.join(os.tmpdir(), `netezza_export_${Date.now()}_${Math.floor(Math.random() * 1000)}.csv`);
                await exportToCsv(connectionDetails, queryToExport, tempCsvPath, undefined, timeoutSeconds);
                const csvContent = fs.readFileSync(tempCsvPath, 'utf8');
                const xlsxResult = await exportCsvToXlsx(
                    csvContent,
                    resolvedOutputPath,
                    false,
                    { source: 'Copilot export_query_results', sql: queryToExport }
                );
                if (!xlsxResult.success) {
                    throw new Error(xlsxResult.message);
                }
            }

            const stats = fs.statSync(resolvedOutputPath);
            const durationMs = Date.now() - startedAt;
            return this.deps.formatStructuredToolResponse({
                summary: `Export completed (${normalizedFormat.toUpperCase()}).`,
                data: {
                    source: 'sql',
                    sqlSource: sqlResolution.source,
                    sqlFilePath: sqlResolution.hint ?? null,
                    connectionName,
                    outputPath: resolvedOutputPath,
                    format: normalizedFormat,
                    fileSizeBytes: stats.size,
                    durationMs,
                    audit: {
                        operation: 'export_query_results',
                        timeoutSeconds: timeoutSeconds ?? null,
                        source: 'sql'
                    }
                },
                nextActions: [
                    'Open the exported file to verify content.',
                    `For another run you can set outputPath to Desktop: ${desktopSuggestion}.`
                ]
            });
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            return this.deps.formatStructuredToolResponse({
                summary: 'Export failed.',
                data: {
                    outputPath: resolvedOutputPath,
                    format: normalizedFormat,
                    source
                },
                errors: [errorMsg],
                nextActions: [
                    'Fix the query/path/source issue and retry export_query_results.',
                    `You can provide outputPath in Desktop folder: ${desktopSuggestion}.`
                ]
            });
        } finally {
            if (tempCsvPath && fs.existsSync(tempCsvPath)) {
                fs.unlinkSync(tempCsvPath);
            }
        }
    }

    private normalizeExportFormat(format?: string): 'csv' | 'xlsx' | 'xlsb' | 'parquet' {
        const normalized = (format || 'csv').toLowerCase();
        if (normalized === 'xlsx' || normalized === 'xlsb' || normalized === 'csv' || normalized === 'parquet') {
            return normalized;
        }
        return 'csv';
    }

    private resolveExportPath(outputPath: string | undefined, format: 'csv' | 'xlsx' | 'xlsb' | 'parquet'): string {
        const defaultName = `netezza_export_${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
        const desktopPath = path.join(os.homedir(), 'Desktop');
        if (!outputPath || outputPath.trim().length === 0) {
            return path.join(desktopPath, defaultName);
        }

        const trimmed = outputPath.trim();
        if (!path.extname(trimmed)) {
            return path.join(trimmed, defaultName);
        }
        return trimmed;
    }

    private getDesktopExportSuggestion(format: 'csv' | 'xlsx' | 'xlsb' | 'parquet'): string {
        return path.join(os.homedir(), 'Desktop', `netezza_export_*.${format}`);
    }
}
