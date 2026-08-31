import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
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
    type OnNodeDrag,
} from '@xyflow/react';
import {
    type ConnectionType,
    type EtlConnection,
    type EtlNode,
    type EtlNodeStatus,
    type EtlNodeType,
    type EtlProject,
} from '../../src/etl/etlTypes';
import { getContainerChildCount, isContainerNode } from '../../src/etl/projectStructure';
import { DiagramCanvas } from './DiagramCanvas';
import { DiagramInspector } from './DiagramInspector';
import { DiagramToolbar } from './DiagramToolbar';
import { OrthogonalEdge } from './OrthogonalEdge';
import { EtlContainerNode } from './EtlContainerNode';
import { EtlTaskNode } from './EtlTaskNode';
import { EtlTaskDetailsPanel, type EtlConnectionOption } from './EtlTaskDetailsPanel';
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

const nodeTypes = { etlTask: EtlTaskNode, etlContainer: EtlContainerNode };
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

function Toolbox({ onAdd }: { onAdd: (type: EtlNodeType) => void }): ReactElement {
    return (
        <aside className="diagram-side-panel" aria-label="Task toolbox">
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
                    onClick={() => onAdd(type)}
                >
                    <ToolboxIcon type={type} />
                    <span>{taskTypeTitle(type)}</span>
                </button>
            ))}
            <div className="diagram-toolbox-help"><p>Drop a task onto the canvas or a container.</p><p>Drag existing tasks into a container to group them.</p></div>
        </aside>
    );
}

function EtlInspector({ node, edge, project, onRemoveFromContainer }: {
    node?: EtlNode;
    edge?: EtlConnection;
    project: EtlProject;
    onRemoveFromContainer: (node: EtlNode) => void;
}): ReactElement {
    if (edge) {
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">CONNECTION</div><strong>{edge.connectionType || 'success'} path</strong></div>
                <dl><dt>From</dt><dd>{edge.from}</dd><dt>To</dt><dd>{edge.to}</dd><dt>Condition</dt><dd>{edge.condition || 'Always'}</dd></dl>
            </div>
        );
    }
    if (node) {
        const childCount = isContainerNode(node) ? getContainerChildCount(project, node.id) : undefined;
        return (
            <div className="diagram-detail-stack">
                <div><div className="diagram-eyebrow">{taskTypeLabel(node).toUpperCase()}</div><strong>{node.name}</strong></div>
                <dl>
                    <dt>ID</dt><dd>{node.id}</dd>
                    <dt>Scope</dt><dd>{node.containerId ? `Container: ${project.nodes.find(item => item.id === node.containerId)?.name || node.containerId}` : 'Root canvas'}</dd>
                    {childCount !== undefined && <><dt>Tasks</dt><dd>{childCount}</dd></>}
                    <dt>Description</dt><dd>{node.description || 'None'}</dd>
                </dl>
                {node.containerId && <button className="diagram-button" type="button" onClick={() => onRemoveFromContainer(node)}>Move to canvas</button>}
            </div>
        );
    }
    return <p className="diagram-muted">Select a task or connection to inspect its details.</p>;
}

function findContainerElement(target?: EventTarget | null): HTMLElement | undefined {
    return target instanceof Element
        ? target.closest<HTMLElement>('[data-container-id]') || undefined
        : undefined;
}

function findContainerIdAtPoint(clientX: number, clientY: number, fallbackTarget?: EventTarget | null): string | undefined {
    const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-container-id]'));
    const match = containers.find(element => {
        const rect = element.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
    return match?.dataset.containerId || findContainerElement(fallbackTarget)?.dataset.containerId;
}

function containerRelativePosition(
    flowPosition: { x: number; y: number },
    project: EtlProject,
    containerId: string,
): { x: number; y: number } {
    const container = project.nodes.find(node => node.id === containerId);
    if (!container) return flowPosition;
    return {
        x: Math.max(24, flowPosition.x - container.position.x),
        y: Math.max(72, flowPosition.y - container.position.y),
    };
}

function EtlCanvas({
    project,
    statuses,
    onProjectPositionChange,
    onContainerResize,
    onMoveNodesToContainer,
    onConnection,
    onNodeDoubleClick,
    onNodeContextMenu,
    onEdgeContextMenu,
    onDropNode,
    onAddFromToolbox,
    onAutoArrange,
    selectedNodeId,
    onSelectNode,
    onSelectEdge,
    onClearSelection,
    toolbarTrailing,
    inspector,
    viewportKey,
}: {
    project: EtlProject;
    statuses: ReadonlyMap<string, EtlNodeStatus>;
    onProjectPositionChange: (nodes: Node[]) => void;
    onContainerResize: (containerId: string, width: number, height: number) => void;
    onMoveNodesToContainer: (containerId: string, nodes: Array<{ id: string; position: { x: number; y: number } }>) => void;
    onConnection: (connection: Connection) => void;
    onNodeDoubleClick: (node: Node) => void;
    onNodeContextMenu: (node: Node) => void;
    onEdgeContextMenu: (edge: Edge) => void;
    onDropNode: (type: EtlNodeType, position: { x: number; y: number }, containerId?: string) => void;
    onAddFromToolbox: (type: EtlNodeType) => void;
    onAutoArrange: () => void;
    selectedNodeId?: string;
    onSelectNode: (node?: Node) => void;
    onSelectEdge: (edge?: Edge) => void;
    onClearSelection: () => void;
    toolbarTrailing?: ReactNode;
    inspector: ReactElement;
    viewportKey: string;
}): ReactElement {
    const reactFlow = useReactFlow();
    const [showGrid, setShowGrid] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [nodes, setNodes] = useState<EtlFlowNode[]>(() => etlFlowModel(project, statuses, selectedNodeId, onContainerResize).nodes);
    const [edges, setEdges] = useState<EtlFlowEdge[]>(() => etlFlowModel(project, statuses, selectedNodeId, onContainerResize).edges);
    const model = useMemo(
        () => etlFlowModel(project, statuses, selectedNodeId, onContainerResize),
        [onContainerResize, project, selectedNodeId, statuses],
    );

    useEffect(() => {
        const term = searchTerm.trim().toLocaleLowerCase();
        setNodes(model.nodes.map(node => {
            const isMatch = !term
                || node.data.etlNode.name.toLocaleLowerCase().includes(term)
                || taskTypeLabel(node.data.etlNode).toLocaleLowerCase().includes(term)
                || node.data.etlNode.id.toLocaleLowerCase().includes(term);
            return { ...node, className: isMatch && term ? 'is-search-match' : undefined };
        }));
        setEdges(model.edges);
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

    const handleNodeDragStop = useCallback<OnNodeDrag>((event, node, draggedNodes) => {
        const dragged = (draggedNodes.length > 0 ? draggedNodes : [node]) as Node[];
        const containerId = 'clientX' in event ? findContainerIdAtPoint(event.clientX, event.clientY, event.target) : undefined;
        const movableTasks = dragged.filter(item => {
            const etlNode = (item.data as { etlNode?: EtlNode }).etlNode;
            return !!etlNode && etlNode.type !== 'container' && !etlNode.containerId;
        });

        if (containerId && movableTasks.length > 0) {
            const positions = movableTasks.map(item => ({
                id: item.id,
                position: containerRelativePosition(item.position, project, containerId),
            }));
            onMoveNodesToContainer(containerId, positions);
            return;
        }
        onProjectPositionChange(dragged);
    }, [onMoveNodesToContainer, onProjectPositionChange, project]);

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
                    const root = document.querySelector<HTMLElement>(`.etl-diagram[data-viewport-key="${CSS.escape(viewportKey)}"] .diagram-canvas`);
                    if (root) exportReactFlowCanvas(root, 'svg', project.name.replace(/\s+/g, '-').toLocaleLowerCase());
                }}
                onExportPng={() => {
                    const root = document.querySelector<HTMLElement>(`.etl-diagram[data-viewport-key="${CSS.escape(viewportKey)}"] .diagram-canvas`);
                    if (root) exportReactFlowCanvas(root, 'png', project.name.replace(/\s+/g, '-').toLocaleLowerCase());
                }}
                trailing={toolbarTrailing}
            />
            <div className="diagram-main">
                <Toolbox onAdd={onAddFromToolbox} />
                <DiagramCanvas
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={onConnection}
                    onNodeClick={(_event, item) => { onSelectNode(item); }}
                    onNodeDoubleClick={(_event, item) => onNodeDoubleClick(item)}
                    onNodeContextMenu={(event, item) => { event.preventDefault(); onNodeContextMenu(item); }}
                    onNodeDragStop={handleNodeDragStop}
                    onEdgeClick={(_event, item) => { onSelectEdge(item); }}
                    onEdgeContextMenu={(event, item) => { event.preventDefault(); onSelectEdge(item); onEdgeContextMenu(item); }}
                    onPaneClick={onClearSelection}
                    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
                    onDrop={event => {
                        event.preventDefault();
                        const type = event.dataTransfer.getData('application/x-justybase-etl-node') as EtlNodeType;
                        if (!taskTypes.includes(type)) return;
                        const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                        const containerId = findContainerIdAtPoint(event.clientX, event.clientY, event.target);
                        if (containerId && type === 'container') return;
                        onDropNode(type, containerId ? containerRelativePosition(position, project, containerId) : position, containerId);
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

function EtlDiagramInner({ initialProject }: { initialProject: EtlProject }): ReactElement {
    const [project, setProject] = useState(initialProject);
    const [statuses, setStatuses] = useState<Map<string, EtlNodeStatus>>(new Map());
    const [selectedNodeId, setSelectedNodeId] = useState<string>();
    const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
    const [isRunning, setIsRunning] = useState(false);
    const [connectionOptions, setConnectionOptions] = useState<EtlConnectionOption[]>([]);
    const [activeConnectionName, setActiveConnectionName] = useState<string>();

    useEffect(() => {
        const onMessage = (event: MessageEvent<{ type?: string; payload?: unknown }>): void => {
            const message = event.data;
            switch (message.type) {
                case 'projectUpdate':
                    if (message.payload) setProject(message.payload as EtlProject);
                    break;
                case 'connectionOptions': {
                    const payload = message.payload as {
                        activeConnectionName?: unknown;
                        connections?: unknown;
                    };
                    setActiveConnectionName(typeof payload?.activeConnectionName === 'string' ? payload.activeConnectionName : undefined);
                    if (Array.isArray(payload?.connections)) {
                        setConnectionOptions(payload.connections.filter((option): option is EtlConnectionOption => {
                            if (!option || typeof option !== 'object') return false;
                            const candidate = option as { name?: unknown };
                            return typeof candidate.name === 'string' && candidate.name.length > 0;
                        }) as EtlConnectionOption[]);
                    }
                    break;
                }
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

    const updatePosition = useCallback((nodes: Node[]): void => {
        setProject(current => applyEtlFlowPositions(current, nodes));
        for (const node of nodes) {
            postToHost({ type: 'updateNodePosition', payload: { nodeId: node.id, position: node.position } });
        }
    }, []);

    const updateContainerSize = useCallback((containerId: string, width: number, height: number): void => {
        setProject(current => ({
            ...current,
            nodes: current.nodes.map(node => node.id === containerId && node.config.type === 'container'
                ? { ...node, config: { ...node.config, width, height } }
                : node),
        }));
        postToHost({ type: 'updateContainerSize', payload: { containerId, width, height } });
    }, []);

    const updateNodeDetails = useCallback((nodeId: string, updates: Partial<EtlNode>): void => {
        setProject(current => ({
            ...current,
            nodes: current.nodes.map(node => node.id === nodeId ? { ...node, ...updates } : node),
        }));
        postToHost({ type: 'updateNodeDetails', payload: { nodeId, ...updates } });
    }, []);

    const addNode = useCallback((type: EtlNodeType, position = { x: 180, y: 120 }, containerId?: string): void => {
        if (containerId && type === 'container') return;
        postToHost({ type: 'addNode', payload: { type, position, ...(containerId ? { containerId } : {}) } });
    }, []);

    const onConnection = useCallback((connection: Connection): void => {
        if (!connection.source || !connection.target || connection.source === connection.target) return;
        const connectionType: ConnectionType = connection.sourceHandle === 'failure' ? 'failure' : 'success';
        postToHost({ type: 'addConnection', payload: { from: connection.source, to: connection.target, connectionType } });
    }, []);

    const autoArrange = useCallback(async (): Promise<void> => {
        const model = etlFlowModel(project, statuses);
        const rootNodes = model.nodes.filter(node => !node.parentId);
        const rootIds = new Set(rootNodes.map(node => node.id));
        const rootEdges = model.edges.filter(edge => rootIds.has(edge.source) && rootIds.has(edge.target));
        const result = await layoutWithElk(rootNodes, rootEdges, { direction: 'RIGHT', nodeWidth: 250, nodeHeight: 190 });
        const nextNodes = rootNodes.map(node => ({ ...node, position: result.positions.get(node.id) || node.position }));
        updatePosition(nextNodes);
    }, [project, statuses, updatePosition]);

    const removeFromContainer = useCallback((node: EtlNode): void => {
        if (!node.containerId) return;
        const container = project.nodes.find(item => item.id === node.containerId);
        const position = container
            ? { x: container.position.x + node.position.x + 24, y: container.position.y + node.position.y + 24 }
            : node.position;
        postToHost({ type: 'removeNodesFromContainer', payload: { nodes: [{ id: node.id, position }] } });
        setSelectedNodeId(undefined);
    }, [project]);

    const toolbarTrailing = (
        <>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'newProject' })}>New</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'loadProject' })}>Open</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'saveProject' })}>Save</button>
            <button className="diagram-button diagram-button-primary" type="button" onClick={() => postToHost({ type: 'runProject' })} disabled={isRunning}>Run</button>
            <button className="diagram-button" type="button" onClick={() => postToHost({ type: 'stopProject' })} disabled={!isRunning}>Stop</button>
        </>
    );

    const taskCount = project.nodes.filter(node => node.type !== 'container').length;
    return (
        <div className="diagram-app etl-diagram" data-viewport-key={project.name}>
            <ReactFlowProvider>
                <EtlCanvas
                    project={project}
                    statuses={statuses}
                    onProjectPositionChange={updatePosition}
                    onContainerResize={updateContainerSize}
                    onMoveNodesToContainer={(containerId, nodes) => postToHost({ type: 'moveNodesToContainer', payload: { containerId, nodes } })}
                    onConnection={onConnection}
                    onNodeDoubleClick={node => {
                        const etlNode = (node.data as { etlNode?: EtlNode }).etlNode;
                        if (etlNode) {
                            setSelectedNodeId(node.id);
                            setSelectedEdgeId(undefined);
                        }
                    }}
                    onNodeContextMenu={node => postToHost({ type: 'confirmRemoveNode', payload: node.id })}
                    onEdgeContextMenu={edge => {
                        const edgeData = edge.data as { connectionType?: ConnectionType } | undefined;
                        const connectionType = edgeData?.connectionType === 'failure' ? 'success' : 'failure';
                        postToHost({ type: 'toggleConnectionType', payload: { connectionId: edge.id, newType: connectionType } });
                    }}
                    onDropNode={addNode}
                    onAddFromToolbox={type => addNode(type)}
                    onAutoArrange={() => { void autoArrange(); }}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={node => { setSelectedNodeId(node?.id); setSelectedEdgeId(undefined); }}
                    onSelectEdge={edge => { setSelectedEdgeId(edge?.id); setSelectedNodeId(undefined); }}
                    onClearSelection={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); }}
                    toolbarTrailing={toolbarTrailing}
                    inspector={<DiagramInspector title={selectedNode?.name || (selectedEdge ? `${etlConnectionType(selectedEdge)} path` : 'Workflow overview')} onClose={() => { setSelectedNodeId(undefined); setSelectedEdgeId(undefined); }}>
                        {selectedNode
                            ? <EtlTaskDetailsPanel
                                node={selectedNode}
                                project={project}
                                connectionOptions={connectionOptions}
                                activeConnectionName={activeConnectionName}
                                onSave={updateNodeDetails}
                                onDelete={node => postToHost({ type: 'confirmRemoveNode', payload: node.id })}
                                onRemoveFromContainer={removeFromContainer}
                            />
                            : <EtlInspector node={undefined} edge={selectedEdge} project={project} onRemoveFromContainer={removeFromContainer} />}
                    </DiagramInspector>}
                    viewportKey={project.name}
                />
            </ReactFlowProvider>
            <div className="erd-status-overlay"><span>{taskCount} tasks</span><span>{project.connections.length} connections</span>{isRunning && <span className="diagram-badge">Running</span>}</div>
        </div>
    );
}

export function EtlDiagramApp({ project }: { project: EtlProject }): ReactElement {
    return <EtlDiagramInner initialProject={project} />;
}

export { etlConnectionFromFlowEdge };
