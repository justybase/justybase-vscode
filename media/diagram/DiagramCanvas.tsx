import type { CSSProperties, DragEventHandler, ReactElement } from 'react';
import {
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    ReactFlow,
    SelectionMode,
    type Connection,
    type Edge,
    type EdgeMouseHandler,
    type EdgeTypes,
    type Node,
    type NodeMouseHandler,
    type NodeTypes,
    type OnEdgesChange,
    type OnInit,
    type OnMoveEnd,
    type OnNodesChange,
    type OnNodeDrag,
    type ReactFlowInstance,
} from '@xyflow/react';

export interface DiagramCanvasProps {
    nodes: Node[];
    edges: Edge[];
    nodeTypes: NodeTypes;
    edgeTypes: EdgeTypes;
    onNodesChange: OnNodesChange;
    onEdgesChange: OnEdgesChange;
    onConnect?: (connection: Connection) => void;
    onInit?: OnInit;
    onMoveEnd?: OnMoveEnd;
    onNodeClick?: NodeMouseHandler;
    onNodeDoubleClick?: NodeMouseHandler;
    onNodeContextMenu?: NodeMouseHandler;
    onNodeDragStop?: OnNodeDrag;
    onEdgeClick?: EdgeMouseHandler;
    onEdgeContextMenu?: EdgeMouseHandler;
    onPaneClick?: () => void;
    onDragOver?: DragEventHandler<HTMLDivElement>;
    onDrop?: DragEventHandler<HTMLDivElement>;
    showGrid?: boolean;
    minimap?: boolean;
    connectable?: boolean;
    className?: string;
    style?: CSSProperties;
}

export function DiagramCanvas({
    nodes,
    edges,
    nodeTypes,
    edgeTypes,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onInit,
    onMoveEnd,
    onNodeClick,
    onNodeDoubleClick,
    onNodeContextMenu,
    onNodeDragStop,
    onEdgeClick,
    onEdgeContextMenu,
    onPaneClick,
    onDragOver,
    onDrop,
    showGrid = true,
    minimap = true,
    connectable = false,
    className = '',
    style,
}: DiagramCanvasProps): ReactElement {
    return (
        <div className={`diagram-canvas ${className}`} style={style}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onInit={onInit}
                onMoveEnd={onMoveEnd}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onNodeContextMenu={onNodeContextMenu}
                onNodeDragStop={onNodeDragStop}
                onEdgeClick={onEdgeClick}
                onEdgeContextMenu={onEdgeContextMenu}
                onPaneClick={onPaneClick}
                onDragOver={onDragOver}
                onDrop={onDrop}
                fitView
                fitViewOptions={{ padding: 0.16, maxZoom: 1.1 }}
                minZoom={0.15}
                maxZoom={2.4}
                panOnDrag
                selectionOnDrag
                selectionMode={SelectionMode.Partial}
                nodesConnectable={connectable}
                elementsSelectable
                deleteKeyCode={null}
                proOptions={{ hideAttribution: false }}
            >
                {showGrid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} />}
                <Controls showInteractive={false} />
                {minimap && <MiniMap pannable zoomable nodeColor={(node) => node.data?.miniMapColor as string || 'var(--vscode-button-background)'} />}
            </ReactFlow>
        </div>
    );
}

export type { ReactFlowInstance };
