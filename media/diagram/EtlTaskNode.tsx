import type { CSSProperties, ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { EtlFlowNode } from './etlAdapter';
import { taskStatusColor, taskTypeLabel } from './etlAdapter';

function TaskIcon({ type }: { type: EtlFlowNode['data']['etlNode']['type'] }): ReactElement {
    const pathByType: Record<typeof type, ReactElement> = {
        sql: <path d="M3 3.5h10M3 6.5h7M3 9.5h10M3 12.5h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
        python: <path d="M5 3.5h3a2 2 0 0 1 2 2v1H6a2 2 0 0 0-2 2v1.5a2 2 0 0 0 2 2h2M11 12.5H8a2 2 0 0 1-2-2v-1h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H8" fill="none" stroke="currentColor" strokeWidth="1.2" />,
        container: <path d="M3 5h4l1.2 1.5H13v5.5H3zM3 5v-1h3l1 1" fill="none" stroke="currentColor" strokeWidth="1.2" />,
        export: <path d="M8 12V3M5 6l3-3 3 3M3 10.5v2h10v-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
        import: <path d="M8 3v9M5 9l3 3 3-3M3 5.5v-2h10v2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
        variable: <path d="M4 4v8M4 4h3a2 2 0 0 1 0 4H4M10 4h2M11 4v8M9 12h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />,
    };
    return <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">{pathByType[type]}</svg>;
}

function statusLabel(status: EtlFlowNode['data']['status']): string {
    return status === 'error' ? 'failed' : status;
}

function descriptionForNode(node: EtlFlowNode['data']['etlNode']): string {
    switch (node.config.type) {
        case 'sql': return `${node.config.query ? 'SQL statement configured' : 'SQL statement not configured'}${node.config.connection && node.config.connection !== 'default' ? ` · ${node.config.connection}` : ''}`;
        case 'python': return node.config.script || node.config.scriptPath ? 'Python script configured' : 'Python script not configured';
        case 'container': {
            const childCount = node.config.nodes?.length || 0;
            return `${childCount} child task${childCount === 1 ? '' : 's'}`;
        }
        case 'export': return `${node.config.format.toUpperCase()} · ${node.config.outputPath || 'output not configured'}${node.config.connection && node.config.connection !== 'default' ? ` · ${node.config.connection}` : ''}`;
        case 'import': return `${node.config.format.toUpperCase()} · ${node.config.targetTable || 'target not configured'}${node.config.connection && node.config.connection !== 'default' ? ` · ${node.config.connection}` : ''}`;
        case 'variable': return node.config.variableName ? `\${node.config.variableName}` : 'Variable not configured';
    }
}

export function EtlTaskNode({ data, selected }: NodeProps<EtlFlowNode>): ReactElement {
    const { etlNode, status } = data;
    const color = taskStatusColor(status);
    return (
        <article className={`etl-card etl-status-${status}${selected ? ' is-selected' : ''}`} style={{ '--etl-node-color': color } as CSSProperties}>
            <Handle type="target" position={Position.Left} id="input" className="etl-handle" />
            <header className="etl-card-header">
                <span className="etl-task-icon"><TaskIcon type={etlNode.type} /></span>
                <div>
                    <strong title={etlNode.name}>{etlNode.name}</strong>
                    <div className="diagram-muted">{taskTypeLabel(etlNode)}</div>
                </div>
            </header>
            <div className="etl-card-body">
                <div className="etl-card-description">{etlNode.description || descriptionForNode(etlNode)}</div>
            </div>
            <footer className="etl-card-footer">
                <span className="etl-status"><span className="etl-status-dot" />{statusLabel(status)}</span>
                <span>{etlNode.id}</span>
            </footer>
            <span className="etl-handle-label success">success</span>
            <span className="etl-handle-label failure">failure</span>
            <Handle type="source" position={Position.Right} id="success" className="etl-handle etl-handle-success" style={{ top: '35%' }} />
            <Handle type="source" position={Position.Right} id="failure" className="etl-handle etl-handle-failure" style={{ top: '68%' }} />
        </article>
    );
}
