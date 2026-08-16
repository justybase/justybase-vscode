import type { CSSProperties, ReactElement } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { EtlFlowNode } from './etlAdapter';
import { taskStatusColor } from './etlAdapter';

function statusLabel(status: EtlFlowNode['data']['status']): string {
    return status === 'error' ? 'failed' : status;
}

export function EtlContainerNode({ data, selected }: NodeProps<EtlFlowNode>): ReactElement {
    const color = taskStatusColor(data.status);
    const { etlNode, childCount = 0 } = data;
    return (
        <section
            className={`etl-container${selected ? ' is-selected' : ''}${childCount > 0 ? ' has-children' : ''}`}
            data-container-id={etlNode.id}
            style={{ '--etl-node-color': color } as CSSProperties}
        >
            <NodeResizer
                isVisible={selected}
                minWidth={360}
                minHeight={240}
                handleClassName="etl-container-resize-handle"
                lineClassName="etl-container-resize-line"
                onResizeEnd={(_event, params) => data.onContainerResize?.(Math.round(params.width), Math.round(params.height))}
            />
            <Handle type="target" position={Position.Left} id="input" className="etl-handle etl-container-handle" />
            <header className="etl-container-header">
                <span className="etl-container-icon" aria-hidden="true">▱</span>
                <div>
                    <strong title={etlNode.name}>{etlNode.name}</strong>
                    <span>{childCount} task{childCount === 1 ? '' : 's'} · sequence container</span>
                </div>
                <span className="etl-container-status">{statusLabel(data.status)}</span>
            </header>
            <div className="etl-container-drop-hint">Drop tasks here</div>
            <span className="etl-handle-label success etl-container-handle-label">success</span>
            <span className="etl-handle-label failure etl-container-handle-label">failure</span>
            <Handle type="source" position={Position.Right} id="success" className="etl-handle etl-handle-success etl-container-handle" style={{ top: '37%' }} />
            <Handle type="source" position={Position.Right} id="failure" className="etl-handle etl-handle-failure etl-container-handle" style={{ top: '65%' }} />
        </section>
    );
}
