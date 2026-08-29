import type { Db2DesignerColumn } from '../db2IndexDesigner/hostContracts.js';

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
    sourceTables: string[];
}

export interface Db2PartitionRangeDesign {
    partitionName: string;
    startingFrom: string;
    startingInclusive: boolean;
    endingAt: string;
    endingInclusive: boolean;
    tablespace?: string;
    indexTablespace?: string;
    longTablespace?: string;
}

export type Db2PartitionOperationRequest =
    | {
        operation: 'add';
        range: Db2PartitionRangeDesign;
    }
    | {
        operation: 'attach';
        range: Omit<Db2PartitionRangeDesign, 'tablespace' | 'indexTablespace' | 'longTablespace'>;
        sourceSchema: string;
        sourceTable: string;
        runSetIntegrity: boolean;
    }
    | {
        operation: 'detach' | 'drop';
        partitionName: string;
        detachedSchema: string;
        detachedTable: string;
    };

export type Db2PartitionDesignerWebviewToHostMessage =
    | { command: 'executeOperation'; request: Db2PartitionOperationRequest }
    | { command: 'saveAsSql'; request: Db2PartitionOperationRequest }
    | { command: 'copyDDL'; request: Db2PartitionOperationRequest };

export type Db2PartitionDesignerHostToWebviewMessage =
    | { command: 'setError'; text: string }
    | { command: 'setInfo'; text: string }
    | { command: 'clearStatus' }
    | { command: 'setExecuting'; executing: boolean };
