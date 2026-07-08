/**
 * SQL Task Executor
 * Executes SQL queries against the Netezza database
 */

import { EtlNode, EtlNodeExecutionResult, SqlNodeConfig } from '../etlTypes';
import { ExecutionContext, IConnectionFactory, IVariableResolver } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';
import { NzConnection, NzDataReader, ConnectionDetails } from '../../types';
import { createConnectedDatabaseConnectionFromDetails } from '../../core/connectionFactory';

/**
 * Default connection factory using the driver
 */
class DefaultConnectionFactory implements IConnectionFactory {
    async createConnection(details: ConnectionDetails): Promise<NzConnection> {
        return await createConnectedDatabaseConnectionFromDetails(details) as NzConnection;
    }
}

/**
 * SQL query execution result data
 */
interface SqlQueryResult {
    columns: string[];
    rows: unknown[][];
}

/**
 * SQL Task Executor
 * Executes SQL queries and returns results
 */
export class SqlTaskExecutor extends BaseTaskExecutor<SqlNodeConfig> {
    private connectionFactory: IConnectionFactory;

    constructor(
        variableResolver?: IVariableResolver,
        connectionFactory?: IConnectionFactory
    ) {
        super(variableResolver);
        this.connectionFactory = connectionFactory || new DefaultConnectionFactory();
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Validate query
        const queryError = this.validateRequired(node.id, startTime, config.query?.trim(), 'SQL query');
        if (queryError) {
            return queryError;
        }

        return this.safeExecute(node.id, startTime, async () => {
            // Resolve variables in the query
            const query = this.resolveVariables(config.query, context);

            this.reportProgress(context, `Executing SQL: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`);

            // Validate connection details
            if (!context.connectionDetails) {
                return this.createError(node.id, startTime, 'No connection details available in context');
            }

            let connection: NzConnection | null = null;
            try {
                // Create connection using factory
                connection = await this.connectionFactory.createConnection(context.connectionDetails);

                // Execute the query
                const result = await this.executeQuery(connection, query, config.timeout);

                return this.createSuccess(node.id, startTime, {
                    rowsAffected: result.rows.length,
                    output: result
                });
            } finally {
                // Always close connection
                if (connection) {
                    try {
                        await connection.close();
                    } catch {
                        // Ignore close errors
                    }
                }
            }
        });
    }

    /**
     * Execute query and collect results
     */
    private async executeQuery(
        connection: NzConnection,
        query: string,
        timeout?: number
    ): Promise<SqlQueryResult> {
        const cmd = connection.createCommand(query);

        if (timeout) {
            cmd.commandTimeout = timeout;
        }

        const reader: NzDataReader = await cmd.executeReader();

        // Collect column names
        const columns: string[] = [];
        for (let i = 0; i < reader.fieldCount; i++) {
            columns.push(reader.getName(i));
        }

        // Collect rows
        const rows: unknown[][] = [];
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                row.push(reader.getValue(i));
            }
            rows.push(row);
        }

        // Close reader
        if (reader.close) {
            await reader.close();
        }

        return { columns, rows };
    }
}
