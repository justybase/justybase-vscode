/**
 * ETL Project Manager
 * Handles loading, saving, and validating ETL projects
 */

import * as fs from 'fs';
import {
    EtlProject,
    EtlNode,
    EtlConnection,
    generateNodeId,
    generateConnectionId
} from './etlTypes';
import { IProjectManager } from './interfaces';
import { ProjectValidator, ValidationResult } from './utils/projectValidator';

/**
 * ETL Project Manager
 * Manages the lifecycle of ETL projects with singleton support for global state
 * and constructor injection for testing
 */
export class EtlProjectManager implements IProjectManager {
    private static instance: EtlProjectManager;
    private currentProject: EtlProject | null = null;
    private projectPath: string | null = null;
    private isDirty: boolean = false;
    private validator: ProjectValidator;

    /**
     * Constructor - can be used directly for testing
     */
    constructor(validator?: ProjectValidator) {
        this.validator = validator || new ProjectValidator();
    }

    /**
     * Get singleton instance for global usage
     */
    static getInstance(): EtlProjectManager {
        if (!EtlProjectManager.instance) {
            EtlProjectManager.instance = new EtlProjectManager();
        }
        return EtlProjectManager.instance;
    }

    /**
     * Reset singleton (useful for testing)
     */
    static resetInstance(): void {
        EtlProjectManager.instance = undefined!;
    }

    /**
     * Create a new empty project
     */
    createProject(name: string): EtlProject {
        this.currentProject = {
            name,
            version: '1.0.0',
            description: '',
            variables: {},
            nodes: [],
            connections: []
        };
        this.projectPath = null;
        this.isDirty = true;
        return this.currentProject;
    }

    /**
     * Load project from file
     */
    async loadProject(filePath: string): Promise<EtlProject> {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const project = JSON.parse(content) as EtlProject;

        // Validate basic structure
        const errors = this.validateProject(project);
        if (errors.length > 0) {
            throw new Error(`Invalid project: ${errors.join(', ')}`);
        }

        this.currentProject = project;
        this.projectPath = filePath;
        this.isDirty = false;
        return this.currentProject;
    }

    /**
     * Save project to file
     */
    async saveProject(filePath?: string): Promise<void> {
        const targetPath = filePath || this.projectPath;
        if (!targetPath) {
            throw new Error('No file path specified');
        }
        if (!this.currentProject) {
            throw new Error('No project to save');
        }

        const content = JSON.stringify(this.currentProject, null, 2);
        await fs.promises.writeFile(targetPath, content, 'utf-8');
        this.projectPath = targetPath;
        this.isDirty = false;
    }

    /**
     * Validate project structure
     * @returns Array of error messages (empty if valid)
     */
    validateProject(project: EtlProject): string[] {
        const result = this.validator.validateProject(project);
        return result.errors;
    }

    /**
     * Get detailed validation result including warnings
     */
    validateProjectDetailed(project: EtlProject): ValidationResult {
        return this.validator.validateProject(project);
    }

    /**
     * Add a node to the current project
     */
    addNode(node: EtlNode): void {
        if (!this.currentProject) {
            throw new Error('No project loaded');
        }
        if (!node.id) {
            node.id = generateNodeId();
        }
        this.currentProject.nodes.push(node);
        this.isDirty = true;
    }

    /**
     * Update an existing node
     */
    updateNode(nodeId: string, updates: Partial<EtlNode>): void {
        if (!this.currentProject) {
            throw new Error('No project loaded');
        }
        const index = this.currentProject.nodes.findIndex(n => n.id === nodeId);
        if (index === -1) {
            throw new Error(`Node not found: ${nodeId}`);
        }
        this.currentProject.nodes[index] = {
            ...this.currentProject.nodes[index],
            ...updates
        };
        this.isDirty = true;
    }

    /**
     * Remove a node and its connections
     */
    removeNode(nodeId: string): void {
        if (!this.currentProject) {
            throw new Error('No project loaded');
        }
        this.currentProject.nodes = this.currentProject.nodes.filter(n => n.id !== nodeId);
        this.currentProject.connections = this.currentProject.connections.filter(
            c => c.from !== nodeId && c.to !== nodeId
        );
        this.isDirty = true;
    }

    /**
     * Add a connection between nodes
     */
    addConnection(connection: EtlConnection): void {
        if (!this.currentProject) {
            throw new Error('No project loaded');
        }
        if (!connection.id) {
            connection.id = generateConnectionId();
        }

        // Check if connection already exists
        const exists = this.currentProject.connections.some(
            c => c.from === connection.from && c.to === connection.to
        );
        if (exists) {
            throw new Error('Connection already exists');
        }

        // Temporarily add connection to check for cycles
        this.currentProject.connections.push(connection);

        // Validate no cycles
        const cycleErrors = this.validator.detectCycles(this.currentProject);
        if (cycleErrors.length > 0) {
            // Rollback
            this.currentProject.connections.pop();
            throw new Error('Connection would create a cycle');
        }

        this.isDirty = true;
    }

    /**
     * Remove a connection
     */
    removeConnection(connectionId: string): void {
        if (!this.currentProject) {
            throw new Error('No project loaded');
        }
        this.currentProject.connections = this.currentProject.connections.filter(
            c => c.id !== connectionId
        );
        this.isDirty = true;
    }

    /**
     * Get the current project
     */
    getCurrentProject(): EtlProject | null {
        return this.currentProject;
    }

    /**
     * Get the current project path
     */
    getProjectPath(): string | null {
        return this.projectPath;
    }

    /**
     * Check if project has unsaved changes
     */
    hasUnsavedChanges(): boolean {
        return this.isDirty;
    }

    /**
     * Get node by ID
     */
    getNode(nodeId: string): EtlNode | undefined {
        return this.currentProject?.nodes.find(n => n.id === nodeId);
    }

    /**
     * Get all connections from a node
     */
    getOutgoingConnections(nodeId: string): EtlConnection[] {
        return this.currentProject?.connections.filter(c => c.from === nodeId) || [];
    }

    /**
     * Get all connections to a node
     */
    getIncomingConnections(nodeId: string): EtlConnection[] {
        return this.currentProject?.connections.filter(c => c.to === nodeId) || [];
    }

    /**
     * Set project directly (for external updates)
     */
    setProject(project: EtlProject): void {
        this.currentProject = project;
        this.isDirty = true;
    }

    /**
     * Mark project as dirty
     */
    markDirty(): void {
        this.isDirty = true;
    }

    /**
     * Get execution order for nodes
     */
    getTopologicalOrder(): string[] | null {
        if (!this.currentProject) {
            return null;
        }
        return this.validator.getTopologicalOrder(this.currentProject);
    }
}
