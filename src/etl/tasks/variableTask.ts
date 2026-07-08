/**
 * Variable Task Executor
 * Handles variable assignment with 3 modes: prompt, static, sql
 */

import { EtlNode, EtlNodeExecutionResult, VariableNodeConfig } from '../etlTypes';
import { ExecutionContext, IVariableResolver, IConnectionFactory } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';
import { IVariableManager } from '../utils/variableManager';
import { ConnectionDetails, NzConnection, NzDataReader } from '../../types';
import { createConnectedDatabaseConnectionFromDetails } from '../../core/connectionFactory';

/**
 * Default connection factory for SQL variables
 */
class DefaultConnectionFactory implements IConnectionFactory {
    async createConnection(details: ConnectionDetails): Promise<NzConnection> {
        return await createConnectedDatabaseConnectionFromDetails(details) as NzConnection;
    }
}

/**
 * Variable Task Executor
 * Sets variable values using one of three methods:
 * - prompt: Ask user for value
 * - static: Use predefined value
 * - sql: Execute query and use first column of first row
 */
export class VariableTaskExecutor extends BaseTaskExecutor<VariableNodeConfig> {
    private connectionFactory: IConnectionFactory;
    private variableManager: IVariableManager | null = null;

    constructor(
        variableResolver?: IVariableResolver,
        connectionFactory?: IConnectionFactory
    ) {
        super(variableResolver);
        this.connectionFactory = connectionFactory || new DefaultConnectionFactory();
    }

    /**
     * Set the variable manager (called by engine before execution)
     */
    setVariableManager(manager: IVariableManager): void {
        this.variableManager = manager;
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Validate required fields
        const nameError = this.validateRequired(node.id, startTime, config.variableName, 'Variable name');
        if (nameError) return nameError;

        // Get variable manager from context or instance
        const manager = (context as ExecutionContextWithManager).variableManager || this.variableManager;
        if (!manager) {
            return this.createError(node.id, startTime, 'Variable manager not available');
        }

        return this.safeExecute(node.id, startTime, async () => {
            let value: string | undefined;

            switch (config.source) {
                case 'prompt':
                    value = await this.handlePrompt(config, manager, context);
                    break;

                case 'static':
                    value = this.handleStatic(config, context);
                    break;

                case 'sql':
                    value = await this.handleSql(config, context);
                    break;

                default:
                    return this.createError(node.id, startTime, `Unknown variable source: ${config.source}`);
            }

            // Check if value was obtained
            if (value === undefined) {
                return this.createError(node.id, startTime, `Variable ${config.variableName} was not set (user cancelled or query returned no results)`);
            }

            // Set the variable
            manager.set(config.variableName, value);

            // Also update context.variables for backward compatibility
            context.variables[config.variableName] = value;

            this.reportProgress(context, `Variable ${config.variableName} = "${value}"`);

            return this.createSuccess(node.id, startTime, {
                output: {
                    variableName: config.variableName,
                    value: value,
                    source: config.source
                }
            });
        });
    }

    /**
     * Handle prompt source - ask user for value
     */
    private async handlePrompt(
        config: VariableNodeConfig,
        manager: IVariableManager,
        context: ExecutionContext
    ): Promise<string | undefined> {
        // Resolve variables in message and default value
        const message = config.promptMessage
            ? this.resolveVariables(config.promptMessage, context)
            : `Enter value for ${config.variableName}`;

        const defaultValue = config.defaultValue
            ? this.resolveVariables(config.defaultValue, context)
            : undefined;

        this.reportProgress(context, `Prompting for variable: ${config.variableName}`);

        return manager.promptForValue(config.variableName, message, defaultValue);
    }

    /**
     * Handle static source - use predefined value
     */
    private handleStatic(
        config: VariableNodeConfig,
        context: ExecutionContext
    ): string {
        // Resolve variables in the static value
        const value = config.value || '';
        return this.resolveVariables(value, context);
    }

    /**
     * Handle SQL source - execute query and get scalar result
     */
    private async handleSql(
        config: VariableNodeConfig,
        context: ExecutionContext
    ): Promise<string | undefined> {
        if (!config.query) {
            throw new Error('SQL query is required for sql variable source');
        }

        // Resolve variables in query
        const query = this.resolveVariables(config.query, context);

        this.reportProgress(context, `Executing SQL for variable ${config.variableName}`);

        let connection: NzConnection | null = null;
        try {
            connection = await this.connectionFactory.createConnection(context.connectionDetails);

            const cmd = connection.createCommand(query);
            if (config.timeout) {
                cmd.commandTimeout = config.timeout;
            }

            const reader: NzDataReader = await cmd.executeReader();

            // Get first value from first row
            let value: string | undefined;
            if (await reader.read()) {
                const rawValue = reader.getValue(0);
                value = rawValue !== null && rawValue !== undefined
                    ? String(rawValue)
                    : undefined;
            }

            if (reader.close) {
                await reader.close();
            }

            return value;
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch {
                    // Ignore close errors
                }
            }
        }
    }
}

/**
 * Extended execution context with variable manager
 */
interface ExecutionContextWithManager extends ExecutionContext {
    variableManager?: IVariableManager;
}
