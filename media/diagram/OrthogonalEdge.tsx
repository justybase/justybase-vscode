import type { CSSProperties, ReactElement } from 'react';
import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import type { DiagramEdgeData } from './types';

export type OrthogonalEdgeProps = EdgeProps & {
    data?: DiagramEdgeData;
};

export interface OrthogonalPathOptions {
    horizontalOffset?: number;
}

/**
 * Return a deliberately boring path: every segment is horizontal or vertical.
 * React Flow calls this component after it has measured the real handles, so
 * the path remains attached when a node changes size or is moved.
 */
export function buildOrthogonalPath(
    sourceX: number,
    sourceY: number,
    targetX: number,
    targetY: number,
    options: OrthogonalPathOptions = {},
): string {
    const offset = options.horizontalOffset ?? 32;
    if (Math.abs(sourceX - targetX) < 1) {
        return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    }

    if (sourceX <= targetX) {
        const midX = sourceX + (targetX - sourceX) / 2;
        return `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`;
    }

    // Backward edges need a small dog-leg outside both cards. This keeps the
    // relationship readable and avoids a diagonal fallback when layers cross.
    const routeX = Math.max(sourceX, targetX) + offset;
    return `M ${sourceX} ${sourceY} L ${routeX} ${sourceY} L ${routeX} ${targetY} L ${targetX} ${targetY}`;
}

function edgeColor(data: DiagramEdgeData | undefined): string {
    switch (data?.variant) {
        case 'failure':
            return 'var(--diagram-edge-failure)';
        case 'success':
            return 'var(--diagram-edge-success)';
        case 'muted':
            return 'var(--diagram-edge-muted)';
        case 'erd':
        default:
            return 'var(--diagram-edge-erd)';
    }
}

export function OrthogonalEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    selected,
    data,
    label,
    markerEnd,
}: OrthogonalEdgeProps): ReactElement {
    const path = buildOrthogonalPath(sourceX, sourceY, targetX, targetY);
    const color = edgeColor(data);
    const isMuted = data?.muted === true;
    const isHighlighted = data?.highlighted === true;
    const lineStyle: CSSProperties = {
        stroke: color,
        opacity: isMuted ? 0.18 : isHighlighted || selected ? 1 : 0.82,
    };
    const effectiveMarker = markerEnd;

    return (
        <>
            <path
                id={`${id}-hit-area`}
                className="diagram-edge-hit-area"
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={22}
            />
            <path
                id={id}
                className={`diagram-edge-line${selected ? ' is-selected' : ''}${isHighlighted ? ' is-highlighted' : ''}`}
                d={path}
                fill="none"
                strokeWidth={selected || isHighlighted ? 2.6 : 1.8}
                style={lineStyle}
                markerEnd={effectiveMarker}
            />
            {(label || data?.label) && (
                <EdgeLabelRenderer>
                    <div
                        className="diagram-edge-label nodrag nopan"
                        style={{
                            transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px,${(sourceY + targetY) / 2}px)`,
                            color,
                            opacity: isMuted ? 0.25 : 1,
                        }}
                    >
                        {label || data?.label}
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}
