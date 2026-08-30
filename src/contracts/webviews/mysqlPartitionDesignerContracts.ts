import type { MysqlDesignerColumn } from './mysqlIndexDesignerContracts';

export type MysqlPartitionMethod =
    | 'RANGE'
    | 'LIST'
    | 'HASH'
    | 'LINEAR HASH'
    | 'KEY'
    | 'LINEAR KEY'
    | 'AUTO'
    | 'UNKNOWN';

export interface MysqlDesignerPartition {
    name: string;
    subpartitionName?: string;
    ordinal: number;
    subpartitionOrdinal?: number;
    method: MysqlPartitionMethod;
    subpartitionMethod?: string;
    partitionExpression?: string;
    subpartitionExpression?: string;
    description?: string;
    rowCount?: number;
    dataLength?: number;
    indexLength?: number;
    tablespace?: string;
    comment?: string;
}

export interface MysqlPartitionCapabilities {
    engine: string;
    serverVersion: string;
    isPartitioned: boolean;
    partitionMethod: MysqlPartitionMethod | null;
    subpartitionMethod: string | null;
    partitionExpression: string | null;
    canAddPartition: boolean;
    canDropPartition: boolean;
    dropMode: 'named' | 'coalesce' | 'none';
    reason?: string;
}

export interface MysqlPartitionDesignerInitialContext {
    schema: string;
    tableName: string;
    qualifiedTable: string;
    columns: MysqlDesignerColumn[];
    capabilities: MysqlPartitionCapabilities;
    partitions: MysqlDesignerPartition[];
}

export type MysqlPartitionOperationRequest =
    | {
        operation: 'addRangeList';
        partitionName: string;
        valuesClause: string;
    }
    | {
        operation: 'addHashKey';
        partitionCount: number;
    }
    | {
        operation: 'drop';
        partitionName: string;
    }
    | {
        operation: 'coalesce';
        partitionCount: number;
    };

export type MysqlPartitionDesignerWebviewToHostMessage =
    | { command: 'executeOperation'; request: MysqlPartitionOperationRequest }
    | { command: 'saveAsSql'; request: MysqlPartitionOperationRequest }
    | { command: 'copyDDL'; request: MysqlPartitionOperationRequest }
    | { command: 'reload' };

export type MysqlPartitionDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean }
    | { command: 'setContext'; context: MysqlPartitionDesignerInitialContext };

export type MysqlPartitionDesignerInboundMessage = MysqlPartitionDesignerWebviewToHostMessage;
export type MysqlPartitionDesignerOutboundMessage = MysqlPartitionDesignerHostToWebviewMessage;
