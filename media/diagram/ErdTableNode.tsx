import type { ReactElement } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ErdFlowNode } from './erdAdapter';
import { erdColumnHandleId, tableHasMatchingColumn } from './erdAdapter';

function TableGlyph(): ReactElement {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6 3.5v9M10 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

export function ErdTableNode({ data, selected }: NodeProps<ErdFlowNode>): ReactElement {
    const { table, searchTerm, isSearchMatch } = data;
    return (
        <article className={`erd-card${selected ? ' is-selected' : ''}${isSearchMatch ? ' is-search-match' : ''}`}>
            <header className="erd-card-header">
                <span className="erd-card-icon"><TableGlyph /></span>
                <div>
                    <strong title={table.fullName}>{table.tableName}</strong>
                    <small>{table.database}.{table.schema}</small>
                </div>
                <span className="erd-card-count">{table.columns.length} cols</span>
            </header>
            <div>
                {table.columns.map((column, index) => {
                    const handleId = erdColumnHandleId(table.fullName, column.name, index);
                    const match = tableHasMatchingColumn(table, searchTerm) && (
                        searchTerm.trim().length > 0
                        && (column.name.toLocaleUpperCase().includes(searchTerm.toLocaleUpperCase())
                            || column.dataType.toLocaleUpperCase().includes(searchTerm.toLocaleUpperCase()))
                    );
                    return (
                        <div className={`erd-column-row${match ? ' is-match' : ''}`} key={handleId}>
                            <Handle type="target" position={Position.Left} id={handleId} className="diagram-handle" />
                            <span className="erd-key-badges">
                                {column.isPrimaryKey && <span className="erd-key-badge pk">PK</span>}
                                {column.isForeignKey && <span className="erd-key-badge fk">FK</span>}
                            </span>
                            <span className="erd-column-name" title={column.name}>{column.name}</span>
                            <span className="erd-column-type" title={column.dataType}>{column.dataType}</span>
                            <Handle type="source" position={Position.Right} id={handleId} className="diagram-handle" />
                        </div>
                    );
                })}
            </div>
        </article>
    );
}
