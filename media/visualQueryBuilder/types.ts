import type { Node } from '@xyflow/react';
import type { PlacedTable, VisualQueryBuilderTable } from './hostContracts.js';

/**
 * Data owned by a visual query-builder source node.
 *
 * This is kept in a renderer-only leaf module so node renderers do not need to
 * import the application coordinator just to share their React Flow type.
 */
export interface VisualQueryBuilderNodeData extends Record<string, unknown> {
    placed: PlacedTable;
    table: VisualQueryBuilderTable;
    onAliasChange: (tableId: string, alias: string) => void;
    onRemove: (tableId: string) => void;
    onColumnSelectionChange: (tableId: string, columnName: string, selected: boolean) => void;
    onAddFilterField: (tableId: string, columnName: string) => void;
    miniMapColor: string;
}

export type VisualQueryBuilderFlowNode = Node<VisualQueryBuilderNodeData, 'querySource'>;
