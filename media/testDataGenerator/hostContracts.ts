/**
 * Webview-local copies of test data generator message contracts.
 */

export interface TestDataGeneratorTableColumn {
    name: string;
    type: string;
    fullType: string;
    nullable: boolean;
    defaultValue?: string;
}

export interface TestDataGeneratorBootstrapState {
    connectionName: string;
    database: string;
    schema: string;
    table: string;
    columns: TestDataGeneratorTableColumn[];
}

export interface ColumnGenerationConfig {
    name: string;
    type: string;
    strategy: 'random' | 'sequence' | 'null' | 'fixed' | 'faker';
    params?: Record<string, unknown>;
}

export interface DataGenerationConfig {
    rowCount: number;
    batchSize: number;
    useTransaction: boolean;
    columns: ColumnGenerationConfig[];
}

export type TestDataGeneratorWebviewToHostMessage =
    | { command: 'generateData'; config: DataGenerationConfig }
    | { command: 'copyToClipboard'; sql: string }
    | { command: 'openInEditor'; sql: string };

export interface ColumnStrategyState {
    strategy: ColumnGenerationConfig['strategy'] | string;
    params: Record<string, unknown>;
}
