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

export type TestDataGeneratorInboundMessage = TestDataGeneratorWebviewToHostMessage;

export const TEST_DATA_GENERATOR_WEBVIEW_TO_HOST_COMMANDS = [
    'generateData',
    'copyToClipboard',
    'openInEditor',
] as const satisfies readonly TestDataGeneratorWebviewToHostMessage['command'][];

export const TEST_DATA_GENERATOR_INBOUND_COMMANDS = TEST_DATA_GENERATOR_WEBVIEW_TO_HOST_COMMANDS;
