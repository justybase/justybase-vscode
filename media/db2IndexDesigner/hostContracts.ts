export interface Db2DesignerColumn {
    name: string;
    type: string;
    notNull: boolean;
    ordinal: number;
    defaultValue: string;
    description: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
}

export interface Db2DesignerIndexColumn {
    name: string;
    order: 'ASC' | 'DESC';
}

export interface Db2DesignerExistingIndex {
    name: string;
    columns: string[];
    columnOrders: Db2DesignerIndexColumn[];
    isUnique: boolean;
    isPrimary: boolean;
    isSystemRequired: boolean;
    indexType: string;
}

export interface Db2IndexDesign {
    indexName: string;
    keyColumns: Db2DesignerIndexColumn[];
    includeColumns: string[];
    unique: boolean;
    clustered: boolean;
    reverseScans?: 'allow' | 'disallow';
    compress?: 'yes' | 'no';
    pctFree?: number;
    level2PctFree?: number;
    minPctUsed?: number;
    pageSplit?: 'symmetric' | 'high';
    collectStatistics?: 'sampled' | 'detailed';
    tablespace?: string;
    additionalClause?: string;
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
    | { command: 'executeDesign'; design: Db2IndexDesign }
    | { command: 'saveAsSql'; design: Db2IndexDesign }
    | { command: 'copyDDL'; design: Db2IndexDesign }
    | { command: 'dropIndex'; indexName: string };

export type Db2IndexDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean };
