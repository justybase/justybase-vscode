export interface TableDesignerInitialContext {
    dbName: string;
    schemaName: string;
    databaseKind: string;
    targetDisplay: string;
    sqliteKeywords: string[];
}

export interface TableDesignerColumn {
    id: number;
    name: string;
    type: string;
    length: string;
    notNull: boolean;
    pk: boolean;
    distribute: boolean;
    defaultValue: string;
}

export type TableDesignerWebviewToHostMessage =
    | { command: 'executeDDL'; ddl: string }
    | { command: 'saveAsSql'; ddl: string };

export type TableDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'clearError' }
    | { command: 'setExecuting'; executing: boolean };

export type TableDesignerInboundMessage = TableDesignerWebviewToHostMessage;
export type TableDesignerOutboundMessage = TableDesignerHostToWebviewMessage;

export const TABLE_DESIGNER_WEBVIEW_TO_HOST_COMMANDS = [
    'executeDDL',
    'saveAsSql',
] as const satisfies readonly TableDesignerWebviewToHostMessage['command'][];

export const TABLE_DESIGNER_HOST_TO_WEBVIEW_COMMANDS = [
    'setError',
    'clearError',
    'setExecuting',
] as const satisfies readonly TableDesignerHostToWebviewMessage['command'][];

export const TABLE_DESIGNER_INBOUND_COMMANDS = TABLE_DESIGNER_WEBVIEW_TO_HOST_COMMANDS;
export const TABLE_DESIGNER_OUTBOUND_COMMANDS = TABLE_DESIGNER_HOST_TO_WEBVIEW_COMMANDS;
