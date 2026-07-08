/**
 * Webview-local copies of table designer message contracts.
 */

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
