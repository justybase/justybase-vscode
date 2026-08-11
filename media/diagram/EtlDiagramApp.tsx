import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactElement, type ReactNode } from 'react';
import {
    applyEdgeChanges,
    applyNodeChanges,
    ReactFlowProvider,
    useReactFlow,
    type Connection,
    type Edge,
    type EdgeChange,
    type Node,
    type NodeChange,
} from '@xyflow/react';
import {
    generateConnectionId,
    generateNodeId,
    getDefaultConfig,
    type ConnectionType,
    type EtlConnection,
    type EtlNode,
    type EtlNodeStatus,
    type EtlNodeType,
    type EtlProject,
} from '../../src/etl/etlTypes';
import { DiagramCanvas } from './DiagramCanvas';
import { DiagramInspector } from './DiagramInspector';
import { DiagramToolbar } from './DiagramToolbar';
import { OrthogonalEdge } from './OrthogonalEdge';
import { EtlTaskNode } from './EtlTaskNode';
import {
    applyEtlFlowPositions,
    etlConnectionFromFlowEdge,
    etlConnectionType,
    etlFlowModel,
    taskTypeLabel,
    type EtlFlowEdge,
    type EtlFlowNode,
} from './etlAdapter';
import { layoutWithElk } from './elkLayout';
import { exportReactFlowCanvas } from './export';

const nodeTypes = { etlTask: EtlTaskNode };
const edgeTypes = { orthogonal: OrthogonalEdge };
const taskTypes: EtlNodeType[] = ['variable', 'sql', 'python', 'container', 'export', 'import'];

interface WebviewApi {
    postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): WebviewApi;

let cachedApi: WebviewApi | undefined;
function postToHost(message: unknown): void {
    try {
        cachedApi ??= acquireVsCodeApi();
        cachedApi.postMessage(message);
    } catch {
        // The module is also used by adapter/unit tests outside a webview.
    }
}

function taskTypeTitle(type: EtlNodeType): string {
    switch (type) {
        case 'sql': return 'SQL task';
        case 'python': return 'Python script';
        case 'container': return 'Container';
        case 'export': return 'Export';
        case 'import': return 'Import';
        case 'variable': return 'Variable';
    }
}

function ToolboxIcon({ type }: { type: EtlNodeType }): ReactElement {
    return <span className="etl-task-icon" aria-hidden="true"><span>{taskTypeTitle(type).slice(0, 1)}</span></span>;
}

function Toolbox({ onDropStart, compact = false }: { onDropStart: (type: EtlNodeType) => void; compact?: boolean }): ReactElement {
    return (
        <aside className={`diagram-side-panel${compact ? ' compact' : ''}`} aria-label="Task toolbox">
            <h2>Tasks</h2>
            {taskTypes.map(type => (
                <button
                    className="diagram-toolbox-item"
                    draggable
                    key={type}
                    type="button"
                    onDragStart={event => {
                        event.dataTransfer.setData('application/x-justybase-etl-node', type);
                        event.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => onDropStart(type)}
                >
                    <ToolboxIcon type={type} />
                    <span>{taskTypeTitle(type)}</span>
                </button>
            ))}
            {!compact && <div className="diagram-toolbox-help"><p>Drag a task onto the canvas.</p><p>Connect the success or failure port to the next task.</p><p>Double-click a card to configure it.</p></div>}
        </aside>
    );
}

function EtlInspector({ node, edge }: { node?: EtlNode; edge?: EtlConnection }): ReactElement {
    if (edge) {
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">CONNECTION</div><strong>{edge.connectionType || 'success'} path</strong></div>
                <dl><dt>From</dt><dd>{edge.from}</dd><dt>To</dt><dd>{edge.to}</dd><dt>Condition</dt><dd>{edge.condition || 'Always'}</dd></dl>
            </div>
        );
    }
    if (node) {
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">{taskTypeLabel(node).toUpperCase()}</div><strong>{node.name}</strong></div>
                <dl><dt>ID</dt><dd>{node.id}</dd><dt>Status</dt><dd>See task card</dd><dt>Description</dt><dd>{node.description || 'None'}</dd></dl>
            </div>
        );
    }
    return <p className="diagram-muted">Select a task or connection to inspect its details.</p>;
}

function EtlCanvas({
    project,
    statuses,
    onProjectPositionChange,
    onConnection,
    onNodeClick,
    onNodeDoubleClick,
    onNodeContextMenu,
    onEdgeClick,
    onEdgeContextMenu,
    onPaneClick,
    onDrop,
    onAddFromToolbox,
    onAutoArrange,
    selectedNodeId,
    onSelectNode,
    onSelectEdge,
    onClearSelection,
    toolbarTrailing,
    inspector,
    showToolbox = true,
    viewportKey,
}: {
    project: EtlProject;
    statuses: ReadonlyMap<string, EtlNodeStatus>;
    onProjectPositionChange: (node: Node) => void;
    onConnection: (connection: Connection) => void;
    onNodeClick: (node: Node) => void;
    onNodeDoubleClick: (node: Node) => void;
    onNodeContextMenu: (node: Node) => void;
    onEdgeClick: (edge: Edge) => void;
    onEdgeContextMenu: (edge: Edge) => void;
    onPaneClick: () => void;
    onDrop: (event: DragEvent, position: { x: number; y: number }) => void;
    onAddFromToolbox: (type: EtlNodeType) => void;
    onAutoArrange: () => void;
    selectedNodeId?: string;
    onSelectNode: (node?: Node) => void;
    onSelectEdge: (edge?: Edge) => void;
    onClearSelection: () => void;
    toolbarTrailing?: ReactNode;
    inspector: ReactElement;
    showToolbox?: boolean;
    viewportKey?: string;
}): ReactElement {
    const reactFlow = useReactFlow();
    const [showGrid, setShowGrid] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [nodes, setNodes] = useState<EtlFlowNode[]>(() => etlFlowModel(project, statuses, selectedNodeId).nodes);
    const [edges, setEdges] = useState<EtlFlowEdge[]>(() => etlFlowModel(project, statuses, selectedNodeId).edges);

    const model = useMemo(() => etlFlowModel(project, statuses, selectedNodeId), [project, selectedNodeId, statuses]);
    useEffect(() => {
        const filteredNodes = model.nodes.filter(node => {
            if (!searchTerm.trim()) return true;
            const term = searchTerm.toLocaleLowerCase();
            return node.data.etlNode.name.toLocaleLowerCase().includes(term)
                || taskTypeLabel(node.data.etlNode).toLocaleLowerCase().includes(term)
                || node.data.etlNode.id.toLocaleLowerCase().includes(term);
        });
        const filteredIds = new Set(filteredNodes.map(node => node.id));
        setNodes(filteredNodes.map(node => ({ ...node, className: filteredIds.has(node.id) ? 'is-search-match' : undefined })));
        setEdges(model.edges.filter(edge => filteredIds.has(edge.source) && filteredIds.has(edge.target)));
    }, [model, searchTerm]);

    const fitView = useCallback(() => { void reactFlow.fitView({ padding: 0.18, duration: 220, maxZoom: 1.05 }); }, [reactFlow]);
    const zoomIn = useCallback(() => { void reactFlow.zoomIn({ duration: 120 }); }, [reactFlow]);
    const zoomOut = useCallback(() => { void reactFlow.zoomOut({ duration: 120 }); }, [reactFlow]);
    const resetView = useCallback(() => { void reactFlow.setViewport({ x: 24, y: 24, zoom: 1 }, { duration: 180 }); }, [reactFlow]);

    const handleNodesChange = useCallback((changes: NodeChange[]): void => {
        setNodes(current => applyNodeChanges(changes, current) as EtlFlowNode[]);
    }, []);
    const handleEdgesChange = useCallback((changes: EdgeChange[]): void => {
        setEdges(current => applyEdgeChanges(changes.filter(change => change.type !== 'remove'), current) as EtlFlowEdge[]);
    }, []);

    return (
        <>
            <DiagramToolbar
                leading={<div className="diagram-title-block"><div className="diagram-eyebrow">ETL WORKFLOW</div><strong>{project.name}</strong></div>}
                searchValue={searchTerm}
                searchPlaceholder="Search tasks"
                onSearchChange={setSearchTerm}
                onAutoArrange={onAutoArrange}
                onFitView={fitView}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onResetView={resetView}
                onToggleGrid={() => setShowGrid(value => !value)}
                gridEnabled={showGrid}
                onExportSvg={() => {
                    const root = document.querySelector<HTMLElement>(`.etl-diagram[data-viewport-key="${CSS.escape(viewportKey || '')}"] .diagram-canvas`);
                    if (root) exportReactFlowCanvas(root, 'svg', project.name.replace(/\s+/g, '-').toLocaleLowerCase());
                }}
                onExportPng={() => {
                    const root = document.querySelector<HTMLElement>(`.etl-diagram[data-viewport-key="${CSS.escape(viewportKey || '')}"] .diagram-canvas`);
                    if (root) exportReactFlowCanvas(root, 'png', project.name.replace(/\s+/g, '-').toLocaleLowerCase());
                }}
                trailing={toolbarTrailing}
            />
            <div className="diagram-main">
                {showToolbox && <Toolbox onDropStart={onAddFromToolbox} />}
                <DiagramCanvas
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={onConnection}
                    onNodeClick={(_event, node) => { onSelectNode(node); onNodeClick(node); }}
                    onNodeDoubleClick={(_event, node) => onNodeDoubleClick(node)}
                    onNodeContextMenu={(event, node) => { event.preventDefault(); onNodeContextMenu(node); }}
                    onNodeDragStop={(_event, node) => onProjectPositionChange(node)}
                    onEdgeClick={(_event, edge) => { onSelectEdge(edge); onEdgeClick(edge); }}
                    onEdgeContextMenu={(event, edge) => { event.preventDefault(); onSelectEdge(edge); onEdgeContextMenu(edge); }}
                    onPaneClick={() => { onClearSelection(); onPaneClick(); }}
                    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
                    onDrop={event => {
                        event.preventDefault();
                        onDrop(event, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
                    }}
                    showGrid={showGrid}
                    minimap
                    connectable
                />
                {inspector}
            </div>
        </>
    );
}

function ContainerEditor({
    container,
    onClose,
    onSave,
}: {
    container: EtlNode;
    onClose: () => void;
    onSave: (nodes: EtlNode[], connections: EtlConnection[]) => void;
}): ReactElement {
    const config = container.config.type === 'container' ? container.config : { type: 'container' as const, nodes: [], connections: [] };
    const [project, setProject] = useState<EtlProject>(() => ({ name: container.name, version: '1.0.0', nodes: config.nodes, connections: config.connections }));
    const [nodes, setNodes] = useState<EtlFlowNode[]>(() => etlFlowModel(project).nodes);
    const [edges, setEdges] = useState<EtlFlowEdge[]>(() => etlFlowModel(project).edges);
    const [selectedNodeId, setSelectedNodeId] = useState<string>();
    const showGrid = true;
    const reactFlow = useReactFlow();

    useEffect(() => {
        const model = etlFlowModel(project);
        setNodes(model.nodes);
        setEdges(model.edges);
    }, [project]);

    const addNode = useCallback((type: EtlNodeType, position = { x: 160, y: 100 }): void => {
        const node: EtlNode = { id: generateNodeId(), type, name: taskTypeTitle(type), position, config: getDefaultConfig(type) };
        setProject(current => ({ ...current, nodes: [...current.nodes, node] }));
    }, []);

    const onDrop = useCallback((event: DragEvent): void => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/x-justybase-etl-node') as EtlNodeType;
        if (!taskTypes.includes(type)) return;
        const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        addNode(type, position);
    }, [addNode, reactFlow]);

    const onConnect = useCallback((connection: Connection): void => {
        if (!connection.source || !connection.target || connection.source === connection.target) return;
        const nextConnection = {
            id: generateConnectionId(),
            from: connection.source,
            to: connection.target,
            connectionType: connection.sourceHandle === 'failure' ? 'failure' as const : 'success' as const,
        };
        if (project.connections.some(item => item.from === nextConnection.from && item.to === nextConnection.to && etlConnectionType(item) === nextConnection.connectionType)) return;
        setProject(current => ({ ...current, connections: [...current.connections, nextConnection] }));
    }, [project.connections]);

    const handleNodeDrag = useCallback((node: Node): void => {
        setProject(current => applyEtlFlowPositions(current, [node]));
    }, []);

    const containerFlow = { nodes, edges };
    return (
        <div className="diagram-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Edit ${container.name}`}>
            <div className="diagram-modal">
                <header className="diagram-modal-header"><span className="diagram-modal-title">Edit container · {container.name}</span><button className="diagram-icon-button" type="button" onClick={onClose} aria-label="Close">×</button></header>
                <div className="diagram-modal-body">
                    <Toolbox compact onDropStart={addNode} />
                    <div className="diagram-canvas">
                        <DiagramCanvas
                            nodes={containerFlow.nodes}
                            edges={containerFlow.edges}
                            nodeTypes={nodeTypes}
                            edgeTypes={edgeTypes}
                            onNodesChange={changes => setNodes(current => applyNodeChanges(changes, current) as EtlFlowNode[])}
                            onEdgesChange={changes => setEdges(current => applyEdgeChanges(changes.filter(change => change.type !== 'remove'), current) as EtlFlowEdge[])}
                            onConnect={onConnect}
                            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
                            onNodeDoubleClick={(_event, node) => postToHost({ type: 'configureContainerChildNode', payload: { containerId: container.id, nodeId: node.id } })}
                            onNodeDragStop={(_event, node) => handleNodeDrag(node)}
                            onEdgeContextMenu={(event, edge) => { event.preventDefault(); onSave(project.nodes, project.connections.map(connection => connection.id === edge.id ? { ...connection, connectionType: etlConnectionType(connection) === 'success' ? 'failure' : 'success' } : connection)); }}
                            onDrop={onDrop}
                            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
                            showGrid={showGrid}
                            minimap={false}
                            connectable
                        />
                        {selectedNodeId && <div className="diagram-selection-chip">Selected: {project.nodes.find(node => node.id === selectedNodeId)?.name}</div>}
                    </div>
                </div>
                <footer className="diagram-modal-footer"><button className="diagram-button" type="button" onClick={onClose}>Cancel</button><button className="diagram-button" type="button" onClick={() => onSave(project.nodes, project.connections)}>Save container</button></footer>
            </div>
        </div>
    );
}

function EtlDiagramInner({ initialProject }: { initialProject: EtlProject }): ReactElement {
    const [project, setProject] = useState(initialProject);
    const [statuses, setStatuses] = useState<Map<string, EtlNodeStatus>>(new Map());
    const [selectedNodeId, setSelectedNodeId] = useState<string>();
    const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
    const [isRunning, setIsRunning] = useState(false);
    const [containerId, setContainerId] = useState<string>();

    useEffect(() => {
        const onMessage = (event: MessageEvent<{ type?: string; payload?: unknown }>): void => {
            const message = event.data;
            switch (message.type) {
                case 'projectUpdate':
                    if (message.payload) setProject(message.payload as EtlProject);
                    break;
                case 'nodeStatusUpdate': {
                    const payload = message.payload as { nodeId: string; status: EtlNodeStatus };
                    setStatuses(current => new Map(current).set(payload.nodeId, payload.status));
                    break;
                }
                case 'executionStarted':
                    setIsRunning(true);
                    break;
                case 'executionEnded':
                    setIsRunning(false);
                    break;
                case 'containerChildUpdated': {
                    const payload = message.payload as { containerId: string; childNode: EtlNode };
                    setProject(current => ({
                        ...current,
                        nodes: current.nodes.map(node => {
                            if (node.id !== payload.containerId || node.config.type !== 'container') return node;
                            return { ...node, config: { ...node.config, nodes: node.config.nodes.map(child => child.id === payload.childNode.id ? payload.childNode : child) } };
                        }),
                    }));
                    break;
                }
            }
        };
        window.addEventListener('message', onMessage);
        postToHost({ type: 'getProject' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            if ((event.target as HTMLElement | null)?.matches('input, textarea, [contenteditable="true"]')) return;
            if (selectedEdgeId) {
                event.preventDefault();
                postToHost({ type: 'confirmRemoveConnection', payload: selectedEdgeId });
            } else if (selectedNodeId) {
                event.preventDefault();
                postToHost({ type: 'confirmRemoveNode', payload: selectedNodeId });
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedEdgeId, selectedNodeId]);

    const selectedNode = selectedNodeId ? project.nodes.find(node => node.id === selectedNodeId) : undefined;
    const selectedEdge = selectedEdgeId ? project.connections.find(connection => connection.id === selectedEdgeId) : undefined;

    const updatePosition = useCallback((node: Node): void => {
        setProject(current => applyEtlFlowPositions(current, [node]));
        postToHost({ type: 'updateNodePosition', payload: { nodeId: node.id, position: node.position } });
    }, []);

    const addNode = useCallback((type: EtlNodeType, position = { x: 180, y: 120 }): void => {
        postToHost({ type: 'addNode', payload: { type, position } });
    }, []);

    const onDrop = useCallback((event: DragEvent, position: { x: number; y: number }): void => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/x-justybase-etl-node') as EtlNodeType;
        if (!taskTypes.includes(type)) return;
        postToHost({ type: 'addNode', payload: { type, position } });
    }, []);

    const onConnect = useCallback((connection: Connection): void => {
        if (!connection.source || !connection.target || connection.source === connection.target) return;
        const connectionType: ConnectionType = connection.sourceHandle === 'failure' ? 'failure' : 'success';
        postToHost({ type: 'addConnection', payload: { from: connection.source, to: connection.target, connectionType } });
    }, []);

    const autoArrange = useCallback(async (): Promise<void> => {
        const model = etlFlowModel(project, statuses);
        const result = await layoutWithElk(model.nodes, model.edges, { direction: 'RIGHT', nodeWidth: 250, nodeHeight: 190 });
        const nextNodes = model.nodes.map(node => ({ ...node, position: result.positions.get(node.id) || node.position }));
        for (const node of nextNodes) postToHost({ type: 'updateNodePosition', payload: { nodeId: node.id, position: node.position } });
        setProject(current => applyEtlFlowPositions(current, nextNodes));
    }, [project, statuses]);

    const saveContainer = useCallback((nodes: EtlNode[], connections: EtlConnection[]): void => {
        if (!containerId) return;
        postToHost({ type: 'updateContainerNodes', payload: { containerId, nodes, connections } });
        setContainerId(undefined);
    }, [containerId]);

    const toolbarTrailing = (
        <>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'newProject' })}>New</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'loadProject' })}>Open</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'saveProject' })}>Save</button>
            <button className="diagram-button diagram-button-primary" type="button" onClick={() => postToHost({ type: 'runProject' })} disabled={isRunning}>Run</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'stopProject' })} disabled={!isRunning}>Stop</button>
        </>
    );

    return (
        <div className="diagram-app etl-diagram" data-viewport-key={project.name}>
            <ReactFlowProvider>
                <EtlCanvas
                    project={project}
                    statuses={statuses}
                    onProjectPositionChange={updatePosition}
                    onConnection={onConnect}
                    onNodeClick={() => undefined}
                    onNodeDoubleClick={node => {
                        const etlNode = (node.data as { etlNode?: EtlNode }).etlNode;
                        if (etlNode?.type === 'container') setContainerId(node.id);
                        else postToHost({ type: 'configureNode', payload: node.id });
                    }}
                    onNodeContextMenu={node => postToHost({ type: 'confirmRemoveNode', payload: node.id })}
                    onEdgeClick={() => undefined}
                    onEdgeContextMenu={edge => {
                        const edgeData = edge.data as { connectionType?: ConnectionType } | undefined;
                        const connectionType = edgeData?.connectionType === 'failure' ? 'success' : 'failure';
                        postToHost({ type: 'toggleConnectionType', payload: { connectionId: edge.id, newType: connectionType } });
                    }}
                    onPaneClick={() => undefined}
                    onDrop={onDrop}
                    onAddFromToolbox={addNode}
                    onAutoArrange={() => { void autoArrange(); }}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={node => { setSelectedNodeId(node?.id); setSelectedEdgeId(undefined); }}
                    onSelectEdge={edge => { setSelectedEdgeId(edge?.id); setSelectedNodeId(undefined); }}
                    onClearSelection={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); }}
                    toolbarTrailing={toolbarTrailing}
                    inspector={<DiagramInspector title={selectedNode?.name || (selectedEdge ? `${etlConnectionType(selectedEdge)} path` : 'Workflow overview')} onClose={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); }}><EtlInspector node={selectedNode} edge={selectedEdge} /></DiagramInspector>}
                    viewportKey={project.name}
                />
            </ReactFlowProvider>
            <div className="erd-status-overlay"><span>{project.nodes.length} tasks</span><span>{project.connections.length} connections</span>{isRunning && <span className="diagram-badge">Running</span>}</div>
            {containerId && (() => {
                const container = project.nodes.find(node => node.id === containerId);
                return container ? (
                    <ReactFlowProvider>
                        <ContainerEditor container={container} onClose={() => setContainerId(undefined)} onSave={saveContainer} />
                    </ReactFlowProvider>
                ) : null;
            })()}
        </div>
    );
}

export function EtlDiagramApp({ project }: { project: EtlProject }): ReactElement {
    return <EtlDiagramInner initialProject={project} />;
}

export { etlConnectionFromFlowEdge };
