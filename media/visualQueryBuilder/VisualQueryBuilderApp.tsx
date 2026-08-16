import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEvent,
    type DragEvent,
    type ReactElement,
} from 'react';
import {
    applyEdgeChanges,
    applyNodeChanges,
    MarkerType,
    ReactFlowProvider,
    useReactFlow,
    type Connection,
    type Edge,
    type EdgeChange,
    type Node,
    type NodeChange,
} from '@xyflow/react';
import { DiagramCanvas } from '../diagram/DiagramCanvas.js';
import { DiagramInspector } from '../diagram/DiagramInspector.js';
import { DiagramToolbar } from '../diagram/DiagramToolbar.js';
import { OrthogonalEdge } from '../diagram/OrthogonalEdge.js';
import type { DiagramEdgeData } from '../diagram/types.js';
import { layoutWithElk } from '../diagram/elkLayout.js';
import { FilterSortGrid } from './FilterSortGrid.js';
import {
    buildGridSqlParts,
    GRID_CRITERIA_ROWS,
    moveGridColumn,
    normalizeGridColumn,
    quoteIdentifier,
    type GridSqlParts,
    type QueryGridColumn,
} from './filterSort.js';
import type {
    PlacedTable,
    VisualQueryBuilderBootstrapState,
    VisualQueryBuilderData,
    VisualQueryBuilderHostToWebviewMessage,
    VisualQueryBuilderJoin,
    VisualQueryBuilderJoinSource,
    VisualQueryBuilderJoinType,
    VisualQueryBuilderTable,
    VisualQueryBuilderWebviewToHostMessage,
} from './hostContracts.js';
import { asHostMessage, postToHost } from './protocol.js';
import {
    getVisualQueryBuilderColumnFromHandle,
    VisualQueryBuilderSourceNode,
} from './VisualQueryBuilderSourceNode.js';

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

interface VisualQueryBuilderEdgeData extends DiagramEdgeData {
    join: VisualQueryBuilderJoin;
}

type VisualQueryBuilderFlowEdge = Edge<VisualQueryBuilderEdgeData, 'orthogonal'>;

interface QueryClauses {
    distinct: boolean;
    whereClause: string;
    groupByClause: string;
    havingClause: string;
    orderByClause: string;
    limitValue: string;
}

const nodeTypes = { querySource: VisualQueryBuilderSourceNode };
const edgeTypes = { orthogonal: OrthogonalEdge };
const VISUAL_QUERY_BUILDER_NODE_WIDTH = 380;
const EMPTY_DATA: VisualQueryBuilderData = {
    database: '',
    schema: '',
    tables: [],
    relationships: [],
    allSchemas: [],
};

/**
 * Computes the next free numeric id suffix for a list of T1/F1/J1-style ids,
 * so restored state never collides with newly created items.
 */
function nextCounterValue(
    items: readonly { instanceId?: string; id?: string; joinId?: string }[] | undefined,
    key: 'instanceId' | 'id' | 'joinId' = 'instanceId',
): number {
    const max = (items || []).reduce((highest, item) => {
        const numeric = Number.parseInt(String(item[key]).slice(1), 10);
        return Number.isFinite(numeric) && numeric > highest ? numeric : highest;
    }, 0);
    return max + 1;
}
const EMPTY_CLAUSES: QueryClauses = {
    distinct: false,
    whereClause: '',
    groupByClause: '',
    havingClause: '',
    orderByClause: '',
    limitValue: '',
};

function normalizeData(data: VisualQueryBuilderData | undefined): VisualQueryBuilderData {
    return {
        database: String(data?.database || '').toUpperCase(),
        schema: String(data?.schema || '').toUpperCase(),
        tables: Array.isArray(data?.tables) ? data.tables : [],
        relationships: Array.isArray(data?.relationships) ? data.relationships : [],
        allSchemas: Array.isArray(data?.allSchemas) ? data.allSchemas : [],
    };
}

function qualifySource(table: PlacedTable): string {
    return `${quoteIdentifier(table.database)}.${quoteIdentifier(table.schema)}.${quoteIdentifier(table.tableName)}`;
}

function sanitizeAlias(value: string): string {
    const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!normalized) return 'T1';
    return /^[A-Z_]/.test(normalized) ? normalized : `T_${normalized}`;
}

function joinSignature(join: Pick<VisualQueryBuilderJoin, 'leftTableId' | 'rightTableId' | 'leftColumns' | 'rightColumns'>): string {
    return [
        join.leftTableId,
        join.rightTableId,
        join.leftColumns.join('|').toUpperCase(),
        join.rightColumns.join('|').toUpperCase(),
    ].join('::');
}

function normalizeJoinType(value: string): VisualQueryBuilderJoinType {
    return value === 'LEFT' || value === 'RIGHT' || value === 'FULL' ? value : 'INNER';
}

function splitQualifiedName(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"') {
            current += character;
            if (quoted && value[index + 1] === '"') {
                current += value[index + 1];
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === '.' && !quoted) {
            parts.push(current.trim());
            current = '';
        } else {
            current += character;
        }
    }
    parts.push(current.trim());
    return parts;
}

function normalizeNamePart(value: string): string {
    const trimmed = value.trim();
    const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).replace(/""/g, '"')
        : trimmed;
    return unquoted.toUpperCase();
}

export function sourceMatchesRelationship(value: string, table: PlacedTable): boolean {
    const parts = splitQualifiedName(value);
    if (parts.length < 2) return false;
    return normalizeNamePart(parts[parts.length - 2]) === normalizeNamePart(table.schema)
        && normalizeNamePart(parts[parts.length - 1]) === normalizeNamePart(table.tableName);
}

function reverseJoinType(joinType: VisualQueryBuilderJoinType): VisualQueryBuilderJoinType {
    if (joinType === 'LEFT') return 'RIGHT';
    if (joinType === 'RIGHT') return 'LEFT';
    return joinType;
}

export function generateQuerySql(
    placedTables: PlacedTable[],
    joins: VisualQueryBuilderJoin[],
    clauses: QueryClauses,
    gridParts: GridSqlParts,
): string {
    if (placedTables.length === 0) {
        return '-- Drag sources to the canvas and select columns to generate SQL.';
    }

    const baseSource = placedTables[0];
    const selectedColumns = placedTables.flatMap(source => source.selectedColumns.map(
        column => `${quoteIdentifier(source.alias)}.${quoteIdentifier(column)}`,
    ));
    const gridSelect = gridParts.select.trim();
    const selectList = gridSelect || (selectedColumns.length > 0
        ? selectedColumns.join(',\n    ')
        : `${quoteIdentifier(baseSource.alias)}.*`);
    const pending = [...joins];
    const joinedSourceIds = new Set([baseSource.instanceId]);
    const joinClauses: string[] = [];
    const extraPredicates: string[] = [];

    const conditionFor = (join: VisualQueryBuilderJoin, left: PlacedTable, right: PlacedTable): string => join.leftColumns
        .slice(0, Math.min(join.leftColumns.length, join.rightColumns.length))
        .map((leftColumn, index) => `${quoteIdentifier(left.alias)}.${quoteIdentifier(leftColumn)} = ${quoteIdentifier(right.alias)}.${quoteIdentifier(join.rightColumns[index])}`)
        .join(' AND ');

    let progressed = true;
    while (progressed && pending.length > 0) {
        progressed = false;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
            const join = pending[index];
            const left = placedTables.find(table => table.instanceId === join.leftTableId);
            const right = placedTables.find(table => table.instanceId === join.rightTableId);
            if (!left || !right) {
                pending.splice(index, 1);
                progressed = true;
                continue;
            }
            const leftIn = joinedSourceIds.has(left.instanceId);
            const rightIn = joinedSourceIds.has(right.instanceId);
            if (!leftIn && !rightIn) continue;
            const condition = conditionFor(join, left, right);
            if (!condition) {
                pending.splice(index, 1);
                progressed = true;
                continue;
            }
            if (leftIn && rightIn) {
                extraPredicates.push(condition);
            } else {
                const target = leftIn ? right : left;
                const joinType = leftIn ? join.joinType : reverseJoinType(join.joinType);
                joinClauses.push(`${joinType} JOIN ${qualifySource(target)} AS ${quoteIdentifier(target.alias)} ON ${condition}`);
                joinedSourceIds.add(target.instanceId);
            }
            pending.splice(index, 1);
            progressed = true;
        }
    }

    for (const join of pending) {
        const left = placedTables.find(table => table.instanceId === join.leftTableId);
        const right = placedTables.find(table => table.instanceId === join.rightTableId);
        if (left && right) {
            const condition = conditionFor(join, left, right);
            if (condition) extraPredicates.push(condition);
        }
    }

    const sql = [
        clauses.distinct ? 'SELECT DISTINCT' : 'SELECT',
        `    ${selectList}`,
        `FROM ${qualifySource(baseSource)} AS ${quoteIdentifier(baseSource.alias)}`,
        ...joinClauses,
    ];
    for (const source of placedTables) {
        if (!joinedSourceIds.has(source.instanceId)) {
            sql.push(`CROSS JOIN ${qualifySource(source)} AS ${quoteIdentifier(source.alias)}`);
        }
    }
    const wherePredicates = [gridParts.where.trim() || clauses.whereClause.trim(), ...extraPredicates]
        .filter(Boolean)
        .map(predicate => `(${predicate})`);
    if (wherePredicates.length > 0) sql.push(`WHERE ${wherePredicates.join('\n  AND ')}`);
    if (gridParts.groupBy.trim()) {
        sql.push(`GROUP BY ${gridParts.groupBy.trim()}`);
    } else if (clauses.groupByClause.trim()) {
        sql.push(`GROUP BY ${clauses.groupByClause.trim()}`);
    }
    if (gridParts.having.trim()) {
        sql.push(`HAVING ${gridParts.having.trim()}`);
    } else if (clauses.havingClause.trim()) {
        sql.push(`HAVING ${clauses.havingClause.trim()}`);
    }
    if (gridParts.orderBy.trim()) {
        sql.push(`ORDER BY ${gridParts.orderBy.trim()}`);
    } else if (clauses.orderByClause.trim()) {
        sql.push(`ORDER BY ${clauses.orderByClause.trim()}`);
    }
    const limit = Number(clauses.limitValue);
    if (Number.isFinite(limit) && limit > 0) sql.push(`LIMIT ${Math.floor(limit)}`);
    return `${sql.join('\n')};`;
}

function QueryBuilderInner({ initialState }: { initialState: VisualQueryBuilderBootstrapState }): ReactElement {
    const reactFlow = useReactFlow();
    const savedState = initialState.state;
    const [connectionName, setConnectionName] = useState(initialState.connectionName || '');
    const [availableSchemas, setAvailableSchemas] = useState(initialState.availableSchemas || []);
    const [data, setData] = useState(() => normalizeData(initialState.data));
    const [placedTables, setPlacedTables] = useState<PlacedTable[]>(() => savedState?.placedTables || []);
    const [joins, setJoins] = useState<VisualQueryBuilderJoin[]>(() => savedState?.joins || []);
    const [clauses, setClauses] = useState<QueryClauses>(() => savedState?.clauses
        ? { ...EMPTY_CLAUSES, ...savedState.clauses }
        : EMPTY_CLAUSES);
    const [filterColumns, setFilterColumns] = useState<QueryGridColumn[]>(() => (savedState?.filterColumns || [])
        .map(column => normalizeGridColumn(column)));
    const [searchTerm, setSearchTerm] = useState(savedState?.searchTerm || '');
    const [selectedSchema, setSelectedSchema] = useState(initialState.data.schema || initialState.availableSchemas[0] || '');
    const [selectedSourceId, setSelectedSourceId] = useState<string>();
    const [selectedJoinId, setSelectedJoinId] = useState<string>();
    const [showGrid, setShowGrid] = useState(true);
    const [isLoading, setIsLoading] = useState(false);
    const [isArranging, setIsArranging] = useState(false);
    const [status, setStatus] = useState('');
    const [manualLeftId, setManualLeftId] = useState('');
    const [manualRightId, setManualRightId] = useState('');
    const [manualLeftColumn, setManualLeftColumn] = useState('');
    const [manualRightColumn, setManualRightColumn] = useState('');
    const [manualJoinType, setManualJoinType] = useState<VisualQueryBuilderJoinType>('INNER');
    const sourceCounter = useRef(nextCounterValue(savedState?.placedTables));
    const joinCounter = useRef(nextCounterValue(savedState?.joins, 'joinId'));
    const filterColumnCounter = useRef(nextCounterValue(savedState?.filterColumns, 'id'));
    const sqlPreviewRef = useRef<HTMLTextAreaElement>(null);

    const getTableDefinition = useCallback((source: PlacedTable): VisualQueryBuilderTable | undefined => data.tables.find(table =>
        table.fullName === source.fullName
        || (table.database === source.database && table.schema === source.schema && table.tableName === source.tableName),
    ), [data.tables]);

    const updateAlias = useCallback((sourceId: string, rawAlias: string): void => {
        setPlacedTables(current => {
            const used = new Set(current.filter(source => source.instanceId !== sourceId).map(source => source.alias.toUpperCase()));
            const base = sanitizeAlias(rawAlias);
            let alias = base;
            let suffix = 2;
            while (used.has(alias)) alias = `${base}_${suffix++}`;
            return current.map(source => source.instanceId === sourceId ? { ...source, alias } : source);
        });
    }, []);

    const toggleColumn = useCallback((sourceId: string, columnName: string, selected: boolean): void => {
        setPlacedTables(current => current.map(source => {
            if (source.instanceId !== sourceId) return source;
            const selectedColumns = selected
                ? [...new Set([...source.selectedColumns, columnName])]
                : source.selectedColumns.filter(column => column !== columnName);
            return { ...source, selectedColumns };
        }));
    }, []);

    const removeSource = useCallback((sourceId: string): void => {
        setPlacedTables(current => current.filter(source => source.instanceId !== sourceId));
        setJoins(current => current.filter(join => join.leftTableId !== sourceId && join.rightTableId !== sourceId));
        setFilterColumns(current => current.filter(column => column.tableInstanceId !== sourceId));
        setSelectedSourceId(current => current === sourceId ? undefined : current);
    }, []);

    const addFilterColumn = useCallback((field?: { tableInstanceId: string; columnName: string }): void => {
        setFilterColumns(current => [...current, {
            id: `F${filterColumnCounter.current++}`,
            tableInstanceId: field?.tableInstanceId ?? '',
            columnName: field?.columnName ?? '',
            show: true,
            aggregate: 'NONE',
            sort: 'NONE',
            criteriaRows: Array.from({ length: GRID_CRITERIA_ROWS }, () => ''),
        }]);
    }, []);

    const moveFilterColumn = useCallback((columnId: string, delta: -1 | 1): void => {
        setFilterColumns(current => moveGridColumn(current, columnId, delta));
    }, []);

    const updateFilterColumn = useCallback((columnId: string, patch: Partial<Omit<QueryGridColumn, 'id'>>): void => {
        setFilterColumns(current => current.map(column => column.id === columnId ? { ...column, ...patch } : column));
    }, []);

    const removeFilterColumn = useCallback((columnId: string): void => {
        setFilterColumns(current => current.filter(column => column.id !== columnId));
    }, []);

    const clearFilterColumns = useCallback((): void => {
        setFilterColumns([]);
    }, []);

    const createJoin = useCallback((
        leftTableId: string,
        rightTableId: string,
        leftColumns: string[],
        rightColumns: string[],
        joinType: VisualQueryBuilderJoinType,
        source: VisualQueryBuilderJoinSource,
        constraintName = '',
    ): void => {
        if (!leftTableId || !rightTableId || leftTableId === rightTableId || !leftColumns[0] || !rightColumns[0]) return;
        setJoins(current => {
            const next: VisualQueryBuilderJoin = {
                joinId: `J${joinCounter.current++}`,
                leftTableId,
                rightTableId,
                leftColumns,
                rightColumns,
                joinType,
                source,
                constraintName,
            };
            return current.some(existing => joinSignature(existing) === joinSignature(next)) ? current : [...current, next];
        });
    }, []);

    const addSource = useCallback((table: VisualQueryBuilderTable, position?: { x: number; y: number }): void => {
        const prefix = table.tableName.match(/[A-Za-z]/)?.[0]?.toUpperCase() || 'T';
        const usedAliases = new Set(placedTables.map(source => source.alias.toUpperCase()));
        let suffix = 1;
        let alias = `${prefix}${suffix}`;
        while (usedAliases.has(alias)) alias = `${prefix}${++suffix}`;
        const source: PlacedTable = {
            instanceId: `T${sourceCounter.current++}`,
            tableName: table.tableName,
            schema: table.schema,
            database: table.database,
            fullName: table.fullName,
            alias,
            x: position?.x ?? 80 + placedTables.length * 36,
            y: position?.y ?? 80 + placedTables.length * 30,
            selectedColumns: [],
        };
        setPlacedTables(current => [...current, source]);
        for (const other of placedTables) {
            for (const relationship of data.relationships) {
                if (sourceMatchesRelationship(relationship.fromTable, source) && sourceMatchesRelationship(relationship.toTable, other)) {
                    createJoin(source.instanceId, other.instanceId, relationship.fromColumns, relationship.toColumns, 'INNER', 'relationship', relationship.constraintName);
                } else if (sourceMatchesRelationship(relationship.fromTable, other) && sourceMatchesRelationship(relationship.toTable, source)) {
                    createJoin(other.instanceId, source.instanceId, relationship.fromColumns, relationship.toColumns, 'INNER', 'relationship', relationship.constraintName);
                }
            }
        }
    }, [createJoin, data.relationships, placedTables]);

    const modelNodes = useMemo<VisualQueryBuilderFlowNode[]>(() => placedTables.flatMap((source, index) => {
        const table = getTableDefinition(source);
        if (!table) return [];
        const matchesSearch = !searchTerm || `${table.tableName} ${table.schema} ${table.objectType || 'TABLE'}`.toUpperCase().includes(searchTerm.toUpperCase());
        return [{
            id: source.instanceId,
            type: 'querySource',
            position: { x: source.x || 80 + index * 36, y: source.y || 80 + index * 30 },
            width: VISUAL_QUERY_BUILDER_NODE_WIDTH,
            data: {
                placed: source,
                table,
                onAliasChange: updateAlias,
                onRemove: removeSource,
                onColumnSelectionChange: toggleColumn,
                onAddFilterField: (tableId, columnName) => addFilterColumn({ tableInstanceId: tableId, columnName }),
                miniMapColor: table.objectType === 'VIEW' ? '#9a8ac7' : '#4daafc',
            },
            hidden: !matchesSearch && searchTerm.length > 0,
        }];
    }), [addFilterColumn, getTableDefinition, placedTables, removeSource, searchTerm, toggleColumn, updateAlias]);

    const modelEdges = useMemo<VisualQueryBuilderFlowEdge[]>(() => joins.map(join => ({
        id: join.joinId,
        type: 'orthogonal',
        source: join.leftTableId,
        target: join.rightTableId,
        sourceHandle: `column:${join.leftColumns[0]}`,
        targetHandle: `column:${join.rightColumns[0]}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: join.source === 'relationship' ? '#64c68a' : '#6aa9d8' },
        data: {
            join,
            label: join.joinType,
            variant: join.source === 'relationship' ? 'success' : 'erd',
            highlighted: selectedJoinId === join.joinId,
            muted: !!selectedJoinId && selectedJoinId !== join.joinId,
        },
    })), [joins, selectedJoinId]);

    const [nodes, setNodes] = useState<VisualQueryBuilderFlowNode[]>(modelNodes);
    const [edges, setEdges] = useState<VisualQueryBuilderFlowEdge[]>(modelEdges);
    useEffect(() => setNodes(modelNodes), [modelNodes]);
    useEffect(() => setEdges(modelEdges), [modelEdges]);

    useEffect(() => {
        const receiveMessage = (event: MessageEvent<unknown>): void => {
            const message: VisualQueryBuilderHostToWebviewMessage = asHostMessage(event.data);
            switch (message.command) {
                case 'schemaData': {
                    setConnectionName(message.payload.connectionName);
                    setAvailableSchemas(message.payload.availableSchemas || []);
                    setData(normalizeData(message.payload.data));
                    setSelectedSchema(message.payload.data.schema || message.payload.availableSchemas[0] || '');
                    // The current design is kept across metadata reloads so
                    // in-flight edits survive; stale table references are
                    // dropped gracefully by the source/column resolvers.
                    setStatus('Sources reloaded');
                    return;
                }
                case 'loadingState':
                    setIsLoading(message.loading);
                    return;
                case 'error':
                    setStatus(`Error: ${message.message}`);
                    return;
            }
        };
        window.addEventListener('message', receiveMessage);
        return () => window.removeEventListener('message', receiveMessage);
    }, []);

    // The debounced save always runs so clearing the design also clears the
    // persisted snapshot instead of leaving a stale one behind.
    useEffect(() => {
        const handle = window.setTimeout(() => {
            postToHost({
                command: 'saveState',
                state: { placedTables, joins, filterColumns, clauses, searchTerm },
            } satisfies VisualQueryBuilderWebviewToHostMessage);
        }, 500);
        return () => window.clearTimeout(handle);
    }, [clauses, filterColumns, joins, placedTables, searchTerm]);

    const handleNodesChange = useCallback((changes: NodeChange[]): void => {
        setNodes(current => applyNodeChanges(changes, current) as VisualQueryBuilderFlowNode[]);
    }, []);
    const handleEdgesChange = useCallback((changes: EdgeChange[]): void => {
        setEdges(current => applyEdgeChanges(changes, current) as VisualQueryBuilderFlowEdge[]);
    }, []);
    const handleConnect = useCallback((connection: Connection): void => {
        const sourceColumn = getVisualQueryBuilderColumnFromHandle(connection.sourceHandle);
        const targetColumn = getVisualQueryBuilderColumnFromHandle(connection.targetHandle);
        if (connection.source && connection.target && sourceColumn && targetColumn) {
            createJoin(connection.source, connection.target, [sourceColumn], [targetColumn], 'INNER', 'manual');
        }
    }, [createJoin]);
    const handleDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        const fullName = event.dataTransfer.getData('application/x-visual-query-builder-source');
        const table = data.tables.find(candidate => candidate.fullName === fullName);
        if (table) addSource(table, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }, [addSource, data.tables, reactFlow]);
    const handleAutoArrange = useCallback(async (): Promise<void> => {
        if (isArranging) return;
        setIsArranging(true);
        const result = await layoutWithElk(nodes, edges, { direction: 'RIGHT', nodeWidth: VISUAL_QUERY_BUILDER_NODE_WIDTH, nodeHeight: 220 });
        setNodes(current => current.map(node => ({ ...node, position: result.positions.get(node.id) || node.position })));
        setPlacedTables(current => current.map(source => {
            const position = result.positions.get(source.instanceId);
            return position ? { ...source, x: position.x, y: position.y } : source;
        }));
        setStatus(result.usedFallback ? 'ELK layout unavailable; retained current positions' : 'Sources arranged');
        setIsArranging(false);
    }, [edges, isArranging, nodes]);

    const selectedSource = selectedSourceId ? placedTables.find(source => source.instanceId === selectedSourceId) : undefined;
    const selectedJoin = selectedJoinId ? joins.find(join => join.joinId === selectedJoinId) : undefined;
    const leftSource = placedTables.find(source => source.instanceId === manualLeftId);
    const rightSource = placedTables.find(source => source.instanceId === manualRightId);
    const gridParts = useMemo(() => buildGridSqlParts(filterColumns, placedTables), [filterColumns, placedTables]);
    const sql = useMemo(() => generateQuerySql(placedTables, joins, clauses, gridParts),
        [clauses, gridParts, joins, placedTables]);
    // The grid wins over the manual inspector clauses; surface that instead of
    // silently replacing the user's text in the generated SQL.
    const gridOverridesManual = {
        groupBy: Boolean(gridParts.groupBy.trim() && clauses.groupByClause.trim()),
        having: Boolean(gridParts.having.trim() && clauses.havingClause.trim()),
    };
    const filteredSources = useMemo(() => data.tables.filter(source => `${source.tableName} ${source.schema} ${source.objectType || 'TABLE'}`
        .toUpperCase().includes(searchTerm.toUpperCase())), [data.tables, searchTerm]);
    const sourcesBySchema = useMemo(() => filteredSources.reduce<Map<string, VisualQueryBuilderTable[]>>((bySchema, source) => {
        const schema = source.schema || data.schema || 'DEFAULT';
        bySchema.set(schema, [...(bySchema.get(schema) || []), source]);
        return bySchema;
    }, new Map()), [data.schema, filteredSources]);

    const setClause = (name: keyof QueryClauses) => (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
        setClauses(current => ({ ...current, [name]: name === 'distinct' ? (event.target as HTMLInputElement).checked : event.target.value }));
    };
    const copySql = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(sql);
        } catch {
            // VS Code webviews may not expose clipboard permissions. The host
            // action remains available, and this fallback is harmless in older
            // webview runtimes.
            const preview = sqlPreviewRef.current;
            if (preview) {
                preview.focus();
                preview.select();
                document.execCommand('copy');
                preview.setSelectionRange(0, 0);
            }
        }
        setStatus('SQL copied to clipboard');
    };

    const inspector = (
        <DiagramInspector
            title={selectedSource?.tableName || selectedJoin?.constraintName || 'Query controls'}
            eyebrow={selectedSource ? 'SOURCE' : selectedJoin ? 'JOIN' : 'QUERY'}
            onClose={() => { setSelectedSourceId(undefined); setSelectedJoinId(undefined); }}
        >
            <div className="vqb-inspector-content">
                {selectedJoin && <section className="vqb-section">
                    <h3>{selectedJoin.leftColumns.join(', ')} → {selectedJoin.rightColumns.join(', ')}</h3>
                    <select value={selectedJoin.joinType} onChange={event => setJoins(current => current.map(join => join.joinId === selectedJoin.joinId ? { ...join, joinType: normalizeJoinType(event.target.value) } : join))}>
                        {['INNER', 'LEFT', 'RIGHT', 'FULL'].map(type => <option key={type} value={type}>{type} JOIN</option>)}
                    </select>
                    <button className="diagram-button" onClick={() => setJoins(current => current.filter(join => join.joinId !== selectedJoin.joinId))} type="button">Remove join</button>
                </section>}
                <section className="vqb-section">
                    <label className="vqb-checkbox"><input checked={clauses.distinct} onChange={setClause('distinct')} type="checkbox" />SELECT DISTINCT</label>
                </section>
                <section className="vqb-section">
                    <h3>Manual join</h3>
                    <select value={manualLeftId} onChange={event => { setManualLeftId(event.target.value); setManualLeftColumn(''); }}><option value="">Left source</option>{placedTables.map(source => <option key={source.instanceId} value={source.instanceId}>{source.alias} ({source.tableName})</option>)}</select>
                    <select value={manualLeftColumn} onChange={event => setManualLeftColumn(event.target.value)}><option value="">Left column</option>{leftSource && getTableDefinition(leftSource)?.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select>
                    <select value={manualJoinType} onChange={event => setManualJoinType(normalizeJoinType(event.target.value))}>{['INNER', 'LEFT', 'RIGHT', 'FULL'].map(type => <option key={type} value={type}>{type} JOIN</option>)}</select>
                    <select value={manualRightId} onChange={event => { setManualRightId(event.target.value); setManualRightColumn(''); }}><option value="">Right source</option>{placedTables.map(source => <option key={source.instanceId} value={source.instanceId}>{source.alias} ({source.tableName})</option>)}</select>
                    <select value={manualRightColumn} onChange={event => setManualRightColumn(event.target.value)}><option value="">Right column</option>{rightSource && getTableDefinition(rightSource)?.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select>
                    <button className="diagram-button" disabled={!manualLeftColumn || !manualRightColumn || manualLeftId === manualRightId} onClick={() => createJoin(manualLeftId, manualRightId, [manualLeftColumn], [manualRightColumn], manualJoinType, 'manual')} type="button">Add join</button>
                </section>
                <section className="vqb-section"><h3>Selected columns</h3>{placedTables.some(source => source.selectedColumns.length > 0)
                    ? placedTables.flatMap(source => source.selectedColumns.map(column => <div className="vqb-selected-column" key={`${source.instanceId}:${column}`}>{source.alias}.{column}</div>))
                    : <p className="diagram-muted">No columns selected. The query uses the first source.*</p>}</section>
                <section className="vqb-section"><h3>GROUP BY</h3><textarea onChange={setClause('groupByClause')} value={clauses.groupByClause} />{gridOverridesManual.groupBy && <p className="diagram-muted">Overridden by the filter grid Total column</p>}</section>
                <section className="vqb-section"><h3>HAVING</h3><textarea onChange={setClause('havingClause')} value={clauses.havingClause} />{gridOverridesManual.having && <p className="diagram-muted">Overridden by the filter grid criteria</p>}</section>
                <section className="vqb-section"><h3>LIMIT</h3><input min="1" onChange={setClause('limitValue')} type="number" value={clauses.limitValue} /></section>
                <section className="vqb-section"><h3>SQL preview</h3><textarea className="vqb-sql-preview" ref={sqlPreviewRef} readOnly value={sql} /><div className="vqb-action-row"><button className="diagram-button" onClick={() => { void copySql(); }} type="button">Copy</button><button className="diagram-button" onClick={() => postToHost({ command: 'openSql', sql } satisfies VisualQueryBuilderWebviewToHostMessage)} type="button">Open</button><button className="diagram-button diagram-button-primary" onClick={() => postToHost({ command: 'runSql', sql } satisfies VisualQueryBuilderWebviewToHostMessage)} type="button">Run</button></div></section>
            </div>
        </DiagramInspector>
    );

    return (
        <div className="diagram-app visual-query-builder">
            <DiagramToolbar
                leading={<div className="diagram-title-block"><div className="diagram-eyebrow">VISUAL QUERY BUILDER</div><strong>{data.database} · {data.schema || 'all schemas'}</strong><div className="vqb-schema-picker"><label htmlFor="vqb-schema">Schema</label><select disabled={isLoading} id="vqb-schema" onChange={event => setSelectedSchema(event.target.value)} value={selectedSchema}>{availableSchemas.map(schema => <option key={schema} value={schema}>{schema}</option>)}</select><button className="diagram-button" disabled={isLoading || !selectedSchema} onClick={() => postToHost({ command: 'loadSchema', schema: selectedSchema })} type="button">Reload</button></div></div>}
                onAutoArrange={() => { void handleAutoArrange(); }}
                onFitView={() => { void reactFlow.fitView({ padding: 0.16, duration: 180, maxZoom: 1.1 }); }}
                onResetView={() => { void reactFlow.setViewport({ x: 24, y: 24, zoom: 1 }, { duration: 180 }); }}
                onToggleGrid={() => setShowGrid(value => !value)}
                onZoomIn={() => { void reactFlow.zoomIn({ duration: 120 }); }}
                onZoomOut={() => { void reactFlow.zoomOut({ duration: 120 }); }}
                gridEnabled={showGrid}
                onSearchChange={setSearchTerm}
                searchPlaceholder="Filter sources"
                searchValue={searchTerm}
                trailing={<button className="diagram-button" onClick={() => { setPlacedTables([]); setJoins([]); setFilterColumns([]); setClauses(EMPTY_CLAUSES); setSearchTerm(''); setStatus('Canvas cleared'); }} type="button">Clear canvas</button>}
            />
            <div className="diagram-main">
                <aside className="diagram-side-panel vqb-palette" aria-label="Sources">
                    <h2>Sources</h2>
                    <p>Drag a source to the canvas or double-click to add it. Connect column handles to create a manual JOIN.</p>
                    {Array.from(sourcesBySchema.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([schema, sources]) => <div className="vqb-source-group" key={schema}><h3>{schema}</h3>{sources.map(source => <button className="diagram-toolbox-item" draggable key={source.fullName} onDoubleClick={() => addSource(source)} onDragStart={event => event.dataTransfer.setData('application/x-visual-query-builder-source', source.fullName)} type="button"><span className="erd-card-icon">{source.objectType === 'VIEW' ? '◫' : '▦'}</span><span><strong>{source.tableName}</strong><small>{source.objectType || 'TABLE'} · {source.columns.length} columns</small></span></button>)}</div>)}
                    {filteredSources.length === 0 && <p className="diagram-muted">No matching sources.</p>}
                </aside>
                <div className="diagram-canvas-column">
                    <DiagramCanvas
                        connectable
                        edgeTypes={edgeTypes}
                        edges={edges}
                        minimap
                        nodeTypes={nodeTypes}
                        nodes={nodes}
                        onConnect={handleConnect}
                        onDragOver={event => event.preventDefault()}
                        onDrop={handleDrop}
                        onEdgeClick={(_event, edge) => { setSelectedJoinId(edge.id); setSelectedSourceId(undefined); }}
                        onEdgesChange={handleEdgesChange}
                        onNodeClick={(_event, node) => { setSelectedSourceId(node.id); setSelectedJoinId(undefined); }}
                        onNodeDragStop={(_event, node) => setPlacedTables(current => current.map(source => source.instanceId === node.id ? { ...source, x: node.position.x, y: node.position.y } : source))}
                        onNodesChange={handleNodesChange}
                        onPaneClick={() => { setSelectedSourceId(undefined); setSelectedJoinId(undefined); }}
                        showGrid={showGrid}
                    />
                    <FilterSortGrid
                        columns={filterColumns}
                        getTable={getTableDefinition}
                        onAddColumn={addFilterColumn}
                        onClearColumns={clearFilterColumns}
                        onMoveColumn={moveFilterColumn}
                        onRemoveColumn={removeFilterColumn}
                        onUpdateColumn={updateFilterColumn}
                        placedTables={placedTables}
                    />
                </div>
                {inspector}
            </div>
            <div className="diagram-status-bar"><span>{data.tables.length} sources</span><span>{data.relationships.length} relationships</span><span>{placedTables.length} on canvas</span>{isArranging && <span>Arranging…</span>}{status && <span>{status}</span>}<span className="diagram-toolbar-spacer" /><span>{connectionName}</span></div>
            {data.tables.length === 0 && <div className="diagram-empty-state"><strong>No sources were found.</strong><span>Reload metadata or select another schema.</span></div>}
        </div>
    );
}

export function VisualQueryBuilderApp({ initialState }: { initialState?: VisualQueryBuilderBootstrapState }): ReactElement {
    const state = initialState || { connectionName: '', availableSchemas: [], data: EMPTY_DATA };
    return <ReactFlowProvider><QueryBuilderInner initialState={state} /></ReactFlowProvider>;
}
