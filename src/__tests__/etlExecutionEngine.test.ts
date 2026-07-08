/**
 * ETL Execution Engine Tests
 */

import {
    EtlProject,
    EtlNode,
    EtlNodeExecutionResult,
    getDefaultConfig
} from '../etl/etlTypes';
import { EtlExecutionEngine } from '../etl/etlExecutionEngine';
import { ExecutionContext, ITaskExecutor } from '../etl/interfaces';

// Mock VS Code
jest.mock('vscode', () => ({
    ExtensionContext: jest.fn()
}), { virtual: true });

/**
 * Mock task executor for testing
 */
class MockTaskExecutor implements ITaskExecutor {
    executeCalled = false;
    lastNode: EtlNode | null = null;
    shouldSucceed = true;
    resultOutput: unknown = null;
    rowsAffected = 0;
    delay = 0;

    async execute(node: EtlNode, _context: ExecutionContext): Promise<EtlNodeExecutionResult> {
        this.executeCalled = true;
        this.lastNode = node;

        if (this.delay > 0) {
            await new Promise(resolve => setTimeout(resolve, this.delay));
        }

        if (this.shouldSucceed) {
            return {
                nodeId: node.id,
                status: 'success',
                startTime: new Date(),
                endTime: new Date(),
                output: this.resultOutput,
                rowsAffected: this.rowsAffected
            };
        } else {
            return {
                nodeId: node.id,
                status: 'error',
                startTime: new Date(),
                endTime: new Date(),
                error: 'Mock error'
            };
        }
    }
}

/**
 * Create a mock execution context for testing
 */
function createMockContext(): ExecutionContext {
    return {
        extensionContext: {} as never,
        variables: {},
        nodeOutputs: new Map(),
        connectionDetails: {
            host: 'localhost',
            port: 5480,
            database: 'test',
            user: 'test',
            password: 'test'
        }
    };
}

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

describe('EtlExecutionEngine', () => {
    let engine: EtlExecutionEngine;
    let mockExecutor: MockTaskExecutor;

    beforeEach(() => {
        engine = new EtlExecutionEngine();
        mockExecutor = new MockTaskExecutor();
        engine.registerExecutor('sql', mockExecutor);
    });

    describe('registerExecutor', () => {
        it('should register an executor for a node type', () => {
            const executor = engine.getExecutor('sql');
            expect(executor).toBe(mockExecutor);
        });

        it('should return undefined for unregistered types', () => {
            const executor = engine.getExecutor('unknown');
            expect(executor).toBeUndefined();
        });
    });

    // buildExecutionOrder tests commented out - method replaced with dynamic execution
    /*
    describe('buildExecutionOrder', () => {
        it('should return single batch for nodes without connections', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2'),
                    createTestNode('3', 'Node 3')
                ],
                connections: []
            };

            const order = engine.buildExecutionOrder(project);
            expect(order.length).toBe(1);
            expect(order[0].length).toBe(3);
        });

        it('should order nodes based on connections', () => {
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

            const order = engine.buildExecutionOrder(project);
            expect(order.length).toBe(3);
            expect(order[0][0].id).toBe('1');
            expect(order[1][0].id).toBe('2');
            expect(order[2][0].id).toBe('3');
        });

        it('should batch parallel nodes together', () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2'),
                    createTestNode('3', 'Node 3'),
                    createTestNode('4', 'Node 4')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '3' },
                    { id: 'c2', from: '2', to: '3' },
                    { id: 'c3', from: '3', to: '4' }
                ]
            };

            const order = engine.buildExecutionOrder(project);
            expect(order.length).toBe(3);
            expect(order[0].length).toBe(2); // Nodes 1 and 2 in parallel
            expect(order[1].length).toBe(1); // Node 3
            expect(order[2].length).toBe(1); // Node 4
        });

        it('should throw on cycle detection', () => {
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

            expect(() => engine.buildExecutionOrder(project)).toThrow('Cycle detected');
        });
    });
    */

    describe('execute', () => {
        it('should execute a simple project successfully', async () => {
            mockExecutor.shouldSucceed = true;
            mockExecutor.rowsAffected = 10;

            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1')],
                connections: []
            };

            const result = await engine.execute(project, createMockContext());

            expect(result.status).toBe('completed');
            expect(result.nodeResults.size).toBe(1);
            expect(result.nodeResults.get('1')?.status).toBe('success');
        });

        it('should stop on first error and mark remaining as skipped', async () => {
            const failingExecutor = new MockTaskExecutor();
            failingExecutor.shouldSucceed = false;
            engine.registerExecutor('sql', failingExecutor);

            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '2' }
                ]
            };

            const result = await engine.execute(project, createMockContext());

            expect(result.status).toBe('failed');
            expect(result.nodeResults.get('1')?.status).toBe('error');
            expect(result.nodeResults.get('2')?.status).toBe('skipped');
        });

        it('should pass node outputs to downstream nodes', async () => {
            mockExecutor.resultOutput = { data: 'test' };

            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [
                    createTestNode('1', 'Node 1'),
                    createTestNode('2', 'Node 2')
                ],
                connections: [
                    { id: 'c1', from: '1', to: '2' }
                ]
            };

            const context = createMockContext();
            await engine.execute(project, context);

            expect(context.nodeOutputs.get('1')).toEqual({ data: 'test' });
        });

        it('should return error when no executor registered', async () => {
            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1', 'unknown' as 'sql')],
                connections: []
            };

            engine.registerExecutor('unknown', undefined!);
            const result = await engine.execute(project, createMockContext());

            expect(result.status).toBe('failed');
        });
    });

    describe('status callback', () => {
        it('should call status callback for each node state change', async () => {
            const statusChanges: { nodeId: string; status: string }[] = [];
            engine.onStatusChange((nodeId, status) => {
                statusChanges.push({ nodeId, status });
            });

            const project: EtlProject = {
                name: 'Test',
                version: '1.0.0',
                nodes: [createTestNode('1', 'Node 1')],
                connections: []
            };

            await engine.execute(project, createMockContext());

            expect(statusChanges).toEqual([
                { nodeId: '1', status: 'pending' },
                { nodeId: '1', status: 'running' },
                { nodeId: '1', status: 'success' }
            ]);
        });
    });
});
