/**
 * Webview-local copies of visual query builder message contracts.
 */

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
}

export type VisualQueryBuilderWebviewToHostMessage =
    | { command: 'openSql'; sql: string }
    | { command: 'runSql'; sql: string }
    | { command: 'loadSchema'; schema: string };

export type VisualQueryBuilderHostToWebviewMessage =
    | { command: 'schemaData'; payload: VisualQueryBuilderBootstrapState }
    | { command: 'loadingState'; loading: boolean }
    | { command: 'error'; message: string };

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

export interface CanvasPoint {
    x: number;
    y: number;
}

export interface DragState {
    tableId: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
}

export interface ColumnJoinDragState {
    fromTableId: string;
    fromColumn: string;
    startPoint: CanvasPoint;
    currentPoint: CanvasPoint;
}

export interface VisualQueryBuilderState {
    connectionName: string;
    availableSchemas: string[];
    data: VisualQueryBuilderData;
    placedTables: PlacedTable[];
    joins: VisualQueryBuilderJoin[];
    searchTerm: string;
    distinct: boolean;
    whereClause: string;
    groupByClause: string;
    havingClause: string;
    orderByClause: string;
    limitValue: string;
}
