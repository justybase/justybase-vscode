import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
    applyNodeChanges,
    applyEdgeChanges,
    ReactFlowProvider,
    useReactFlow,
    type Edge,
    type Node,
    type NodeChange,
    type EdgeChange,
    type Viewport,
} from '@xyflow/react';
import type { ERDData, RelationshipEdge, TableNode } from '../../src/schema/erdProvider';
import { DiagramCanvas } from './DiagramCanvas';
import { DiagramInspector } from './DiagramInspector';
import { DiagramToolbar } from './DiagramToolbar';
import { OrthogonalEdge } from './OrthogonalEdge';
import { ErdTableNode } from './ErdTableNode';
import { createErdFlowModel, type ErdFlowEdge, type ErdFlowNode } from './erdAdapter';
import { loadErdLayout, saveErdLayout, type ErdViewport } from './erdLayout';
import { layoutWithElk } from './elkLayout';
import { exportReactFlowCanvas } from './export';

const nodeTypes = { erdTable: ErdTableNode };
const edgeTypes = { orthogonal: OrthogonalEdge };

function ErdCanvas({
    data,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onNodeClick,
    onEdgeClick,
    onNodeDragStop,
    onPaneClick,
    onMoveEnd,
    showGrid,
    savedViewport,
    onViewportReady,
    searchValue,
    onSearchChange,
    onAutoArrange,
    onToggleGrid,
    gridEnabled,
    onExportSvg,
    onExportPng,
    inspector,
}: {
    data: ERDData;
    nodes: ErdFlowNode[];
    edges: ErdFlowEdge[];
    onNodesChange: (changes: NodeChange[]) => void;
    onEdgesChange: (changes: EdgeChange[]) => void;
    onNodeClick: (node: Node) => void;
    onEdgeClick: (edge: Edge) => void;
    onNodeDragStop: (node: Node) => void;
    onPaneClick: () => void;
    onMoveEnd: (viewport: Viewport) => void;
    showGrid: boolean;
    savedViewport?: ErdViewport;
    onViewportReady: () => void;
    searchValue: string;
    onSearchChange: (value: string) => void;
    onAutoArrange: () => void;
    onToggleGrid: () => void;
    gridEnabled: boolean;
    onExportSvg: () => void;
    onExportPng: () => void;
    inspector: ReactElement;
}): ReactElement {
    const reactFlow = useReactFlow();

    const fitView = useCallback(() => {
        void reactFlow.fitView({ padding: 0.16, duration: 220, maxZoom: 1.1 });
    }, [reactFlow]);
    const zoomIn = useCallback(() => {
        void reactFlow.zoomIn({ duration: 120 });
    }, [reactFlow]);
    const zoomOut = useCallback(() => {
        void reactFlow.zoomOut({ duration: 120 });
    }, [reactFlow]);
    const resetView = useCallback(() => {
        void reactFlow.setViewport(savedViewport || { x: 24, y: 24, zoom: 1 }, { duration: 180 });
    }, [reactFlow, savedViewport]);

    return (
        <>
            <DiagramToolbar
                leading={<div className="diagram-title-block"><div className="diagram-eyebrow">ENTITY RELATIONSHIP DIAGRAM</div><strong>{data.database}.{data.schema}</strong></div>}
                searchValue={searchValue}
                searchPlaceholder="Search tables or columns"
                onSearchChange={onSearchChange}
                onFitView={fitView}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onResetView={resetView}
                onAutoArrange={onAutoArrange}
                onToggleGrid={onToggleGrid}
                gridEnabled={gridEnabled}
                onExportSvg={onExportSvg}
                onExportPng={onExportPng}
            />
            <div className="diagram-main">
                <DiagramCanvas
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onInit={() => {
                        if (savedViewport) void reactFlow.setViewport(savedViewport);
                        onViewportReady();
                    }}
                    onNodeClick={(_event, node) => onNodeClick(node)}
                    onEdgeClick={(_event, edge) => onEdgeClick(edge)}
                    onNodeDragStop={(_event, node) => onNodeDragStop(node)}
                    onPaneClick={onPaneClick}
                    onMoveEnd={(_event, nextViewport) => onMoveEnd(nextViewport)}
                    showGrid={showGrid}
                    minimap
                />
                {inspector}
            </div>
        </>
    );
}

function InspectorContent({ table, relationship }: { table?: TableNode; relationship?: RelationshipEdge }): ReactElement {
    if (relationship) {
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">FOREIGN KEY</div><strong>{relationship.constraintName}</strong></div>
                <dl>
                    <dt>From</dt><dd>{relationship.fromTable}</dd>
                    <dt>To</dt><dd>{relationship.toTable}</dd>
                    <dt>Mappings</dt><dd>{relationship.fromColumns.map((column, index) => `${column} → ${relationship.toColumns[index] || '?'}`).join(', ')}</dd>
                    <dt>Delete</dt><dd>{relationship.onDelete}</dd>
                    <dt>Update</dt><dd>{relationship.onUpdate}</dd>
                </dl>
            </div>
        );
    }
    if (table) {
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">TABLE</div><strong>{table.fullName}</strong></div>
                <dl>
                    <dt>Columns</dt><dd>{table.columns.length}</dd>
                    <dt>Primary key</dt><dd>{table.primaryKeyColumns.join(', ') || 'None'}</dd>
                </dl>
                <div className="diagram-detail-list">
                    {table.columns.map(column => <div key={column.name}><span>{column.name}</span><span className="diagram-muted">{column.dataType}</span></div>)}
                </div>
            </div>
        );
    }
    return <p className="diagram-muted">Select a table or relationship to inspect its details.</p>;
}

function ErdDiagramInner({ data }: { data: ERDData }): ReactElement {
    const initialLayout = useMemo(() => loadErdLayout(data), [data]);
    const [positions, setPositions] = useState(initialLayout.positions);
    const [viewport, setViewport] = useState<ErdViewport | undefined>(initialLayout.viewport);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedTableId, setSelectedTableId] = useState<string>();
    const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
    const [showGrid, setShowGrid] = useState(true);
    const [isArranging, setIsArranging] = useState(false);
    const [nodes, setNodes] = useState<ErdFlowNode[]>(() => createErdFlowModel(data, initialLayout.positions).nodes);
    const [edges, setEdges] = useState<ErdFlowEdge[]>(() => createErdFlowModel(data, initialLayout.positions).edges);

    const model = useMemo(
        () => createErdFlowModel(data, positions, searchTerm, selectedEdgeId),
        [data, positions, searchTerm, selectedEdgeId],
    );

    useEffect(() => {
        setNodes(model.nodes);
        setEdges(model.edges);
    }, [model]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
                event.preventDefault();
                document.querySelector<HTMLInputElement>('.erd-diagram .diagram-search input')?.focus();
            }
            if (event.key === 'Escape') {
                setSelectedTableId(undefined);
                setSelectedEdgeId(undefined);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    const persist = useCallback((nextPositions: Map<string, { x: number; y: number }> = positions, nextViewport = viewport) => {
        saveErdLayout(data, nextPositions, nextViewport);
    }, [data, positions, viewport]);

    const handleNodesChange = useCallback((changes: NodeChange[]): void => {
        setNodes(current => applyNodeChanges(changes, current) as ErdFlowNode[]);
    }, []);

    const handleEdgesChange = useCallback((changes: EdgeChange[]): void => {
        setEdges(current => applyEdgeChanges(changes, current) as ErdFlowEdge[]);
    }, []);

    const handleNodeDragStop = useCallback((node: Node): void => {
        const next = new Map(positions);
        next.set(node.id, { x: node.position.x, y: node.position.y });
        setPositions(next);
        persist(next);
    }, [persist, positions]);

    const handleAutoArrange = useCallback(async (): Promise<void> => {
        if (isArranging) return;
        setIsArranging(true);
        const result = await layoutWithElk(nodes, edges, { direction: 'RIGHT', nodeWidth: 330, nodeHeight: 220 });
        const next = new Map(result.positions);
        setPositions(next);
        setNodes(current => current.map(node => ({ ...node, position: next.get(node.id) || node.position })));
        persist(next);
        setIsArranging(false);
    }, [edges, isArranging, nodes, persist]);

    const handleViewport = useCallback((nextViewport: Viewport): void => {
        const next = { x: nextViewport.x, y: nextViewport.y, zoom: nextViewport.zoom };
        setViewport(next);
        persist(positions, next);
    }, [persist, positions]);

    const selectedTable = selectedTableId ? data.tables.find(table => table.fullName === selectedTableId) : undefined;
    const selectedRelationship = selectedEdgeId ? edges.find(edge => edge.id === selectedEdgeId)?.data?.relationship as RelationshipEdge | undefined : undefined;
    const missingText = model.missingReferences.length > 0 ? `${model.missingReferences.length} relationship reference${model.missingReferences.length === 1 ? '' : 's'} could not be drawn.` : undefined;

    const inspector = (
        <DiagramInspector
            title={selectedRelationship?.constraintName || selectedTable?.tableName || 'Diagram overview'}
            onClose={() => { setSelectedTableId(undefined); setSelectedEdgeId(undefined); }}
        >
            <InspectorContent table={selectedTable} relationship={selectedRelationship} />
        </DiagramInspector>
    );

    return (
        <div className="diagram-app erd-diagram">
            <ReactFlowProvider>
                <ErdCanvas
                    data={data}
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onNodeClick={node => { setSelectedTableId(node.id); setSelectedEdgeId(undefined); }}
                    onEdgeClick={edge => { setSelectedEdgeId(edge.id); setSelectedTableId(undefined); }}
                    onNodeDragStop={handleNodeDragStop}
                    onPaneClick={() => { setSelectedTableId(undefined); setSelectedEdgeId(undefined); }}
                    onMoveEnd={handleViewport}
                    showGrid={showGrid}
                    savedViewport={viewport}
                    onViewportReady={() => undefined}
                    searchValue={searchTerm}
                    onSearchChange={setSearchTerm}
                    onAutoArrange={() => { void handleAutoArrange(); }}
                    onToggleGrid={() => setShowGrid(value => !value)}
                    gridEnabled={showGrid}
                    onExportSvg={() => {
                        const root = document.querySelector<HTMLElement>('.erd-diagram .diagram-canvas');
                        if (root) exportReactFlowCanvas(root, 'svg', `erd-${data.schema}`);
                    }}
                    onExportPng={() => {
                        const root = document.querySelector<HTMLElement>('.erd-diagram .diagram-canvas');
                        if (root) exportReactFlowCanvas(root, 'png', `erd-${data.schema}`);
                    }}
                    inspector={inspector}
                />
            </ReactFlowProvider>
            <div className="erd-status-overlay">
                <span>{data.tables.length} tables</span><span>{data.relationships.length} relationships</span>{isArranging && <span>Arranging…</span>}{missingText && <span title={missingText}>{missingText}</span>}
            </div>
            {data.tables.length === 0 && <div className="diagram-empty-state"><strong>No tables were found for this schema.</strong><span>The diagram will populate when metadata is available.</span></div>}
        </div>
    );
}

export function ErdDiagramApp({ data }: { data: ERDData }): ReactElement {
    return <ErdDiagramInner data={data} />;
}
