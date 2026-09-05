import type {
    PostgresqlAlterTableDesignerColumn,
} from '../postgresqlAlterTableDesigner/hostContracts.js';

export type { PostgresqlAlterTableDesignerColumn };

export type PostgresqlIndexMethod = 'btree' | 'hash' | 'gist' | 'spgist' | 'gin' | 'brin';

export interface PostgresqlIndexPart {
    name: string;
    order: 'ASC' | 'DESC';
    nulls: 'FIRST' | 'LAST';
}

export interface PostgresqlExistingIndex {
    name: string;
    keyParts: PostgresqlIndexPart[];
    includeParts: string[];
    isUnique: boolean;
    isPrimary: boolean;
    method: string;
    tablespace: string;
    predicate: string;
}

export interface PostgresqlIndexDesign {
    indexName: string;
    method: PostgresqlIndexMethod;
    unique: boolean;
    keyColumns: PostgresqlIndexPart[];
    includeColumns: string[];
    predicate: string;
    tablespace: string;
}

export interface PostgresqlIndexDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    columns: PostgresqlAlterTableDesignerColumn[];
    existingIndexes: PostgresqlExistingIndex[];
    tablespaces: string[];
}

export type PostgresqlIndexDesignerWebviewToHostMessage =
    | { command: 'executeDesign'; design: PostgresqlIndexDesign }
    | { command: 'saveAsSql'; design: PostgresqlIndexDesign }
    | { command: 'copyDDL'; design: PostgresqlIndexDesign }
    | { command: 'dropIndex'; indexName: string }
    | { command: 'reload' };

export type PostgresqlIndexDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean }
    | { command: 'setContext'; context: PostgresqlIndexDesignerInitialContext };