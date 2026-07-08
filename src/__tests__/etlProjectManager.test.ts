/**
 * ETL Project Manager Tests
 */

import {
    EtlProject,
    EtlNode,
    getDefaultConfig
} from '../etl/etlTypes';
import { EtlProjectManager } from '../etl/etlProjectManager';
import { ProjectValidator } from '../etl/utils/projectValidator';

// Mock fs module
jest.mock('fs', () => ({
    promises: {
        readFile: jest.fn(),
        writeFile: jest.fn()
    }
}));

import * as fs from 'fs';

/**
 * Create a simple test node
 */
function createTestNode(id: string, name: string, type = 'sql'): EtlNode {
    return {
        id,
        name,
        type: type as 'sql' | 'python' | 'container' | 'export' | 'import',
        position: { x: 0, y: 0 },
        config: getDefaultConfig(type as 'sql' | 'python' | 'container' | 'export' | 'import')
    };
}

describe('EtlProjectManager', () => {
    let manager: EtlProjectManager;

    beforeEach(() => {
        // Create fresh instance for each test
        manager = new EtlProjectManager();
        jest.clearAllMocks();
    });

    describe('createProject', () => {
        it('should create a new empty project', () => {
            const project = manager.createProject('Test Project');

            expect(project.name).toBe('Test Project');
            expect(project.version).toBe('1.0.0');
            expect(project.nodes).toEqual([]);
            expect(project.connections).toEqual([]);
            expect(manager.hasUnsavedChanges()).toBe(true);
        });
    });

    describe('loadProject', () => {
        it('should load a valid project from file', async () => {
            const mockProject: EtlProject = {
                name: 'Loaded Project',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1')],
                connections: []
            };

            (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockProject));

            const project = await manager.loadProject('/path/to/project.etl');

            expect(project.name).toBe('Loaded Project');
            expect(project.nodes.length).toBe(1);
            expect(manager.hasUnsavedChanges()).toBe(false);
        });

        it('should throw on invalid project structure', async () => {
            const invalidProject = { nodes: [], connections: [] }; // Missing name and version

            (fs.promises.readFile as jest.Mock).mockResolvedValue(JSON.stringify(invalidProject));

            await expect(manager.loadProject('/path/to/invalid.etl'))
                .rejects.toThrow('Invalid project');
        });
    });

    describe('saveProject', () => {
        it('should save project to file', async () => {
            manager.createProject('Test Project');
            await manager.saveProject('/path/to/output.etl');

            expect(fs.promises.writeFile).toHaveBeenCalledWith(
                '/path/to/output.etl',
                expect.any(String),
                'utf-8'
            );
            expect(manager.hasUnsavedChanges()).toBe(false);
        });

        it('should throw when no project is loaded', async () => {
            await expect(manager.saveProject('/path/to/output.etl'))
                .rejects.toThrow('No project to save');
        });

        it('should throw when no path is provided and project never saved', async () => {
            manager.createProject('Test');
            await expect(manager.saveProject())
                .rejects.toThrow('No file path specified');
        });
    });

    describe('addNode', () => {
        it('should add a node to the project', () => {
            manager.createProject('Test');
            const node = createTestNode('1', 'Node 1');

            manager.addNode(node);

            expect(manager.getCurrentProject()?.nodes.length).toBe(1);
            expect(manager.hasUnsavedChanges()).toBe(true);
        });

        it('should generate ID if not provided', () => {
            manager.createProject('Test');
            const node = { ...createTestNode('', 'Node 1'), id: '' };

            manager.addNode(node);

            expect(node.id).toBeTruthy();
            expect(node.id.startsWith('node-')).toBe(true);
        });

        it('should throw when no project is loaded', () => {
            expect(() => manager.addNode(createTestNode('1', 'Node 1')))
                .toThrow('No project loaded');
        });
    });

    describe('updateNode', () => {
        it('should update an existing node', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));

            manager.updateNode('1', { name: 'Updated Name' });

            expect(manager.getNode('1')?.name).toBe('Updated Name');
        });

        it('should throw when node not found', () => {
            manager.createProject('Test');

            expect(() => manager.updateNode('nonexistent', { name: 'X' }))
                .toThrow('Node not found: nonexistent');
        });
    });

    describe('removeNode', () => {
        it('should remove a node and its connections', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addConnection({ id: 'c1', from: '1', to: '2' });

            manager.removeNode('1');

            expect(manager.getCurrentProject()?.nodes.length).toBe(1);
            expect(manager.getCurrentProject()?.connections.length).toBe(0);
        });
    });

    describe('addConnection', () => {
        it('should add a valid connection', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));

            manager.addConnection({ id: 'c1', from: '1', to: '2' });

            expect(manager.getCurrentProject()?.connections.length).toBe(1);
        });

        it('should throw when connection would create a cycle', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addConnection({ id: 'c1', from: '1', to: '2' });

            expect(() => manager.addConnection({ id: 'c2', from: '2', to: '1' }))
                .toThrow('Connection would create a cycle');

            // Verify rollback
            expect(manager.getCurrentProject()?.connections.length).toBe(1);
        });

        it('should throw when connection already exists', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addConnection({ id: 'c1', from: '1', to: '2' });

            expect(() => manager.addConnection({ id: 'c2', from: '1', to: '2' }))
                .toThrow('Connection already exists');
        });
    });

    describe('removeConnection', () => {
        it('should remove a connection', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addConnection({ id: 'c1', from: '1', to: '2' });

            manager.removeConnection('c1');

            expect(manager.getCurrentProject()?.connections.length).toBe(0);
        });
    });

    describe('getOutgoingConnections', () => {
        it('should return connections from a node', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addNode(createTestNode('3', 'Node 3'));
            manager.addConnection({ id: 'c1', from: '1', to: '2' });
            manager.addConnection({ id: 'c2', from: '1', to: '3' });

            const connections = manager.getOutgoingConnections('1');

            expect(connections.length).toBe(2);
        });
    });

    describe('getIncomingConnections', () => {
        it('should return connections to a node', () => {
            manager.createProject('Test');
            manager.addNode(createTestNode('1', 'Node 1'));
            manager.addNode(createTestNode('2', 'Node 2'));
            manager.addNode(createTestNode('3', 'Node 3'));
            manager.addConnection({ id: 'c1', from: '1', to: '3' });
            manager.addConnection({ id: 'c2', from: '2', to: '3' });

            const connections = manager.getIncomingConnections('3');

            expect(connections.length).toBe(2);
        });
    });
});

describe('ProjectValidator', () => {
    let validator: ProjectValidator;

    beforeEach(() => {
        validator = new ProjectValidator();
    });

    describe('validateProject', () => {
        it('should return valid for a correct project', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1')],
                connections: []
            };

            const result = validator.validateProject(project);

            expect(result.isValid).toBe(true);
            expect(result.errors.length).toBe(0);
        });

        it('should detect missing name', () => {
            const project = {
                name: '',
                version: '1.0.0',
                nodes: [],
                connections: []
            } as EtlProject;

            const result = validator.validateProject(project);

            expect(result.isValid).toBe(false);
            expect(result.errors).toContain('Project name is required');
        });

        it('should detect duplicate node IDs', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('1', 'Node 2')
                ],
                connections: []
            };

            const result = validator.validateProject(project);

            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.includes('Duplicate node ID'))).toBe(true);
        });

        it('should detect invalid connection references', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1')],
                connections: [{ id: 'c1', from: '1', to: 'nonexistent' }]
            };

            const result = validator.validateProject(project);

            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.includes("invalid 'to' node"))).toBe(true);
        });
    });

    describe('detectCycles', () => {
        it('should detect cycles in connections', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2'),
                    createTestNode('3', 'Node 3')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '2' },
                    { id: 'c2', from: '2', to: '3' },
                    { id: 'c3', from: '3', to: '1' }
                ]
            };

            const errors = validator.detectCycles(project);

            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0]).toContain('circular dependencies');
        });
    });

    describe('getTopologicalOrder', () => {
        it('should return correct execution order', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2'),
                    createTestNode('3', 'Node 3')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '2' },
                    { id: 'c2', from: '2', to: '3' }
                ]
            };

            const order = validator.getTopologicalOrder(project);

            expect(order).toEqual(['1', '2', '3']);
        });

        it('should return null for cyclic graph', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '2' },
                    { id: 'c2', from: '2', to: '1' }
                ]
            };

            const order = validator.getTopologicalOrder(project);

            expect(order).toBeNull();
        });
    });
});
