/**
 * ETL Interfaces
 * Core interfaces for dependency injection and testability
 */

import * as vscode from 'vscode';
import { EtlNode, EtlNodeExecutionResult, EtlProject, EtlConnection } from './etlTypes';
import { ConnectionDetails } from '../types';

/**
 * Execution context passed to task executors
 * Contains all dependencies needed for task execution
 */
export interface ExecutionContext {
    /** VS Code extension context for accessing storage, paths, etc. */
    extensionContext: vscode.ExtensionContext;
    /** Project-level variables for template substitution */
    variables: Record<string, string>;
    /** Map of node outputs for passing data between nodes */
    nodeOutputs: Map<string, unknown>;
    /** Database connection details */
    connectionDetails: ConnectionDetails;
    /** Optional cancellation token for stopping execution */
    cancellationToken?: vscode.CancellationToken;
    /** Progress reporting callback */
    onProgress?: (message: string) => void;
    /** Variable manager for mutable variable storage (optional for backward compat) */
    variableManager?: import('./utils/variableManager').IVariableManager;
}

/**
 * Interface for task executors
 * Each node type should have a corresponding executor implementation
 */
export interface ITaskExecutor {
    /**
     * Execute a node and return the result
     * @param node The ETL node to execute
     * @param context Execution context with dependencies
     */
    execute(node: EtlNode, context: ExecutionContext): Promise<EtlNodeExecutionResult>;
}

/**
 * Interface for variable resolution in templates
 * Allows substituting ${variable} patterns in strings
 */
export interface IVariableResolver {
    /**
     * Resolve all variable references in a template string
     * @param template String containing ${variable} patterns
     * @param variables Map of variable names to values
     * @returns String with all variables substituted
     */
    resolve(template: string, variables: Record<string, string>): string;
}

/**
 * Interface for project management operations
 * Abstraction over EtlProjectManager for testability
 */
export interface IProjectManager {
    /** Create a new empty project */
    createProject(name: string): EtlProject;

    /** Load project from file path */
    loadProject(filePath: string): Promise<EtlProject>;

    /** Save current project to file */
    saveProject(filePath?: string): Promise<void>;

    /** Validate project structure and return errors */
    validateProject(project: EtlProject): string[];

    /** Get the current project or null */
    getCurrentProject(): EtlProject | null;

    /** Check if project has unsaved changes */
    hasUnsavedChanges(): boolean;

    /** Add a node to the current project */
    addNode(node: EtlNode): void;

    /** Update an existing node */
    updateNode(nodeId: string, updates: Partial<EtlNode>): void;

    /** Remove a node and its connections */
    removeNode(nodeId: string): void;

    /** Add a connection between nodes */
    addConnection(connection: EtlConnection): void;

    /** Remove a connection */
    removeConnection(connectionId: string): void;

    /** Get node by ID */
    getNode(nodeId: string): EtlNode | undefined;
}

/**
 * Interface for execution engine
 * Allows mocking the engine in tests
 */
export interface IExecutionEngine {
    /** Register an executor for a node type */
    registerExecutor(nodeType: string, executor: ITaskExecutor): void;

    /** Execute an ETL project */
    execute(project: EtlProject, context: ExecutionContext): Promise<import('./etlTypes').EtlExecutionResult>;
}

/**
 * Interface for Python process runner
 * Abstraction for testing PythonTaskExecutor
 */
export interface IPythonRunner {
    /**
     * Run a Python script and return the result
     * @param interpreter Path to Python interpreter
     * @param args Command line arguments
     * @param env Environment variables
     * @param timeout Optional timeout in seconds
     */
    run(
        interpreter: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        timeout?: number
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Interface for connection factory
 * Abstraction for creating database connections
 */
export interface IConnectionFactory {
    /**
     * Create a new database connection
     * @param details Connection details
     */
    createConnection(details: ConnectionDetails): Promise<import('../types').NzConnection>;
}

/**
 * Interface for data importer
 * Abstraction for ImportTaskExecutor
 */
export interface IDataImporter {
    /**
     * Import data from file to database table
     * @param filePath Path to source file
     * @param targetTable Target table name
     * @param connectionDetails Database connection
     * @param progressCallback Optional progress reporting
     * @param timeout Optional timeout in seconds
     */
    importData(
        filePath: string,
        targetTable: string,
        connectionDetails: ConnectionDetails,
        progressCallback?: (message: string, increment?: number) => void,
        timeout?: number
    ): Promise<import('../import/dataImporter').ImportResult>;
}

/**
 * Export format strategy interface
 * Used for CSV and XLSB export implementations
 */
export interface IExportStrategy {
    /** Export format identifier */
    readonly format: 'csv' | 'xlsb' | 'parquet';

    /**
     * Export data to file
     * @param context Extension context
     * @param connectionDetails Database connection
     * @param query SQL query to execute
     * @param outputPath Output file path
     * @param onProgress Progress callback
     * @param timeout Optional timeout
     */
    export(
        context: vscode.ExtensionContext,
        connectionDetails: ConnectionDetails,
        query: string,
        outputPath: string,
        onProgress?: (message: string) => void,
        timeout?: number
    ): Promise<{ success: boolean; message?: string; rowsExported?: number }>;
}
