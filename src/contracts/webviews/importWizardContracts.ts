import type { ImportResult } from '../../import/dataImporter';
import type {
    BackgroundValidationProgress,
    ImportExecutionPlan,
    ImportWizardCellIssue,
    ImportWizardState,
    ImportWizardValidationSummary
} from '../../import/wizard/ImportWizardState';

export type ImportWizardPreviewKind = 'create' | 'load' | 'plan';

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

export type ImportWizardInboundMessage = ImportWizardWebviewToHostMessage;
export type ImportWizardOutboundMessage = ImportWizardHostToWebviewMessage;

export const IMPORT_WIZARD_WEBVIEW_TO_HOST_TYPES = [
    'ready',
    'setPreviewRowCount',
    'setSheet',
    'renameColumn',
    'toggleColumn',
    'reorderColumns',
    'setColumnType',
    'setTargetDatabase',
    'setTargetSchema',
    'setTargetTableName',
    'requestSqlPreview',
    'copySql',
    'openSqlPreview',
    'executeImport',
    'startBackgroundValidation',
    'cancelBackgroundValidation'
] as const satisfies readonly ImportWizardWebviewToHostMessage['type'][];

export const IMPORT_WIZARD_HOST_TO_WEBVIEW_TYPES = [
    'sessionInitialized',
    'previewUpdated',
    'validationUpdated',
    'sqlPreviewUpdated',
    'backgroundValidationProgress',
    'executionStarted',
    'executionFinished',
    'executionFailed'
] as const satisfies readonly ImportWizardHostToWebviewMessage['type'][];

export const IMPORT_WIZARD_INBOUND_TYPES = IMPORT_WIZARD_WEBVIEW_TO_HOST_TYPES;
export const IMPORT_WIZARD_OUTBOUND_TYPES = IMPORT_WIZARD_HOST_TO_WEBVIEW_TYPES;