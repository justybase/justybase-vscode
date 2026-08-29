import type { Db2DesignerColumn } from './db2IndexDesignerContracts';

export interface Db2DesignerPartition {
    name: string;
    lowValue: string;
    highValue: string;
    lowInclusive: boolean;
    highInclusive: boolean;
    tablespace: string;
    rowCount?: number;
}

export interface Db2PartitionDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    columns: Db2DesignerColumn[];
    partitionExpressions: string[];
    partitions: Db2DesignerPartition[];
    tablespaces: string[];
}

export interface Db2PartitionExecutionRequest {
    title: string;
    successMessage: string;
    statements: string[];
}

export type Db2PartitionDesignerWebviewToHostMessage =
    | { command: 'executeStatements'; request: Db2PartitionExecutionRequest }
    | { command: 'saveAsSql'; ddl: string }
    | { command: 'copyDDL'; ddl: string };

export type Db2PartitionDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean };

export type Db2PartitionDesignerInboundMessage = Db2PartitionDesignerWebviewToHostMessage;
export type Db2PartitionDesignerOutboundMessage = Db2PartitionDesignerHostToWebviewMessage;
