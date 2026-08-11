import type { Edge, Node } from '@xyflow/react';

/** A diagram node that is deliberately independent of a database or ETL model. */
export type DiagramNode = Node;

/** A diagram edge that is deliberately independent of a database or ETL model. */
export type DiagramEdge = Edge;

export type DiagramEdgeVariant = 'erd' | 'success' | 'failure' | 'muted';

export interface DiagramEdgeData extends Record<string, unknown> {
    variant?: DiagramEdgeVariant;
    label?: string;
    highlighted?: boolean;
    muted?: boolean;
}
