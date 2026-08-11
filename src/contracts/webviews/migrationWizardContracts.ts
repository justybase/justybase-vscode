import type { DatabaseKind } from '../database';

export type MigrationWizardSourceMode = 'table' | 'sql';

export interface MigrationWizardConnection {
    name: string;
    kind: DatabaseKind;
    database?: string;
    schema?: string;
}

export interface MigrationWizardSourceState {
    mode: MigrationWizardSourceMode;
    connectionName: string;
    database?: string;
    schema?: string;
    table?: string;
    sql?: string;
}

export interface MigrationWizardTargetState {
    connectionName: string;
    database?: string;
    schema?: string;
    table: string;
    appendToExistingTable: boolean;
}

export interface MigrationWizardColumnState {
    sourceIndex: number;
    sourceName: string;
    sourceType: string;
    targetName: string;
    targetType: string;
    targetTypeDisplay: string;
    notNull: boolean;
    isPk: boolean;
    defaultValue?: string;
}

export interface MigrationWizardAnalysisState {
    sourceKind: DatabaseKind;
    targetKind: DatabaseKind;
    targetQualifiedName: string;
    totalRows?: number;
    columns: MigrationWizardColumnState[];
    createTableDdl: string;
    warnings: string[];
}

export interface MigrationWizardProgressState {
    phase: string;
    rowsRead: number;
    totalRows?: number;
    percent: number;
    message: string;
    elapsedSeconds: number;
}

export interface MigrationWizardCatalogTable {
    schema: string;
    name: string;
}

export interface MigrationWizardCatalog {
    databases: string[];
    schemas: string[];
    tables: MigrationWizardCatalogTable[];
    loaded: boolean;
}

export interface MigrationWizardState {
    connections: MigrationWizardConnection[];
    source: MigrationWizardSourceState;
    target: MigrationWizardTargetState;
    catalog?: MigrationWizardCatalog;
    analysis?: MigrationWizardAnalysisState;
    progress?: MigrationWizardProgressState;
    executing: boolean;
    counting: boolean;
    error?: string;
}

export type MigrationWizardWebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'analyze'; source: MigrationWizardSourceState; target: MigrationWizardTargetState }
    | { type: 'countRows' }
    | { type: 'execute'; customCreateTableDdl?: string }
    | { type: 'requestCatalog'; connectionName: string; database?: string }
    | { type: 'openInSqlWindow' };

export type MigrationWizardHostToWebviewMessage =
    | { type: 'state'; state: MigrationWizardState }
    | { type: 'catalogUpdated'; catalog: MigrationWizardCatalog }
    | { type: 'analysisUpdated'; analysis: MigrationWizardAnalysisState }
    | { type: 'progress'; progress: MigrationWizardProgressState }
    | { type: 'executionFinished'; message: string; rowsInserted: number }
    | { type: 'executionFailed'; message: string };
