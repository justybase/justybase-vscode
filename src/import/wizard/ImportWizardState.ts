import type { DatabaseKind } from "../../contracts/database";
import type { ConnectionDetails } from "../../types";

export type ImportWizardExecutionMode = "direct" | "workflow" | "unsupported";
export type ImportWizardOverrideMode = "inferred" | "user";
export type ImportWizardIssueSeverity = "error" | "warning";
export type ImportWizardFileFormat = "csv" | "txt" | "xlsx" | "xlsb";

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
  databaseKind: DatabaseKind;
  targetTable: string;
  targetLocation: ImportTargetLocationState;
  targetLocationCapabilities: ImportTargetLocationCapabilitiesState;
  availableDatabases: string[];
  availableSchemas: string[];
  previewRowCount: number;
  validationSampleSize: number;
  detectedDelimiter?: string;
  decimalDelimiter: "." | ",";
  sourceHeaders: string[];
  columns: ImportWizardColumn[];
  previewRows: string[][];
  issues: ImportWizardCellIssue[];
  warnings: string[];
  hasValidationErrors: boolean;
  executionPlan: ImportExecutionPlan;
  typeOptions: string[];
  backgroundValidation?: BackgroundValidationStatus;
}

export interface BackgroundValidationProgress {
  phase: "starting" | "reading" | "validating" | "complete" | "cancelled";
  rowsProcessed: number;
  totalRows: number;
  issuesFound: number;
}

export interface BackgroundValidationStatus {
  isActive: boolean;
  progress: BackgroundValidationProgress;
  startTime: number;
}

export interface ImportWizardSessionOptions {
  filePath: string;
  targetTable: string;
  connectionDetails: ConnectionDetails;
  previewRowCount: number;
  validationSampleSize: number;
  connectionName?: string;
  availableDatabases?: string[];
  availableSchemas?: string[];
}
