/**
 * Container Task Executor
 * Executes a group of nested tasks as a single unit
 */

import { EtlNode, EtlNodeExecutionResult, ContainerNodeConfig, EtlProject } from '../etlTypes';
import { ExecutionContext, IExecutionEngine, IVariableResolver } from '../interfaces';
import { BaseTaskExecutor } from './baseTaskExecutor';

/**
 * Container execution output
 */
interface ContainerOutput {
    tasksExecuted: number;
    tasksSucceeded: number;
    nestedResults: [string, EtlNodeExecutionResult][];
}

/**
 * Container Task Executor
 * Delegates nested task execution to the provided engine
 */
export class ContainerTaskExecutor extends BaseTaskExecutor<ContainerNodeConfig> {
    private engine: IExecutionEngine;

    constructor(
        engine: IExecutionEngine,
        variableResolver?: IVariableResolver
    ) {
        super(variableResolver);
        this.engine = engine;
    }

    async execute(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        const config = this.getConfig(node);
        const startTime = new Date();

        // Empty container is a no-op success
        if (!config.nodes || config.nodes.length === 0) {
            return this.createSuccess(node.id, startTime, {
                output: 'Empty container - nothing to execute'
            });
        }

        return this.safeExecute(node.id, startTime, async () => {
            this.reportProgress(context, `Entering container: ${node.name} (${config.nodes.length} tasks)`);

            // Create a mini-project from the container's nodes
            const containerProject: EtlProject = {
                name: `Container: ${node.name}`,
                version: '1.0.0',
                nodes: config.nodes,
                connections: config.connections || []
            };

            // Execute the container's tasks using the engine
            const result = await this.engine.execute(containerProject, context);

            this.reportProgress(context, `Exiting container: ${node.name}`);

            // Process results based on execution status
            return this.processExecutionResult(node.id, startTime, config, result);
        });
    }

    /**
     * Process nested execution result and create container result
     */
    private processExecutionResult(
        nodeId: string,
        startTime: Date,
        config: ContainerNodeConfig,
        result: import('../etlTypes').EtlExecutionResult
    ): EtlNodeExecutionResult {
        if (result.status === 'completed') {
            const { successCount, totalRows } = this.countSuccesses(result);

            const output: ContainerOutput = {
                tasksExecuted: config.nodes.length,
                tasksSucceeded: successCount,
                nestedResults: Array.from(result.nodeResults.entries())
            };

            return this.createSuccess(nodeId, startTime, {
                rowsAffected: totalRows,
                output
            });
        }

        if (result.status === 'cancelled') {
            return this.resultBuilder(nodeId)
                .skipped()
                .build();
        }

        // Failed - find first error
        const errorMessage = this.findFirstError(result) || 'Container execution failed';
        return this.createError(nodeId, startTime, errorMessage);
    }

    /**
     * Count successful tasks and total rows
     */
    private countSuccesses(result: import('../etlTypes').EtlExecutionResult): {
        successCount: number;
        totalRows: number;
    } {
        let successCount = 0;
        let totalRows = 0;

        for (const nodeResult of result.nodeResults.values()) {
            if (nodeResult.status === 'success') {
                successCount++;
                if (nodeResult.rowsAffected) {
                    totalRows += nodeResult.rowsAffected;
                }
            }
        }

        return { successCount, totalRows };
    }

    /**
     * Find the first error message in results
     */
    private findFirstError(result: import('../etlTypes').EtlExecutionResult): string | undefined {
        for (const nodeResult of result.nodeResults.values()) {
            if (nodeResult.status === 'error' && nodeResult.error) {
                return nodeResult.error;
            }
        }
        return undefined;
    }
}
