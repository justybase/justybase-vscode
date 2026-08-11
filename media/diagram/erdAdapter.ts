import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { ColumnInfo, ERDData, RelationshipEdge, TableNode } from '../../src/schema/erdProvider';

export interface ErdTableNodeData extends Record<string, unknown> {
    table: TableNode;
    searchTerm: string;
    isSearchMatch: boolean;
    portOrder: string[];
    miniMapColor: string;
}

export interface ErdEdgeData extends Record<string, unknown> {
    variant: 'erd';
    relationship: RelationshipEdge;
    mappingIndex: number;
    highlighted: boolean;
    muted: boolean;
    label: string;
}

export type ErdFlowNode = Node<ErdTableNodeData, 'erdTable'>;
export type ErdFlowEdge = Edge<ErdEdgeData, 'orthogonal'>;

export interface ErdMissingReference {
    relationshipId: string;
    kind: 'sourceTable' | 'targetTable' | 'sourceColumn' | 'targetColumn';
    value: string;
}

export interface ErdFlowModel {
    nodes: ErdFlowNode[];
    edges: ErdFlowEdge[];
    missingReferences: ErdMissingReference[];
}

export function normalizeErdName(value: string): string {
    return value.trim().replace(/^"|"$/g, '').toLocaleUpperCase();
}

export function buildErdTableAliases(tables: TableNode[]): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const table of tables) {
        aliases.set(normalizeErdName(table.fullName), table.fullName);
        aliases.set(normalizeErdName(`${table.schema}.${table.tableName}`), table.fullName);
        const shortName = normalizeErdName(table.tableName);
        if (!aliases.has(shortName)) aliases.set(shortName, table.fullName);
    }
    return aliases;
}

export function resolveErdTableKey(tableName: string, aliases: Map<string, string>): string | undefined {
    return aliases.get(normalizeErdName(tableName));
}

/** Stable across re-renders and independent of the table card's measured height. */
export function erdColumnHandleId(tableKey: string, columnName: string, columnIndex: number): string {
    return `column:${tableKey}:${columnIndex}:${columnName}`;
}

function columnIndex(table: TableNode, name: string): number {
    const normalized = normalizeErdName(name);
    return table.columns.findIndex(column => normalizeErdName(column.name) === normalized);
}

function columnHandle(table: TableNode, columnName: string): string | undefined {
    const index = columnIndex(table, columnName);
    return index >= 0 ? erdColumnHandleId(table.fullName, table.columns[index].name, index) : undefined;
}

function tableMatches(table: TableNode, searchTerm: string): boolean {
    const term = normalizeErdName(searchTerm);
    if (!term) return false;
    return normalizeErdName(table.fullName).includes(term)
        || normalizeErdName(table.tableName).includes(term)
        || table.columns.some(column => normalizeErdName(column.name).includes(term));
}

function columnMatches(column: ColumnInfo, searchTerm: string): boolean {
    const term = normalizeErdName(searchTerm);
    return !!term && (normalizeErdName(column.name).includes(term) || normalizeErdName(column.dataType).includes(term));
}

export function createErdFlowModel(
    data: ERDData,
    positions: Map<string, { x: number; y: number }> = new Map(),
    searchTerm = '',
    highlightedRelationshipId?: string,
): ErdFlowModel {
    const aliases = buildErdTableAliases(data.tables);
    const nodes: ErdFlowNode[] = data.tables.map((table, index) => {
        const fallback = { x: 80 + (index % 4) * 390, y: 80 + Math.floor(index / 4) * 260 };
        const position = positions.get(table.fullName) || fallback;
        const isSearchMatch = tableMatches(table, searchTerm);
        return {
            id: table.fullName,
            type: 'erdTable',
            position,
            width: 330,
            data: {
                table,
                searchTerm,
                isSearchMatch,
                portOrder: table.columns.flatMap((column, columnIndexValue) => [
                    `target:${erdColumnHandleId(table.fullName, column.name, columnIndexValue)}`,
                    `source:${erdColumnHandleId(table.fullName, column.name, columnIndexValue)}`,
                ]),
                miniMapColor: isSearchMatch ? '#4daafc' : '#6b7280',
            },
            className: isSearchMatch ? 'is-search-match' : undefined,
        };
    });

    const missingReferences: ErdMissingReference[] = [];
    const edges: ErdFlowEdge[] = [];
    for (const relationship of data.relationships) {
        const sourceKey = resolveErdTableKey(relationship.fromTable, aliases);
        const targetKey = resolveErdTableKey(relationship.toTable, aliases);
        if (!sourceKey) {
            missingReferences.push({ relationshipId: relationship.constraintName, kind: 'sourceTable', value: relationship.fromTable });
            continue;
        }
        if (!targetKey) {
            missingReferences.push({ relationshipId: relationship.constraintName, kind: 'targetTable', value: relationship.toTable });
            continue;
        }
        const sourceTable = data.tables.find(table => table.fullName === sourceKey);
        const targetTable = data.tables.find(table => table.fullName === targetKey);
        if (!sourceTable || !targetTable) continue;

        const mappingCount = Math.max(relationship.fromColumns.length, relationship.toColumns.length);
        for (let mappingIndex = 0; mappingIndex < mappingCount; mappingIndex += 1) {
            const fromColumn = relationship.fromColumns[mappingIndex];
            const toColumn = relationship.toColumns[mappingIndex];
            const sourceHandle = fromColumn ? columnHandle(sourceTable, fromColumn) : undefined;
            const targetHandle = toColumn ? columnHandle(targetTable, toColumn) : undefined;
            if (!sourceHandle) {
                missingReferences.push({ relationshipId: relationship.constraintName, kind: 'sourceColumn', value: fromColumn || `mapping ${mappingIndex + 1}` });
            }
            if (!targetHandle) {
                missingReferences.push({ relationshipId: relationship.constraintName, kind: 'targetColumn', value: toColumn || `mapping ${mappingIndex + 1}` });
            }
            if (!sourceHandle || !targetHandle) continue;

            const edgeId = `erd:${relationship.constraintName}:${mappingIndex}`;
            const isHighlighted = highlightedRelationshipId === edgeId || highlightedRelationshipId === relationship.constraintName;
            edges.push({
                id: edgeId,
                type: 'orthogonal',
                source: sourceKey,
                target: targetKey,
                sourceHandle,
                targetHandle,
                markerEnd: { type: MarkerType.ArrowClosed, color: '#6aa9d8' },
                data: {
                    variant: 'erd',
                    relationship,
                    mappingIndex,
                    highlighted: isHighlighted,
                    muted: !!highlightedRelationshipId && !isHighlighted,
                    label: mappingCount > 1 ? `${relationship.constraintName} · ${mappingIndex + 1}` : relationship.constraintName,
                },
            });
        }
    }

    return { nodes, edges, missingReferences };
}

export function tableHasMatchingColumn(table: TableNode, searchTerm: string): boolean {
    return table.columns.some(column => columnMatches(column, searchTerm));
}

export function relationshipFlowId(relationship: RelationshipEdge, mappingIndex: number): string {
    return `erd:${relationship.constraintName}:${mappingIndex}`;
}
