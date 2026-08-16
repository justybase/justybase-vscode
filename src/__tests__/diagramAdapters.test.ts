import type { ERDData } from '../schema/erdProvider';
import type { EtlProject } from '../etl/etlTypes';
import { createErdFlowModel, erdColumnHandleId } from '../../media/diagram/erdAdapter';
import { applyEtlFlowPositions, etlFlowModel, flowEdgesToEtlConnections } from '../../media/diagram/etlAdapter';
import { layoutWithElk } from '../../media/diagram/elkLayout';
import { erdLayoutKey, loadErdLayout, saveErdLayout } from '../../media/diagram/erdLayout';

const erdData: ERDData = {
    database: 'TESTDB',
    schema: 'PUBLIC',
    tables: [
        {
            database: 'TESTDB', schema: 'PUBLIC', tableName: 'PARENT', fullName: 'TESTDB.PUBLIC.PARENT', primaryKeyColumns: ['ID', 'TENANT_ID'],
            columns: [
                { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                { name: 'TENANT_ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
            ],
        },
        {
            database: 'TESTDB', schema: 'PUBLIC', tableName: 'CHILD', fullName: 'TESTDB.PUBLIC.CHILD', primaryKeyColumns: ['ID'],
            columns: [
                { name: 'ID', dataType: 'INTEGER', isPrimaryKey: true, isForeignKey: false },
                { name: 'PARENT_ID', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: true },
                { name: 'PARENT_TENANT', dataType: 'INTEGER', isPrimaryKey: false, isForeignKey: true },
            ],
        },
    ],
    relationships: [{
        constraintName: 'FK_CHILD_PARENT', fromTable: 'PUBLIC.CHILD', toTable: 'PUBLIC.PARENT',
        fromColumns: ['PARENT_ID', 'PARENT_TENANT'], toColumns: ['ID', 'TENANT_ID'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
    }],
};

const etlProject: EtlProject = {
    name: 'Pipeline', version: '1.0.0',
    nodes: [
        { id: 'source', type: 'sql', name: 'Source', position: { x: 10, y: 20 }, config: { type: 'sql', query: 'select 1' } },
        { id: 'target', type: 'export', name: 'Target', position: { x: 300, y: 20 }, config: { type: 'export', format: 'csv', outputPath: '/tmp/a.csv' } },
    ],
    connections: [{ id: 'success-edge', from: 'source', to: 'target' }, { id: 'failure-edge', from: 'source', to: 'target', connectionType: 'failure' }],
};

describe('diagram domain adapters', () => {
    it('creates stable column handles and one edge per composite mapping', () => {
        const first = createErdFlowModel(erdData);
        const second = createErdFlowModel(erdData);

        expect(erdColumnHandleId('TESTDB.PUBLIC.CHILD', 'PARENT_ID', 1)).toBe(erdColumnHandleId('TESTDB.PUBLIC.CHILD', 'PARENT_ID', 1));
        expect(first.edges.map(edge => edge.id)).toEqual(['erd:FK_CHILD_PARENT:0', 'erd:FK_CHILD_PARENT:1']);
        expect(first.edges.map(edge => edge.sourceHandle)).toEqual(second.edges.map(edge => edge.sourceHandle));
        expect(first.edges[0].targetHandle).toBe('column:TESTDB.PUBLIC.PARENT:0:ID');
        expect(first.edges[1].targetHandle).toBe('column:TESTDB.PUBLIC.PARENT:1:TENANT_ID');
    });

    it('resolves schema-qualified aliases and reports missing references without crashing', () => {
        const model = createErdFlowModel({
            ...erdData,
            relationships: [...erdData.relationships, {
                constraintName: 'FK_MISSING', fromTable: 'PUBLIC.UNKNOWN', toTable: 'PUBLIC.PARENT',
                fromColumns: ['ID'], toColumns: ['ID'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION',
            }],
        });

        expect(model.edges).toHaveLength(2);
        expect(model.missingReferences).toEqual([{ relationshipId: 'FK_MISSING', kind: 'sourceTable', value: 'PUBLIC.UNKNOWN' }]);
    });

    it('round-trips ETL connection types and positions', () => {
        const flow = etlFlowModel(etlProject);
        expect(flow.edges.map(edge => edge.sourceHandle)).toEqual(['success', 'failure']);
        expect(flowEdgesToEtlConnections(flow.edges)).toEqual([
            { id: 'success-edge', from: 'source', to: 'target', connectionType: 'success' },
            { id: 'failure-edge', from: 'source', to: 'target', connectionType: 'failure' },
        ]);
        expect(applyEtlFlowPositions(etlProject, [{ id: 'target', position: { x: 900, y: 600 } }]).nodes[1].position).toEqual({ x: 900, y: 600 });
    });

    it('renders flat container members as React Flow children', () => {
        const grouped: EtlProject = {
            name: 'Grouped',
            version: '2.0.0',
            nodes: [
                { id: 'container', type: 'container', name: 'Sequence', position: { x: 100, y: 60 }, config: { type: 'container', width: 700, height: 420 } },
                { id: 'child', type: 'sql', name: 'Inside', position: { x: 80, y: 90 }, containerId: 'container', config: { type: 'sql', query: 'select 1' } },
            ],
            connections: [],
        };

        const flow = etlFlowModel(grouped);
        const container = flow.nodes.find(node => node.id === 'container');
        const child = flow.nodes.find(node => node.id === 'child');

        expect(container).toMatchObject({ type: 'etlContainer', style: { width: 700, height: 420 }, data: { childCount: 1 } });
        expect(child).toMatchObject({ type: 'etlTask', parentId: 'container', extent: 'parent', position: { x: 80, y: 90 } });
    });

    it('falls back to saved node positions when ELK fails', async () => {
        const nodes = etlFlowModel(etlProject).nodes;
        const result = await layoutWithElk(nodes, [], {}, { layout: async () => { throw new Error('layout unavailable'); } });

        expect(result.usedFallback).toBe(true);
        expect(result.positions.get('source')).toEqual({ x: 10, y: 20 });
        expect(result.error).toBeInstanceOf(Error);
    });

    it('migrates ERD v1 positions into the v2 envelope and keeps only current tables', () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) || null,
            setItem: (key: string, value: string) => { values.set(key, value); },
        } as unknown as Storage;
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
        values.set(erdLayoutKey(erdData, 1), JSON.stringify({
            version: 1,
            positions: {
                'TESTDB.PUBLIC.PARENT': { x: 700, y: 400 },
                'TESTDB.PUBLIC.GONE': { x: 1, y: 1 },
            },
        }));

        const loaded = loadErdLayout(erdData);
        expect(loaded.positions.get('TESTDB.PUBLIC.PARENT')).toEqual({ x: 700, y: 400 });
        expect(loaded.positions.has('TESTDB.PUBLIC.GONE')).toBe(false);
        saveErdLayout(erdData, loaded.positions, { x: 10, y: 20, zoom: 0.8 });
        expect(JSON.parse(values.get(erdLayoutKey(erdData)) || '{}')).toMatchObject({ version: 2, viewport: { zoom: 0.8 } });
        delete (globalThis as { window?: unknown }).window;
    });
});
