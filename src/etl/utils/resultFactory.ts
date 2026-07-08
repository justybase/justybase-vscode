/**
 * Result Factory
 * Consistent creation of EtlNodeExecutionResult objects
 */

import { EtlNodeExecutionResult, EtlNodeStatus } from '../etlTypes';

/**
 * Options for creating a success result
 */
export interface SuccessResultOptions {
    output?: unknown;
    rowsAffected?: number;
}

/**
 * Create a success result for a node execution
 * @param nodeId ID of the executed node
 * @param startTime When execution started
 * @param options Optional success details
 */
export function createSuccessResult(
    nodeId: string,
    startTime: Date,
    options?: SuccessResultOptions
): EtlNodeExecutionResult {
    return {
        nodeId,
        status: 'success',
        startTime,
        endTime: new Date(),
        output: options?.output,
        rowsAffected: options?.rowsAffected
    };
}

/**
 * Create an error result for a node execution
 * @param nodeId ID of the executed node
 * @param startTime When execution started
 * @param error Error message or Error object
 */
export function createErrorResult(
    nodeId: string,
    startTime: Date,
    error: string | Error
): EtlNodeExecutionResult {
    return {
        nodeId,
        status: 'error',
        startTime,
        endTime: new Date(),
        error: error instanceof Error ? error.message : error
    };
}

/**
 * Create a skipped result for a node that was not executed
 * @param nodeId ID of the skipped node
 */
export function createSkippedResult(nodeId: string): EtlNodeExecutionResult {
    const now = new Date();
    return {
        nodeId,
        status: 'skipped',
        startTime: now,
        endTime: now
    };
}

/**
 * Create a result with custom status
 * @param nodeId ID of the node
 * @param startTime When execution started
 * @param status Execution status
 * @param options Additional options
 */
export function createResult(
    nodeId: string,
    startTime: Date,
    status: EtlNodeStatus,
    options?: {
        error?: string;
        output?: unknown;
        rowsAffected?: number;
    }
): EtlNodeExecutionResult {
    return {
        nodeId,
        status,
        startTime,
        endTime: new Date(),
        error: options?.error,
        output: options?.output,
        rowsAffected: options?.rowsAffected
    };
}

/**
 * Helper class for building results fluently
 */
export class ResultBuilder {
    private result: Partial<EtlNodeExecutionResult>;
    private startTime: Date;

    constructor(nodeId: string) {
        this.startTime = new Date();
        this.result = {
            nodeId,
            startTime: this.startTime
        };
    }

    /** Mark as success */
    success(): this {
        this.result.status = 'success';
        return this;
    }

    /** Mark as error with message */
    error(message: string | Error): this {
        this.result.status = 'error';
        this.result.error = message instanceof Error ? message.message : message;
        return this;
    }

    /** Mark as skipped */
    skipped(): this {
        this.result.status = 'skipped';
        return this;
    }

    /** Set output data */
    withOutput(output: unknown): this {
        this.result.output = output;
        return this;
    }

    /** Set rows affected count */
    withRowsAffected(count: number): this {
        this.result.rowsAffected = count;
        return this;
    }

    /** Build the final result */
    build(): EtlNodeExecutionResult {
        return {
            nodeId: this.result.nodeId!,
            status: this.result.status || 'pending',
            startTime: this.startTime,
            endTime: new Date(),
            error: this.result.error,
            output: this.result.output,
            rowsAffected: this.result.rowsAffected
        };
    }
}

/**
 * Create a new result builder
 * @param nodeId ID of the node
 */
export function resultBuilder(nodeId: string): ResultBuilder {
    return new ResultBuilder(nodeId);
}
