/**
 * Project Validator
 * Extracted validation logic for ETL projects
 */

import { EtlProject, EtlNode, EtlConnection } from '../etlTypes';

/**
 * Validation result containing errors and warnings
 */
export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Project validator class
 * Validates ETL project structure, connections, and detects issues
 */
export class ProjectValidator {
    /**
     * Validate a complete project
     * @param project Project to validate
     * @returns Validation result with errors and warnings
     */
    validateProject(project: EtlProject): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Basic structure validation
        if (!project.name) {
            errors.push('Project name is required');
        }

        if (!project.version) {
            errors.push('Project version is required');
        }

        if (!Array.isArray(project.nodes)) {
            errors.push('Nodes must be an array');
        }

        if (!Array.isArray(project.connections)) {
            errors.push('Connections must be an array');
        }

        // Validate nodes (only if it's an array)
        const nodesArray = Array.isArray(project.nodes) ? project.nodes : [];
        const nodeErrors = this.validateNodes(nodesArray);
        errors.push(...nodeErrors.errors);
        warnings.push(...nodeErrors.warnings);

        // Validate connections
        const nodeIds = new Set(nodesArray.map(n => n.id));
        const connectionsArray = Array.isArray(project.connections) ? project.connections : [];
        const connectionErrors = this.validateConnections(connectionsArray, nodeIds);
        errors.push(...connectionErrors.errors);
        warnings.push(...connectionErrors.warnings);

        // Check for cycles
        const cycleErrors = this.detectCycles(project);
        errors.push(...cycleErrors);

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Validate nodes array
     */
    validateNodes(nodes: EtlNode[]): { errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];
        const nodeIds = new Set<string>();

        for (const node of nodes) {
            // Check required fields
            if (!node.id) {
                errors.push('Node missing ID');
                continue;
            }

            if (nodeIds.has(node.id)) {
                errors.push(`Duplicate node ID: ${node.id}`);
            } else {
                nodeIds.add(node.id);
            }

            if (!node.type) {
                errors.push(`Node ${node.id} missing type`);
            }

            if (!node.name) {
                warnings.push(`Node ${node.id} has no name`);
            }

            // Validate position
            if (!node.position || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
                errors.push(`Node ${node.id} has invalid position`);
            }

            // Validate config exists
            if (!node.config) {
                errors.push(`Node ${node.id} has no configuration`);
            }
        }

        return { errors, warnings };
    }

    /**
     * Validate connections array
     */
    validateConnections(
        connections: EtlConnection[],
        validNodeIds: Set<string>
    ): { errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];
        const connectionPairs = new Set<string>();

        for (const conn of connections) {
            if (!conn.id) {
                errors.push('Connection missing ID');
                continue;
            }

            // Check source node exists
            if (!conn.from || !validNodeIds.has(conn.from)) {
                errors.push(`Connection ${conn.id} has invalid 'from' node: ${conn.from}`);
            }

            // Check target node exists
            if (!conn.to || !validNodeIds.has(conn.to)) {
                errors.push(`Connection ${conn.id} has invalid 'to' node: ${conn.to}`);
            }

            // Check self-connection
            if (conn.from === conn.to) {
                errors.push(`Connection ${conn.id} cannot connect node to itself`);
            }

            // Check duplicate connection
            const pairKey = `${conn.from}->${conn.to}`;
            if (connectionPairs.has(pairKey)) {
                warnings.push(`Duplicate connection from ${conn.from} to ${conn.to}`);
            } else {
                connectionPairs.add(pairKey);
            }
        }

        return { errors, warnings };
    }

    /**
     * Detect cycles in the connection graph using DFS
     * @param project Project to check
     * @returns Array of error messages if cycles found
     */
    detectCycles(project: EtlProject): string[] {
        const errors: string[] = [];
        const visited = new Set<string>();
        const recStack = new Set<string>();

        // Build adjacency list
        const adj = new Map<string, string[]>();
        for (const node of project.nodes || []) {
            adj.set(node.id, []);
        }
        for (const conn of project.connections || []) {
            adj.get(conn.from)?.push(conn.to);
        }

        const dfs = (nodeId: string): boolean => {
            visited.add(nodeId);
            recStack.add(nodeId);

            for (const neighbor of adj.get(nodeId) || []) {
                if (!visited.has(neighbor)) {
                    if (dfs(neighbor)) {
                        return true;
                    }
                } else if (recStack.has(neighbor)) {
                    return true;
                }
            }

            recStack.delete(nodeId);
            return false;
        };

        for (const node of project.nodes || []) {
            if (!visited.has(node.id)) {
                if (dfs(node.id)) {
                    errors.push('Project contains circular dependencies');
                    break;
                }
            }
        }

        return errors;
    }

    /**
     * Get topological order of nodes (for execution)
     * @param project Project to analyze
     * @returns Array of node IDs in execution order, or null if cycle detected
     */
    getTopologicalOrder(project: EtlProject): string[] | null {
        const inDegree = new Map<string, number>();
        const adj = new Map<string, string[]>();

        // Initialize
        for (const node of project.nodes) {
            inDegree.set(node.id, 0);
            adj.set(node.id, []);
        }

        // Build graph
        for (const conn of project.connections) {
            adj.get(conn.from)?.push(conn.to);
            inDegree.set(conn.to, (inDegree.get(conn.to) || 0) + 1);
        }

        // Kahn's algorithm
        const queue: string[] = [];
        for (const [nodeId, degree] of inDegree) {
            if (degree === 0) {
                queue.push(nodeId);
            }
        }

        const result: string[] = [];
        while (queue.length > 0) {
            const nodeId = queue.shift()!;
            result.push(nodeId);

            for (const neighbor of adj.get(nodeId) || []) {
                const newDegree = (inDegree.get(neighbor) || 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) {
                    queue.push(neighbor);
                }
            }
        }

        // Check if all nodes are included (no cycle)
        if (result.length !== project.nodes.length) {
            return null; // Cycle detected
        }

        return result;
    }
}

/**
 * Singleton instance for convenience
 */
export const projectValidator = new ProjectValidator();
