/**
 * Base Task Executor
 * Abstract base class with common functionality for all task executors
 */

import { EtlNode, EtlNodeExecutionResult, EtlNodeConfig } from '../etlTypes';
import { ExecutionContext, ITaskExecutor, IVariableResolver } from '../interfaces';
import { VariableResolver } from '../utils/variableResolver';
import { createSuccessResult, createErrorResult, ResultBuilder } from '../utils/resultFactory';

/**
 * Abstract base class for task executors
 * Provides common functionality like variable resolution and result creation
 */
export abstract class BaseTaskExecutor<TConfig extends EtlNodeConfig> implements ITaskExecutor {
    protected variableResolver: IVariableResolver;

    constructor(variableResolver?: IVariableResolver) {
        this.variableResolver = variableResolver || new VariableResolver();
    }

    /**
     * Execute the task - must be implemented by subclasses
     */
    abstract execute(node: EtlNode, context: ExecutionContext): Promise<EtlNodeExecutionResult>;

    /**
     * Get typed configuration from node
     */
    protected getConfig(node: EtlNode): TConfig {
        return node.config as TConfig;
    }

    /**
     * Resolve variables in a string using context variables
     */
    protected resolveVariables(template: string, context: ExecutionContext): string {
        return this.variableResolver.resolve(template, context.variables);
    }

    /**
     * Create a success result
     */
    protected createSuccess(
        nodeId: string,
        startTime: Date,
        options?: { output?: unknown; rowsAffected?: number }
    ): EtlNodeExecutionResult {
        return createSuccessResult(nodeId, startTime, options);
    }

    /**
     * Create an error result
     */
    protected createError(
        nodeId: string,
        startTime: Date,
        error: string | Error
    ): EtlNodeExecutionResult {
        return createErrorResult(nodeId, startTime, error);
    }

    /**
     * Create a result builder for fluent result creation
     */
    protected resultBuilder(nodeId: string): ResultBuilder {
        return new ResultBuilder(nodeId);
    }

    /**
     * Report progress if callback is available
     */
    protected reportProgress(context: ExecutionContext, message: string): void {
        context.onProgress?.(message);
    }

    /**
     * Check if execution has been cancelled
     */
    protected isCancelled(context: ExecutionContext): boolean {
        return context.cancellationToken?.isCancellationRequested ?? false;
    }

    /**
     * Validate that a required field is present
     * @returns Error result if validation fails, undefined if valid
     */
    protected validateRequired(
        nodeId: string,
        startTime: Date,
        value: unknown,
        fieldName: string
    ): EtlNodeExecutionResult | undefined {
        if (value === undefined || value === null || value === '') {
            return this.createError(nodeId, startTime, `${fieldName} is required`);
        }
        return undefined;
    }

    /**
     * Wrap async execution with error handling
     * Catches any errors and returns proper error result
     */
    protected async safeExecute(
        nodeId: string,
        startTime: Date,
        fn: () => Promise<EtlNodeExecutionResult>
    ): Promise<EtlNodeExecutionResult> {
        try {
            return await fn();
        } catch (error) {
            return this.createError(nodeId, startTime, error instanceof Error ? error : String(error));
        }
    }
}
