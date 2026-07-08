/**
 * Export Task Executor
 * Exports query results to CSV or XLSB files
 */

import * as vscode from 'vscode';
import { EtlNode, EtlNodeExecutionResult, ExportNodeConfig } from '../etlTypes';
import { ExecutionContext, IExportStrategy, IVariableResolver } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';
import { exportToCsv } from '../../export/csvExporter';
import { exportQueryToXlsb } from '../../export/xlsbExporter';
import { exportQueryToParquet } from '../../export/parquetExporter';
import { ConnectionDetails } from '../../types';

/**
 * CSV export strategy implementation
 */
class CsvExportStrategy implements IExportStrategy {
    readonly format = 'csv' as const;

    async export(
        _context: vscode.ExtensionContext,
        connectionDetails: ConnectionDetails,
        query: string,
        outputPath: string,
        _onProgress?: (message: string) => void,
        timeout?: number
    ): Promise<{ success: boolean; message?: string; rowsExported?: number }> {
        try {
            await exportToCsv(
                connectionDetails,
                query,
                outputPath,
                undefined, // progress object not available here
                timeout
            );
            return { success: true };
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

/**
 * XLSB export strategy implementation
 */
class XlsbExportStrategy implements IExportStrategy {


    readonly format = 'xlsb' as const;

    async export(
        _context: vscode.ExtensionContext,
        connectionDetails: ConnectionDetails,
        query: string,
        outputPath: string,
        onProgress?: (message: string) => void,
        timeout?: number
    ): Promise<{ success: boolean; message?: string; rowsExported?: number }> {
        const result = await exportQueryToXlsb(
            connectionDetails,
            query,
            outputPath,
            false, // copyToClipboard
            onProgress,
            timeout
        );

        return {
            success: result.success,
            message: result.message,
            rowsExported: result.details?.rows_exported
        };
    }
}

/**
 * Parquet export strategy implementation
 */
class ParquetExportStrategy implements IExportStrategy {
    readonly format = 'parquet' as const;

    async export(
        _context: vscode.ExtensionContext,
        connectionDetails: ConnectionDetails,
        query: string,
        outputPath: string,
        onProgress?: (message: string) => void,
        timeout?: number
    ): Promise<{ success: boolean; message?: string; rowsExported?: number }> {
        const result = await exportQueryToParquet(
            connectionDetails,
            query,
            outputPath,
            false,
            onProgress,
            timeout
        );

        return {
            success: result.success,
            message: result.message,
            rowsExported: result.details?.rows_exported
        };
    }
}

/**
 * Export Task Executor
 * Exports data to CSV, XLSB, or Parquet files using strategy pattern
 */
export class ExportTaskExecutor extends BaseTaskExecutor<ExportNodeConfig> {
    private strategies: Map<string, IExportStrategy>;

    constructor(
        variableResolver?: IVariableResolver,
        strategies?: Map<string, IExportStrategy>
    ) {
        super(variableResolver);
        this.strategies = strategies || new Map<string, IExportStrategy>([
            ['csv', new CsvExportStrategy()],
            ['xlsb', new XlsbExportStrategy()],
            ['parquet', new ParquetExportStrategy()]
        ]);
    }

    /**
     * Register a custom export strategy
     */
    registerStrategy(strategy: IExportStrategy): void {
        this.strategies.set(strategy.format, strategy);
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Validate output path
        const pathError = this.validateRequired(node.id, startTime, config.outputPath, 'Output path');
        if (pathError) return pathError;

        return this.safeExecute(node.id, startTime, async () => {
            // Resolve variables in paths and query
            const outputPath = this.resolveVariables(config.outputPath, context);
            const query = config.query ? this.resolveVariables(config.query, context) : '';

            // If no query, try to get from previous node
            if (!query && config.sourceNodeId) {
                const prevOutput = context.nodeOutputs.get(config.sourceNodeId) as {
                    columns?: string[];
                    rows?: unknown[][];
                } | undefined;

                if (prevOutput?.rows) {
                    return this.createError(
                        node.id,
                        startTime,
                        'In-memory data export is not yet supported. Please specify a query.'
                    );
                }
            }

            if (!query) {
                return this.createError(
                    node.id,
                    startTime,
                    'No query or source node specified for export'
                );
            }

            // Get export strategy
            const strategy = this.strategies.get(config.format);
            if (!strategy) {
                return this.createError(
                    node.id,
                    startTime,
                    `Unsupported export format: ${config.format}`
                );
            }

            this.reportProgress(context, `Exporting to ${config.format.toUpperCase()}: ${outputPath}`);

            // Execute export
            const result = await strategy.export(
                context.extensionContext,
                context.connectionDetails,
                query,
                outputPath,
                (message) => this.reportProgress(context, `[Export] ${message}`),
                config.timeout
            );

            if (result.success) {
                return this.createSuccess(node.id, startTime, {
                    rowsAffected: result.rowsExported,
                    output: {
                        filePath: outputPath,
                        format: config.format,
                        rowsExported: result.rowsExported
                    }
                });
            } else {
                return this.createError(node.id, startTime, result.message || 'Export failed');
            }
        });
    }
}
