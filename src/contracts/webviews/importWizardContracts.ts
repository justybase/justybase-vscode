import type { ImportResult } from '../../import/dataImporter';
import type { ImportLoadStatus } from '@justybase/contracts';
import type {
    BackgroundValidationProgress,
    ImportExecutionPlan,
    ImportWizardCellIssue,
    ImportWizardState,
    ImportWizardValidationSummary
} from '../../import/wizard/ImportWizardState';

export type ImportWizardPreviewKind = 'create' | 'load' | 'plan';

/** Two-phase import progress: external data transfer, then database processing. */
export type ImportExecutionPhase = 'preparing' | 'transfer' | 'processing';

export interface ImportExecutionProgress {
    phase: ImportExecutionPhase;
    /** Transfer percentage 0-100; omitted when the phase is indeterminate. */
    percent?: number;
    message?: string;
    rowsProcessed?: number;
    totalRows?: number;
    /** Bytes pulled from the source into the import stream. */
    bytesRead?: number;
    /** Expected stream size when known (CSV/TXT source size). */
    bytesTotal?: number;
    /** Best-effort `_V_LOAD_STATUS` row while the database processes the load. */
    loadStatus?: ImportLoadStatus;
}

export type ImportWizardWebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'setPreviewRowCount'; previewRowCount: number }
    | { type: 'setSheet'; sheetName?: string }
    | { type: 'renameColumn'; sourceIndex: number; targetName: string }
    | { type: 'toggleColumn'; sourceIndex: number; included?: boolean }
    | { type: 'reorderColumns'; orderedSourceIndexes: number[] }
    | { type: 'setColumnType'; sourceIndex: number; selectedType: string }
    | { type: 'setHasHeaders'; hasHeaders: boolean }
    | { type: 'setCreateTable'; createTable: boolean }
    | { type: 'setConnection'; connectionName: string }
    | { type: 'requestClipboardSource' }
    | { type: 'requestFileSource' }
    | { type: 'closeWizard' }
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
    | { type: 'executionProgress'; progress: ImportExecutionProgress }
    | { type: 'executionFinished'; result: ImportResult }
    | { type: 'executionFailed'; message: string }
    | { type: 'sessionTransitionStarted' }
    | { type: 'sessionTransitionFinished' };

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
    'setHasHeaders',
    'setCreateTable',
    'setConnection',
    'requestClipboardSource',
    'requestFileSource',
    'closeWizard',
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
    'executionProgress',
    'executionFinished',
    'executionFailed',
    'sessionTransitionStarted',
    'sessionTransitionFinished'
] as const satisfies readonly ImportWizardHostToWebviewMessage['type'][];

export const IMPORT_WIZARD_INBOUND_TYPES = IMPORT_WIZARD_WEBVIEW_TO_HOST_TYPES;
export const IMPORT_WIZARD_OUTBOUND_TYPES = IMPORT_WIZARD_HOST_TO_WEBVIEW_TYPES;
