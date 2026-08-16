export interface VisualQueryBuilderColumn {
    name: string;
    dataType: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface VisualQueryBuilderTable {
    database: string;
    schema: string;
    tableName: string;
    fullName: string;
    columns: VisualQueryBuilderColumn[];
    primaryKeyColumns: string[];
    /**
     * Source kind in the database catalog. File SQL exposes the imported file
     * and Excel sheets as views, while an editable materialization is a table.
     */
    objectType?: 'TABLE' | 'VIEW';
}

export interface VisualQueryBuilderRelationship {
    constraintName: string;
    fromTable: string;
    toTable: string;
    fromColumns: string[];
    toColumns: string[];
    onDelete: string;
    onUpdate: string;
}

export interface VisualQueryBuilderData {
    database: string;
    schema: string;
    tables: VisualQueryBuilderTable[];
    relationships: VisualQueryBuilderRelationship[];
    allSchemas?: string[];
}

export interface VisualQueryBuilderBootstrapState {
    connectionName: string;
    availableSchemas: string[];
    data: VisualQueryBuilderData;
    /** Persisted design state restored for this connection/schema, if any. */
    state?: VisualQueryBuilderState;
}

export type VisualQueryBuilderWebviewToHostMessage =
    | { command: 'openSql'; sql: string }
    | { command: 'runSql'; sql: string }
    | { command: 'loadSchema'; schema: string }
    | { command: 'saveState'; state: VisualQueryBuilderState };

export type VisualQueryBuilderHostToWebviewMessage =
    | { command: 'schemaData'; payload: VisualQueryBuilderBootstrapState }
    | { command: 'loadingState'; loading: boolean }
    | { command: 'error'; message: string };

export type VisualQueryBuilderInboundMessage = VisualQueryBuilderWebviewToHostMessage;
export type VisualQueryBuilderOutboundMessage = VisualQueryBuilderHostToWebviewMessage;

export type VisualQueryBuilderGridSort = 'ASC' | 'DESC' | 'NONE';

export type VisualQueryBuilderGridAggregate =
    | 'NONE'
    | 'GROUP BY'
    | 'WHERE'
    | 'SUM'
    | 'AVG'
    | 'MIN'
    | 'MAX'
    | 'COUNT'
    | 'COUNT DISTINCT'
    | 'STDDEV'
    | 'VARIANCE'
    | 'EXPRESSION';

export interface VisualQueryBuilderGridColumn {
    id: string;
    tableInstanceId: string;
    columnName: string;
    show: boolean;
    aggregate: VisualQueryBuilderGridAggregate;
    sort: VisualQueryBuilderGridSort;
    criteriaRows: string[];
}

export interface VisualQueryBuilderQueryClauses {
    distinct: boolean;
    whereClause: string;
    groupByClause: string;
    havingClause: string;
    orderByClause: string;
    limitValue: string;
}

export type VisualQueryBuilderJoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
export type VisualQueryBuilderJoinSource = 'manual' | 'relationship';

export interface PlacedTable {
    instanceId: string;
    tableName: string;
    schema: string;
    database: string;
    fullName: string;
    alias: string;
    x: number;
    y: number;
    selectedColumns: string[];
}

export interface VisualQueryBuilderJoin {
    joinId: string;
    leftTableId: string;
    rightTableId: string;
    leftColumns: string[];
    rightColumns: string[];
    joinType: VisualQueryBuilderJoinType;
    source: VisualQueryBuilderJoinSource;
    constraintName: string;
}

/**
 * Persisted design state of the builder: what is on the canvas, how it is
 * joined, and what the Filter & Sort grid and clause inputs contain.
 */
export interface VisualQueryBuilderState {
    placedTables: PlacedTable[];
    joins: VisualQueryBuilderJoin[];
    filterColumns: VisualQueryBuilderGridColumn[];
    clauses: VisualQueryBuilderQueryClauses;
    searchTerm: string;
}

export const VISUAL_QUERY_BUILDER_WEBVIEW_TO_HOST_COMMANDS = [
    'openSql',
    'runSql',
    'loadSchema',
    'saveState'
] as const satisfies readonly VisualQueryBuilderWebviewToHostMessage['command'][];

export const VISUAL_QUERY_BUILDER_HOST_TO_WEBVIEW_COMMANDS = [
    'schemaData',
    'loadingState',
    'error'
] as const satisfies readonly VisualQueryBuilderHostToWebviewMessage['command'][];

export const VISUAL_QUERY_BUILDER_INBOUND_COMMANDS = VISUAL_QUERY_BUILDER_WEBVIEW_TO_HOST_COMMANDS;
export const VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS = VISUAL_QUERY_BUILDER_HOST_TO_WEBVIEW_COMMANDS;
