export interface Db2DesignerColumn {
    name: string;
    type: string;
    notNull: boolean;
}

export interface Db2DesignerExistingIndex {
    name: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
    indexType: string;
}

export interface Db2IndexDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    columns: Db2DesignerColumn[];
    existingIndexes: Db2DesignerExistingIndex[];
    tablespaces: string[];
}

export type Db2IndexDesignerWebviewToHostMessage =
    | { command: 'executeDDL'; ddl: string }
    | { command: 'saveAsSql'; ddl: string }
    | { command: 'copyDDL'; ddl: string };

export type Db2IndexDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean };
