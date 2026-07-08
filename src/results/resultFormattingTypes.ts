export type ResultFormattingScope = 'global' | 'connection' | 'result' | 'column';

export type NumericRoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil' | 'truncate';

export interface IntegerFormattingOptions {
    useGrouping: boolean;
    groupSeparator: string;
}

export interface DecimalFormattingOptions {
    useGrouping: boolean;
    groupSeparator: string;
    decimalSeparator: string;
    scale: number;
    preserveTrailingZeros: boolean;
    roundingMode: NumericRoundingMode;
}

export interface ResultFormattingSettings {
    integer: IntegerFormattingOptions;
    decimal: DecimalFormattingOptions;
    useFormattedValuesForExport: boolean;
}

export interface ColumnFormattingOverride {
    kind?: 'integer' | 'decimal' | 'auto';
    integer?: Partial<IntegerFormattingOptions>;
    decimal?: Partial<DecimalFormattingOptions>;
}

export interface ResultFormattingPayload {
    connectionName?: string;
    global: ResultFormattingSettings;
    connection?: Partial<ResultFormattingSettings>;
    columnOverrides: Record<string, ColumnFormattingOverride>;
}

export interface ResultFormattingUpdateRequest {
    sourceUri: string;
    scope: ResultFormattingScope;
    resultSetIndex?: number;
    columnId?: string;
    settings: Partial<ResultFormattingSettings> | ColumnFormattingOverride;
}

export interface ResultFormattingWebviewState {
    formatSettings?: ResultFormattingPayload;
}

export const DEFAULT_RESULT_FORMATTING_SETTINGS: ResultFormattingSettings = {
    integer: {
        useGrouping: true,
        groupSeparator: ' '
    },
    decimal: {
        useGrouping: true,
        groupSeparator: ' ',
        decimalSeparator: '.',
        scale: 4,
        preserveTrailingZeros: true,
        roundingMode: 'half-up'
    },
    useFormattedValuesForExport: false
};