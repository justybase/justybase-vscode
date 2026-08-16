import { MarkerType, type Edge, type Node } from '@xyflow/react';
import {
    DEFAULT_CONTAINER_HEIGHT,
    DEFAULT_CONTAINER_WIDTH,
    type ConnectionType,
    type EtlConnection,
    type EtlNode,
    type EtlNodeStatus,
    type EtlProject,
} from '../../src/etl/etlTypes';
import { getContainerChildCount, isContainerNode } from '../../src/etl/projectStructure';

export interface EtlFlowNodeData extends Record<string, unknown> {
    etlNode: EtlNode;
    status: EtlNodeStatus;
    miniMapColor: string;
    portOrder: string[];
    childCount?: number;
    onContainerResize?: (width: number, height: number) => void;
}

export interface EtlFlowEdgeData extends Record<string, unknown> {
    variant: 'success' | 'failure';
    connection: EtlConnection;
    connectionType: ConnectionType;
    highlighted: boolean;
    muted: boolean;
}

export type EtlFlowNode = Node<EtlFlowNodeData, 'etlTask' | 'etlContainer'>;
export type EtlFlowEdge = Edge<EtlFlowEdgeData, 'orthogonal'>;

const STATUS_COLORS: Record<EtlNodeStatus, string> = {
    pending: '#7d8794',
    running: '#d5b65b',
    success: '#64c68a',
    error: '#e66b77',
    skipped: '#9a8ac7',
};

export function etlConnectionType(connection: Pick<EtlConnection, 'connectionType'>): ConnectionType {
    return connection.connectionType || 'success';
}

export function etlSourceHandle(connectionType: ConnectionType = 'success'): string {
    return connectionType;
}

export function etlTargetHandle(): string {
    return 'input';
}

export function etlConnectionFromFlowEdge(edge: Pick<Edge, 'id' | 'source' | 'target' | 'sourceHandle'>): EtlConnection {
    return {
        id: edge.id,
        from: edge.source,
        to: edge.target,
        connectionType: edge.sourceHandle === 'failure' ? 'failure' : 'success',
    };
}

function flowNodeData(
    project: EtlProject,
    etlNode: EtlNode,
    statuses: ReadonlyMap<string, EtlNodeStatus>,
    onContainerResize?: (containerId: string, width: number, height: number) => void,
): EtlFlowNodeData {
    const status = statuses.get(etlNode.id) || 'pending';
    return {
        etlNode,
        status,
        miniMapColor: STATUS_COLORS[status],
        portOrder: ['target:input', 'source:success', 'source:failure'],
        ...(isContainerNode(etlNode)
            ? {
                childCount: getContainerChildCount(project, etlNode.id),
                ...(onContainerResize ? { onContainerResize: (width: number, height: number) => onContainerResize(etlNode.id, width, height) } : {}),
            }
            : {}),
    };
}

export function etlFlowModel(
    project: EtlProject,
    statuses: ReadonlyMap<string, EtlNodeStatus> = new Map(),
    highlightedNodeId?: string,
    onContainerResize?: (containerId: string, width: number, height: number) => void,
): { nodes: EtlFlowNode[]; edges: EtlFlowEdge[] } {
    const containers = project.nodes.filter(isContainerNode).map((etlNode, index): EtlFlowNode => {
        const config = etlNode.config;
        const position = Number.isFinite(etlNode.position?.x) && Number.isFinite(etlNode.position?.y)
            ? etlNode.position
            : { x: 80 + (index % 3) * 680, y: 60 + Math.floor(index / 3) * 480 };
        return {
            id: etlNode.id,
            type: 'etlContainer',
            position,
            selected: highlightedNodeId === etlNode.id,
            style: {
                width: config.width || DEFAULT_CONTAINER_WIDTH,
                height: config.height || DEFAULT_CONTAINER_HEIGHT,
            },
            data: flowNodeData(project, etlNode, statuses, onContainerResize),
        };
    });

    const tasks = project.nodes.filter(node => !isContainerNode(node)).map((etlNode, index): EtlFlowNode => {
        const position = Number.isFinite(etlNode.position?.x) && Number.isFinite(etlNode.position?.y)
            ? etlNode.position
            : { x: 80 + (index % 4) * 330, y: 90 + Math.floor(index / 4) * 210 };
        return {
            id: etlNode.id,
            type: 'etlTask',
            position,
            selected: highlightedNodeId === etlNode.id,
            ...(etlNode.containerId ? { parentId: etlNode.containerId, extent: 'parent' as const, zIndex: 2 } : {}),
            width: 250,
            data: flowNodeData(project, etlNode, statuses),
        };
    });

    const edges = project.connections.map((connection): EtlFlowEdge => {
        const connectionType = etlConnectionType(connection);
        const highlighted = highlightedNodeId === connection.from || highlightedNodeId === connection.to;
        return {
            id: connection.id,
            type: 'orthogonal',
            source: connection.from,
            target: connection.to,
            sourceHandle: etlSourceHandle(connectionType),
            targetHandle: etlTargetHandle(),
            markerEnd: { type: MarkerType.ArrowClosed, color: connectionType === 'failure' ? '#e66b77' : '#64c68a' },
            data: {
                variant: connectionType,
                connection,
                connectionType,
                highlighted,
                muted: !!highlightedNodeId && !highlighted,
            },
        };
    });

    return { nodes: [...containers, ...tasks], edges };
}

export function applyEtlFlowPositions(project: EtlProject, nodes: Pick<Node, 'id' | 'position'>[]): EtlProject {
    const positions = new Map(nodes.map(node => [node.id, node.position]));
    return {
        ...project,
        nodes: project.nodes.map(node => {
            const position = positions.get(node.id);
            return position ? { ...node, position: { x: position.x, y: position.y } } : node;
        }),
    };
}

export function flowEdgesToEtlConnections(edges: Pick<Edge, 'id' | 'source' | 'target' | 'sourceHandle'>[]): EtlConnection[] {
    return edges.map(etlConnectionFromFlowEdge);
}

export function mergeFlowConnections(project: EtlProject, edges: Pick<Edge, 'id' | 'source' | 'target' | 'sourceHandle'>[]): EtlProject {
    return { ...project, connections: flowEdgesToEtlConnections(edges) };
}

export function taskStatusColor(status: EtlNodeStatus): string {
    return STATUS_COLORS[status];
}

export function taskTypeLabel(node: Pick<EtlNode, 'type'>): string {
    switch (node.type) {
        case 'sql': return 'SQL task';
        case 'python': return 'Python';
        case 'container': return 'Container';
        case 'export': return 'Export';
        case 'import': return 'Import';
        case 'variable': return 'Variable';
    }
}
