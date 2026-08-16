import type { ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { VisualQueryBuilderTable } from './hostContracts.js';
import type { VisualQueryBuilderFlowNode } from './VisualQueryBuilderApp.js';

function SourceGlyph(): ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6 3.5v9M10 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

function handleId(columnName: string): string {
    return `column:${columnName}`;
}

export function VisualQueryBuilderSourceNode({ data, selected }: NodeProps<VisualQueryBuilderFlowNode>): ReactElement {
    const { placed, table, onAliasChange, onRemove, onColumnSelectionChange, onAddFilterField } = data;
    return (
        <article className={`vqb-source-card${selected ? ' is-selected' : ''}`}>
            <header className="vqb-source-card-header">
                <span className="erd-card-icon"><SourceGlyph /></span>
                <div className="vqb-source-title">
                    <strong title={table.fullName}>{table.tableName}</strong>
                    <small>{table.schema} · {table.objectType || 'TABLE'}</small>
                </div>
                <input
                    aria-label={`Alias for ${table.tableName}`}
                    className="vqb-alias-input nodrag nopan"
                    maxLength={20}
                    onChange={event => onAliasChange(placed.instanceId, event.target.value)}
                    value={placed.alias}
                />
                <button
                    aria-label={`Remove ${table.tableName}`}
                    className="diagram-icon-button vqb-remove-source nodrag nopan"
                    onClick={() => onRemove(placed.instanceId)}
                    type="button"
                >×</button>
            </header>
            <div className="vqb-source-columns">
                {table.columns.map(column => {
                    const id = handleId(column.name);
                    return (
                        <label
                            className="vqb-column-row"
                            key={id}
                            onDoubleClick={() => onAddFilterField(placed.instanceId, column.name)}
                            title="Double-click to add to Filter & Sort"
                        >
                            <Handle className="diagram-handle" id={id} position={Position.Left} type="target" />
                            <input
                                checked={placed.selectedColumns.includes(column.name)}
                                className="nodrag nopan"
                                onChange={event => onColumnSelectionChange(placed.instanceId, column.name, event.target.checked)}
                                type="checkbox"
                            />
                            <span className="erd-key-badges">
                                {column.isPrimaryKey && <span className="erd-key-badge pk">PK</span>}
                                {column.isForeignKey && <span className="erd-key-badge fk">FK</span>}
                            </span>
                            <span className="erd-column-name" title={column.name}>{column.name}</span>
                            <span className="erd-column-type" title={column.dataType}>{column.dataType}</span>
                            <Handle className="diagram-handle" id={id} position={Position.Right} type="source" />
                        </label>
                    );
                })}
            </div>
        </article>
    );
}

export function getVisualQueryBuilderColumnFromHandle(handle: string | null | undefined): string | undefined {
    const prefix = 'column:';
    return handle?.startsWith(prefix) ? handle.slice(prefix.length) : undefined;
}

export type { VisualQueryBuilderTable };
