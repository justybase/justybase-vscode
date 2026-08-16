import {
    ETL_PROJECT_FORMAT_VERSION,
    getDefaultConfig,
    type EtlNode,
    type EtlProject,
} from '../../etl/etlTypes';
import { EtlProjectManager } from '../../etl/etlProjectManager';
import {
    getContainerExecutionProject,
    normalizeEtlProject,
} from '../../etl/projectStructure';

function sqlNode(id: string, position = { x: 0, y: 0 }): EtlNode {
    return { id, type: 'sql', name: id, position, config: getDefaultConfig('sql') };
}

function containerNode(id: string, position = { x: 300, y: 80 }): EtlNode {
    return { id, type: 'container', name: id, position, config: getDefaultConfig('container') };
}

describe('ETL project container structure', () => {
    it('migrates legacy nested container payloads into v2 membership', () => {
        const child = sqlNode('child', { x: 80, y: 90 });
        const legacy: EtlProject = {
            name: 'Legacy',
            version: '1.0.0',
            nodes: [{
                ...containerNode('group'),
                config: { type: 'container', nodes: [child], connections: [] },
            }],
            connections: [],
        };

        const project = normalizeEtlProject(legacy);

        expect(project.version).toBe(ETL_PROJECT_FORMAT_VERSION);
        expect(project.nodes).toHaveLength(2);
        expect(project.nodes.find(node => node.id === 'child')).toMatchObject({ containerId: 'group', position: { x: 80, y: 90 } });
        expect(project.nodes.find(node => node.id === 'group')?.config).toEqual(expect.objectContaining({ type: 'container' }));
        expect(project.nodes.find(node => node.id === 'group')?.config).not.toHaveProperty('nodes');
    });

    it('moves task boundaries to the container and restores them when ungrouped', () => {
        const manager = new EtlProjectManager();
        const project: EtlProject = {
            name: 'Grouping',
            version: ETL_PROJECT_FORMAT_VERSION,
            nodes: [sqlNode('source'), sqlNode('task'), containerNode('group'), sqlNode('target')],
            connections: [
                { id: 'in', from: 'source', to: 'task' },
                { id: 'out', from: 'task', to: 'target', connectionType: 'failure' },
            ],
        };
        manager.setProject(project);

        manager.moveNodesToContainer('group', [{ id: 'task', position: { x: 70, y: 90 } }]);
        const grouped = manager.getCurrentProject()!;
        expect(grouped.nodes.find(node => node.id === 'task')?.containerId).toBe('group');
        expect(grouped.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'in', from: 'source', to: 'group', boundary: { originalFrom: 'source', originalTo: 'task' } }),
            expect.objectContaining({ id: 'out', from: 'group', to: 'target', connectionType: 'failure', boundary: { originalFrom: 'task', originalTo: 'target' } }),
        ]));

        manager.removeNodesFromContainer([{ id: 'task', position: { x: 640, y: 190 } }]);
        const ungrouped = manager.getCurrentProject()!;
        expect(ungrouped.nodes.find(node => node.id === 'task')).toMatchObject({ containerId: undefined, position: { x: 640, y: 190 } });
        expect(ungrouped.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'in', from: 'source', to: 'task', boundary: undefined }),
            expect.objectContaining({ id: 'out', from: 'task', to: 'target', boundary: undefined }),
        ]));
    });

    it('builds a container execution graph from flat members only', () => {
        const project: EtlProject = {
            name: 'Execution',
            version: ETL_PROJECT_FORMAT_VERSION,
            nodes: [
                containerNode('group'),
                { ...sqlNode('first'), containerId: 'group' },
                { ...sqlNode('second'), containerId: 'group' },
                sqlNode('outside'),
            ],
            connections: [
                { id: 'inside', from: 'first', to: 'second' },
                { id: 'boundary', from: 'group', to: 'outside', boundary: { originalFrom: 'second', originalTo: 'outside' } },
            ],
        };

        const scope = getContainerExecutionProject(project, 'group');

        expect(scope.nodes.map(node => node.id)).toEqual(['first', 'second']);
        expect(scope.nodes.every(node => !node.containerId)).toBe(true);
        expect(scope.connections).toEqual([{ id: 'inside', from: 'first', to: 'second' }]);
    });
});
