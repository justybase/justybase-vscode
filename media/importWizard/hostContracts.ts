/**
 * Webview-local copies of import wizard message contracts.
 */

export type ImportWizardPreviewKind = 'create' | 'load' | 'plan';

export type ImportWizardExecutionMode = 'direct' | 'workflow' | 'unsupported';
export type ImportWizardOverrideMode = 'inferred' | 'user';
export type ImportWizardIssueSeverity = 'error' | 'warning';
export type ImportWizardFileFormat = 'csv' | 'txt' | 'xlsx' | 'xlsb';

export interface ImportExecutionPlan {
    mode: ImportWizardExecutionMode;
    createTableSql: string;
    loadSql?: string;
    warnings: string[];
    nextSteps?: string[];
}

export interface ImportWizardColumn {
    sourceIndex: number;
    sourceName: string;
    targetName: string;
    defaultTargetName: string;
    included: boolean;
    order: number;
    inferredType: string;
    selectedType: string;
    overrideMode: ImportWizardOverrideMode;
}

export interface ImportWizardCellIssue {
    rowIndex: number;
    columnIndex: number;
    sourceIndex: number;
    severity: ImportWizardIssueSeverity;
    message: string;
    value?: string;
}

export interface ImportWizardValidationSummary {
    issues: ImportWizardCellIssue[];
    warnings: string[];
    hasErrors: boolean;
}

export interface BackgroundValidationProgress {
    phase: 'starting' | 'reading' | 'validating' | 'complete' | 'cancelled';
    rowsProcessed: number;
    totalRows: number;
    issuesFound: number;
}

export interface ImportTargetLocationState {
    database?: string;
    schema?: string;
    tableName: string;
}

export interface ImportTargetLocationCapabilitiesState {
    supportsDatabaseSelection: boolean;
    supportsSchemaSelection: boolean;
    enforceActiveDatabase: boolean;
}

export interface ImportWizardState {
    id: string;
    filePath: string;
    fileName: string;
    fileFormat: ImportWizardFileFormat;
    sheetName?: string;
    availableSheets: string[];
    canChangeSheet: boolean;
    connectionName?: string;
    databaseKind: string;
    targetTable: string;
    targetLocation: ImportTargetLocationState;
    targetLocationCapabilities: ImportTargetLocationCapabilitiesState;
    availableDatabases: string[];
    availableSchemas: string[];
    previewRowCount: number;
    validationSampleSize: number;
    detectedDelimiter?: string;
    decimalDelimiter: '.' | ',';
    sourceHeaders: string[];
    columns: ImportWizardColumn[];
    previewRows: string[][];
    issues: ImportWizardCellIssue[];
    warnings: string[];
    hasValidationErrors: boolean;
    executionPlan: ImportExecutionPlan;
    typeOptions: string[];
}

export interface ImportResult {
    success: boolean;
    message: string;
    details?: Record<string, unknown>;
}

export type ImportWizardWebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'setPreviewRowCount'; previewRowCount: number }
    | { type: 'setSheet'; sheetName?: string }
    | { type: 'renameColumn'; sourceIndex: number; targetName: string }
    | { type: 'toggleColumn'; sourceIndex: number; included?: boolean }
    | { type: 'reorderColumns'; orderedSourceIndexes: number[] }
    | { type: 'setColumnType'; sourceIndex: number; selectedType: string }
    | { type: 'setTargetDatabase'; database?: string }
    | { type: 'setTargetSchema'; schema?: string }
    | { type: 'setTargetTableName'; tableName: string }
    | { type: 'requestSqlPreview' }
    | { type: 'copySql'; kind?: ImportWizardPreviewKind }
    | { type: 'openSqlPreview'; kind?: ImportWizardPreviewKind }
    | { type: 'executeImport' }
    | { type: 'startBackgroundValidation'; backgroundValidationSampleSize?: number }
    | { type: 'cancelBackgroundValidation' };

export type ImportWizardHostToWebviewMessage =
    | { type: 'sessionInitialized'; state: ImportWizardState }
    | { type: 'previewUpdated'; state: ImportWizardState }
    | {
          type: 'validationUpdated';
          issues: ImportWizardCellIssue[];
          warnings: string[];
          hasValidationErrors: boolean;
      }
    | { type: 'sqlPreviewUpdated'; executionPlan: ImportExecutionPlan }
    | {
          type: 'backgroundValidationProgress';
          progress: BackgroundValidationProgress;
          summary?: ImportWizardValidationSummary;
      }
    | { type: 'executionStarted' }
    | { type: 'executionFinished'; result: ImportResult }
    | { type: 'executionFailed'; message: string };
