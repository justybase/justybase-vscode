/**
 * Import Task Executor
 * Imports data from CSV or XLSB files into the database
 */

import * as fs from 'fs';
import { EtlNode, EtlNodeExecutionResult, ImportNodeConfig } from '../etlTypes';
import { ExecutionContext, IDataImporter, IVariableResolver } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';
import { ImportResult } from '../../import/dataImporter';
import { importDataForConnection } from '../../import/importDispatcher';
import { ConnectionDetails } from '../../types';

/**
 * Default data importer implementation
 */
class DefaultDataImporter implements IDataImporter {
    async importData(
        filePath: string,
        targetTable: string,
        connectionDetails: ConnectionDetails,
        progressCallback?: (message: string, increment?: number) => void,
        timeout?: number
    ): Promise<ImportResult> {
        return importDataForConnection(
            filePath,
            targetTable,
            connectionDetails,
            progressCallback,
            timeout
        );
    }
}

/**
 * Import Task Executor
 * Imports data from files into database tables
 */
export class ImportTaskExecutor extends BaseTaskExecutor<ImportNodeConfig> {
    private importer: IDataImporter;

    constructor(
        variableResolver?: IVariableResolver,
        importer?: IDataImporter
    ) {
        super(variableResolver);
        this.importer = importer || new DefaultDataImporter();
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Validate required fields
        const inputError = this.validateRequired(node.id, startTime, config.inputPath, 'Input path');
        if (inputError) return inputError;

        const tableError = this.validateRequired(node.id, startTime, config.targetTable, 'Target table');
        if (tableError) return tableError;

        return this.safeExecute(node.id, startTime, async () => {
            // Resolve variables in paths
            const inputPath = this.resolveVariables(config.inputPath, context);
            const targetTable = this.resolveVariables(config.targetTable, context);
            const targetSchema = config.targetSchema
                ? this.resolveVariables(config.targetSchema, context)
                : '';

            // Check if file exists
            if (!fs.existsSync(inputPath)) {
                return this.createError(node.id, startTime, `Input file not found: ${inputPath}`);
            }

            this.reportProgress(context, `Importing from ${config.format.toUpperCase()}: ${inputPath}`);
            this.reportProgress(context, `Target table: ${targetSchema ? targetSchema + '.' : ''}${targetTable}`);

            // Execute import
            const result = await this.importer.importData(
                inputPath,
                targetTable,
                context.connectionDetails,
                (message) => {
                    this.reportProgress(context, `[Import] ${message}`);
                },
                config.timeout
            );

            if (result.success) {
                return this.createSuccess(node.id, startTime, {
                    rowsAffected: result.details?.rowsInserted,
                    output: {
                        filePath: inputPath,
                        targetTable: `${targetSchema ? targetSchema + '.' : ''}${targetTable}`,
                        rowsProcessed: result.details?.rowsProcessed,
                        rowsInserted: result.details?.rowsInserted
                    }
                });
            } else {
                return this.createError(node.id, startTime, result.message);
            }
        });
    }
}
