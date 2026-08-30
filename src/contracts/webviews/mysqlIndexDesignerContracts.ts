export interface MysqlDesignerColumn {
    name: string;
    type: string;
    notNull: boolean;
    ordinal: number;
    defaultValue: string;
    description: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface MysqlDesignerIndexPart {
    name: string;
    expression?: string;
    order: 'ASC' | 'DESC';
    prefixLength?: number;
}

export interface MysqlDesignerExistingIndex {
    name: string;
    parts: MysqlDesignerIndexPart[];
    isUnique: boolean;
    isPrimary: boolean;
    indexType: string;
    cardinality?: number;
    isVisible?: boolean;
    comment?: string;
}

export interface MysqlIndexDesign {
    indexName: string;
    keyColumns: Array<{
        name: string;
        order: 'ASC' | 'DESC';
    }>;
    unique: boolean;
}

export interface MysqlIndexDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    engine: string;
    serverVersion: string;
    supportsDescendingIndexes: boolean;
    columns: MysqlDesignerColumn[];
    existingIndexes: MysqlDesignerExistingIndex[];
}

export type MysqlIndexDesignerWebviewToHostMessage =
    | { command: 'executeDesign'; design: MysqlIndexDesign }
    | { command: 'saveAsSql'; design: MysqlIndexDesign }
    | { command: 'copyDDL'; design: MysqlIndexDesign }
    | { command: 'dropIndex'; indexName: string }
    | { command: 'reload' };

export type MysqlIndexDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean }
    | { command: 'setContext'; context: MysqlIndexDesignerInitialContext };

export type MysqlIndexDesignerInboundMessage = MysqlIndexDesignerWebviewToHostMessage;
export type MysqlIndexDesignerOutboundMessage = MysqlIndexDesignerHostToWebviewMessage;
