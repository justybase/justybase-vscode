import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { EtlConnection, EtlNode, EtlNodeStatus, EtlProject, ConnectionType } from '../../src/etl/etlTypes';

export interface EtlFlowNodeData extends Record<string, unknown> {
    etlNode: EtlNode;
    status: EtlNodeStatus;
    miniMapColor: string;
    portOrder: string[];
}

export interface EtlFlowEdgeData extends Record<string, unknown> {
    variant: 'success' | 'failure';
    connection: EtlConnection;
    connectionType: ConnectionType;
    highlighted: boolean;
    muted: boolean;
}

export type EtlFlowNode = Node<EtlFlowNodeData, 'etlTask'>;
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

export function etlFlowModel(
    project: EtlProject,
    statuses: ReadonlyMap<string, EtlNodeStatus> = new Map(),
    highlightedNodeId?: string,
): { nodes: EtlFlowNode[]; edges: EtlFlowEdge[] } {
    const nodes = project.nodes.map((etlNode, index): EtlFlowNode => {
        const status = statuses.get(etlNode.id) || 'pending';
        const position = Number.isFinite(etlNode.position?.x) && Number.isFinite(etlNode.position?.y)
            ? etlNode.position
            : { x: 80 + (index % 4) * 360, y: 80 + Math.floor(index / 4) * 230 };
        return {
            id: etlNode.id,
            type: 'etlTask' as const,
            position,
            width: 250,
            data: {
                etlNode,
                status,
                miniMapColor: STATUS_COLORS[status],
                portOrder: ['target:input', 'source:success', 'source:failure'],
            },
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

    return { nodes, edges };
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
