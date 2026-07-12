/**
 * ETL Execution Engine
 * Handles executing ETL projects with proper dependency resolution
 * and parallel/sequential execution based on connections
 */


import {
    EtlProject,
    EtlNode,
    EtlExecutionResult,
    EtlNodeExecutionResult,
    EtlNodeStatus
} from './etlTypes';
import { ExecutionContext, ITaskExecutor, IExecutionEngine } from './interfaces';
import { createSkippedResult } from './utils/resultFactory';

/**
 * Re-export ExecutionContext for backward compatibility
 */
export type { ExecutionContext } from './interfaces';
export type { ITaskExecutor as TaskExecutor } from './interfaces';

/**
 * ETL Execution Engine
 * Orchestrates the execution of ETL projects
 */
export class EtlExecutionEngine implements IExecutionEngine {
    private statusCallback?: (nodeId: string, status: EtlNodeStatus, message?: string) => void;
    private executors: Map<string, ITaskExecutor> = new Map();

    /**
     * Register a task executor for a node type
     */
    registerExecutor(nodeType: string, executor: ITaskExecutor): void {
        this.executors.set(nodeType, executor);
    }

    /**
     * Get registered executor for a node type
     */
    getExecutor(nodeType: string): ITaskExecutor | undefined {
        return this.executors.get(nodeType);
    }

    /**
     * Set callback for status updates
     */
    onStatusChange(callback: (nodeId: string, status: EtlNodeStatus, message?: string) => void): void {
        this.statusCallback = callback;
    }

    /**
     * Execute an ETL project
     */
    async execute(
        project: EtlProject,
        context: ExecutionContext
    ): Promise<EtlExecutionResult> {
        const result: EtlExecutionResult = {
            projectName: project.name,
            startTime: new Date(),
            status: 'running',
            nodeResults: new Map()
        };

        // Initialize all nodes as pending
        for (const node of project.nodes) {
            this.statusCallback?.(node.id, 'pending');
        }

        try {
            context.onProgress?.(`Starting ETL project: ${project.name}`);
            context.onProgress?.(`Found ${project.nodes.length} tasks`);

            // Use dynamic execution based on connection types
            await this.executeDynamic(project, context, result);

            // Determine final status
            const hasErrors = Array.from(result.nodeResults.values()).some(r => r.status === 'error');
            result.status = hasErrors ? 'failed' : 'completed';
            result.endTime = new Date();

            const statusMsg = result.status === 'completed' ? 'completed successfully' : 'completed with errors';
            context.onProgress?.(`ETL project ${statusMsg}`);

        } catch (error) {
            result.status = 'failed';
            result.endTime = new Date();
            context.onProgress?.(`ETL project failed: ${String(error)}`);
        }

        return result;
    }

    /**
     * Execute nodes dynamically based on connection types and results
     */
    private async executeDynamic(
        project: EtlProject,
        context: ExecutionContext,
        result: EtlExecutionResult
    ): Promise<void> {
        const executed = new Set<string>();
        const toExecute: string[] = [];

        // Find nodes with no incoming connections (start nodes)
        const hasIncoming = new Set(project.connections.map(c => c.to));
        for (const node of project.nodes) {
            if (!hasIncoming.has(node.id)) {
                toExecute.push(node.id);
            }
        }

        // Execute nodes in order, following connections based on results
        while (toExecute.length > 0) {
            // Check for cancellation
            if (context.cancellationToken?.isCancellationRequested) {
                result.status = 'cancelled';
                result.endTime = new Date();

                // Mark remaining as skipped
                for (const node of project.nodes) {
                    if (!executed.has(node.id)) {
                        result.nodeResults.set(node.id, createSkippedResult(node.id));
                        this.statusCallback?.(node.id, 'skipped');
                    }
                }
                return;
            }

            const nodeId = toExecute.shift()!;

            // Skip if already executed
            if (executed.has(nodeId)) {
                continue;
            }

            const node = project.nodes.find(n => n.id === nodeId);
            if (!node) {
                continue;
            }

            // Execute the node
            const nodeResult = await this.executeNode(node, context);
            result.nodeResults.set(nodeId, nodeResult);
            executed.add(nodeId);

            // Store output for downstream nodes
            if (nodeResult.output !== undefined) {
                context.nodeOutputs.set(nodeId, nodeResult.output);
            }

            // Find outgoing connections
            const outgoingConnections = project.connections.filter(c => c.from === nodeId);

            // Determine which connections to follow based on result
            for (const conn of outgoingConnections) {
                const connType = conn.connectionType || 'success';
                const shouldFollow =
                    (nodeResult.status === 'success' && connType === 'success') ||
                    (nodeResult.status === 'error' && connType === 'failure');

                if (shouldFollow) {
                    // Add to execution queue if not already there
                    if (!executed.has(conn.to) && !toExecute.includes(conn.to)) {
                        toExecute.push(conn.to);
                    }
                } else {
                    // Mark skipped nodes connected via wrong connection type
                    if (!executed.has(conn.to)) {
                        // Check if this node should still be executed via other paths
                        const hasOtherValidPaths = project.connections.some(c => {
                            if (c.to !== conn.to || c.id === conn.id) return false;
                            const sourceResult = result.nodeResults.get(c.from);
                            if (!sourceResult) return true; // Not yet executed
                            const cType = c.connectionType || 'success';
                            return (sourceResult.status === 'success' && cType === 'success') ||
                                (sourceResult.status === 'error' && cType === 'failure');
                        });

                        if (!hasOtherValidPaths && !toExecute.includes(conn.to)) {
                            result.nodeResults.set(conn.to, createSkippedResult(conn.to));
                            this.statusCallback?.(conn.to, 'skipped');
                            executed.add(conn.to);
                        }
                    }
                }
            }
        }

        // Mark any remaining nodes as skipped (disconnected nodes or unreachable)
        for (const node of project.nodes) {
            if (!executed.has(node.id)) {
                result.nodeResults.set(node.id, createSkippedResult(node.id));
                this.statusCallback?.(node.id, 'skipped');
            }
        }
    }

    /**
     * Execute a single node
     */
    private async executeNode(
        node: EtlNode,
        context: ExecutionContext
    ): Promise<EtlNodeExecutionResult> {
        this.statusCallback?.(node.id, 'running');
        context.onProgress?.(`Running task: ${node.name}`);

        const executor = this.executors.get(node.type);
        if (!executor) {
            const result: EtlNodeExecutionResult = {
                nodeId: node.id,
                status: 'error',
                startTime: new Date(),
                endTime: new Date(),
                error: `No executor registered for node type: ${node.type}`
            };
            this.statusCallback?.(node.id, 'error', result.error);
            return result;
        }

        try {
            const result = await executor.execute(node, context);
            this.statusCallback?.(node.id, result.status, result.error);

            if (result.status === 'success') {
                context.onProgress?.(`Task ${node.name} completed successfully`);
                if (result.rowsAffected !== undefined) {
                    context.onProgress?.(`  Rows affected: ${result.rowsAffected}`);
                }
            }

            return result;
        } catch (error) {
            const result: EtlNodeExecutionResult = {
                nodeId: node.id,
                status: 'error',
                startTime: new Date(),
                endTime: new Date(),
                error: String(error)
            };
            this.statusCallback?.(node.id, 'error', result.error);
            return result;
        }
    }

    /**
     * Get previous node output (for nodes that depend on results)
     */
    getPreviousNodeOutput(context: ExecutionContext, nodeId: string): unknown {
        return context.nodeOutputs.get(nodeId);
    }
}
