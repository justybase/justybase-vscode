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

export type VisualQueryBuilderInboundMessage = VisualQueryBuilderWebviewToHostMessage;
export type VisualQueryBuilderOutboundMessage = VisualQueryBuilderHostToWebviewMessage;

export const VISUAL_QUERY_BUILDER_WEBVIEW_TO_HOST_COMMANDS = [
    'openSql',
    'runSql',
    'loadSchema'
] as const satisfies readonly VisualQueryBuilderWebviewToHostMessage['command'][];

export const VISUAL_QUERY_BUILDER_HOST_TO_WEBVIEW_COMMANDS = [
    'schemaData',
    'loadingState',
    'error'
] as const satisfies readonly VisualQueryBuilderHostToWebviewMessage['command'][];

export const VISUAL_QUERY_BUILDER_INBOUND_COMMANDS = VISUAL_QUERY_BUILDER_WEBVIEW_TO_HOST_COMMANDS;
export const VISUAL_QUERY_BUILDER_OUTBOUND_COMMANDS = VISUAL_QUERY_BUILDER_HOST_TO_WEBVIEW_COMMANDS;