import { Position as FlowPosition, type Edge, type Node } from '@xyflow/react';

export interface LayoutPosition {
    x: number;
    y: number;
}

export interface ElkLayoutResult {
    positions: Map<string, LayoutPosition>;
    usedFallback: boolean;
    error?: unknown;
}

export interface ElkLayoutOptions {
    direction?: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
    nodeWidth?: number;
    nodeHeight?: number;
}

interface ElkNode {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    children?: ElkNode[];
    ports?: Array<{ id: string; width?: number; height?: number; layoutOptions?: Record<string, string> }>;
    edges?: Array<{ id: string; sources: string[]; targets: string[]; layoutOptions?: Record<string, string> }>;
    layoutOptions?: Record<string, string>;
}

interface ElkLayoutEngine {
    layout(graph: ElkNode): Promise<ElkNode>;
}

interface ElkPortDefinition {
    id: string;
    width: number;
    height: number;
    layoutOptions: Record<string, string>;
}

declare const require: (moduleName: string) => unknown;
const ElkConstructor = require('elkjs/lib/elk.bundled.js') as new () => ElkLayoutEngine;
const elk = new ElkConstructor();

function finitePosition(position: { x: number; y: number } | undefined, fallback: LayoutPosition): LayoutPosition {
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        return { x: position.x, y: position.y };
    }
    return fallback;
}

function flowPositionToElk(position: FlowPosition): string {
    switch (position) {
        case 'left':
            return 'WEST';
        case 'right':
            return 'EAST';
        case 'top':
            return 'NORTH';
        case 'bottom':
        default:
            return 'SOUTH';
    }
}

function portDirection(portId: string, index: number): { direction: 'source' | 'target'; handleId: string } {
    if (portId.startsWith('target:')) {
        return { direction: 'target', handleId: portId.slice('target:'.length) };
    }
    if (portId.startsWith('source:')) {
        return { direction: 'source', handleId: portId.slice('source:'.length) };
    }
    // Keep accepting the original alternating portOrder format while all new
    // adapters use explicit source:/target: entries.
    return { direction: index % 2 === 0 ? 'target' : 'source', handleId: portId };
}

function buildElkPorts(nodeId: string, portOrder: string[]): ElkPortDefinition[] {
    return portOrder.map((portId, index) => {
        const { direction, handleId } = portDirection(portId, index);
        return {
            id: direction === 'source' ? sourcePortId(nodeId, handleId) : targetPortId(nodeId, handleId),
            width: 8,
            height: 8,
            layoutOptions: {
                'org.eclipse.elk.port.side': direction === 'source' ? 'EAST' : 'WEST',
                'org.eclipse.elk.port.index': String(index),
            },
        };
    });
}

function buildElkGraph(nodes: Node[], edges: Edge[], options: ElkLayoutOptions): ElkNode {
    const declaredPorts = new Map<string, Set<string>>();
    const children = nodes.map((node, index) => {
        const ports = Array.isArray(node.data?.portOrder)
            ? buildElkPorts(node.id, node.data.portOrder as string[])
            : undefined;
        if (ports) declaredPorts.set(node.id, new Set(ports.map(port => port.id)));
        return {
            id: node.id,
            width: Number(node.width) || options.nodeWidth || 320,
            height: Number(node.height) || options.nodeHeight || 180,
            ports,
            layoutOptions: {
                'org.eclipse.elk.portConstraints': 'FIXED_ORDER',
                'org.eclipse.elk.layered.layering.layerChoiceConstraint': 'NONE',
                'org.eclipse.elk.position': `${node.position.x},${node.position.y}`,
                'org.eclipse.elk.modelOrder': String(index),
            },
        };
    });

    return {
        id: 'diagram-root',
        children,
        edges: edges.map((edge, index) => ({
            id: edge.id || `edge-${index}`,
            sources: [edge.sourceHandle && declaredPorts.get(edge.source)?.has(sourcePortId(edge.source, edge.sourceHandle))
                ? sourcePortId(edge.source, edge.sourceHandle)
                : edge.source],
            targets: [edge.targetHandle && declaredPorts.get(edge.target)?.has(targetPortId(edge.target, edge.targetHandle))
                ? targetPortId(edge.target, edge.targetHandle)
                : edge.target],
            layoutOptions: {
                'org.eclipse.elk.edgeRouting': 'ORTHOGONAL',
                'org.eclipse.elk.layered.priority': String(index),
            },
        })),
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': options.direction || 'RIGHT',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
            'elk.spacing.nodeNode': '64',
            'elk.layered.spacing.nodeNodeBetweenLayers': '120',
            'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        },
    };
}

/**
 * Layout is an explicit user action. Callers should not invoke this from a
 * node-drag handler; React Flow already keeps edges attached while dragging.
 */
export async function layoutWithElk(
    nodes: Node[],
    edges: Edge[],
    options: ElkLayoutOptions = {},
    engine: ElkLayoutEngine = elk,
): Promise<ElkLayoutResult> {
    const fallback = new Map<string, LayoutPosition>();
    nodes.forEach((node, index) => {
        fallback.set(node.id, finitePosition(node.position, { x: 80 + index * 40, y: 80 + index * 40 }));
    });

    if (nodes.length === 0) {
        return { positions: fallback, usedFallback: false };
    }

    try {
        const result = await engine.layout(buildElkGraph(nodes, edges, options));
        const positions = new Map<string, LayoutPosition>();
        for (const [index, node] of nodes.entries()) {
            const laidOut = result.children?.find(child => child.id === node.id);
            positions.set(
                node.id,
                finitePosition(
                    laidOut?.x !== undefined && laidOut?.y !== undefined ? { x: laidOut.x, y: laidOut.y } : undefined,
                    fallback.get(node.id) || { x: 80 + index * 40, y: 80 + index * 40 },
                ),
            );
        }
        return { positions, usedFallback: false };
    } catch (error) {
        return { positions: fallback, usedFallback: true, error };
    }
}

export function layoutPositionsToRecord(positions: Map<string, LayoutPosition>): Record<string, LayoutPosition> {
    return Object.fromEntries(positions.entries());
}

export function recordToLayoutPositions(record: Record<string, LayoutPosition> | undefined): Map<string, LayoutPosition> {
    const positions = new Map<string, LayoutPosition>();
    for (const [id, position] of Object.entries(record || {})) {
        if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
            positions.set(id, { x: position.x, y: position.y });
        }
    }
    return positions;
}

export function sourcePortId(nodeId: string, handleId: string): string {
    return `${nodeId}:source:${handleId}`;
}

export function targetPortId(nodeId: string, handleId: string): string {
    return `${nodeId}:target:${handleId}`;
}

export function flowPositionForDirection(direction: 'source' | 'target'): FlowPosition {
    return direction === 'source' ? FlowPosition.Right : FlowPosition.Left;
}

export function flowPositionToElkSide(position: FlowPosition): string {
    return flowPositionToElk(position);
}
