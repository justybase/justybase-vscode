/** Options applied to a tabular import column selection and type mapping. */
export interface ImportColumnOptions {
  selectedColumnIndexes?: number[];
  forcedColumnTypes?: Record<number, string>;
  /**
   * Types declared for the external/source-side columns. Existing-table
   * imports use the authoritative catalog type here so the database rejects
   * incompatible rows before they reach the target insert.
   */
  externalColumnTypes?: Record<number, string>;
  columnNameOverrides?: Record<number, string>;
  /**
   * Exact destination names for an existing-table import. Unlike
   * `columnNameOverrides`, these are not header-sanitized, so quoted or
   * mixed-case catalog names (for example `Mixed Name`) can be mapped
   * safely. Only used by importers that explicitly support target mapping.
   */
  targetColumnNameOverrides?: Record<number, string>;
  appendToExistingTable?: boolean;
  hasHeaders?: boolean;
  /**
   * Worksheet to read from an xlsx/xlsb source. When omitted, the first
   * worksheet is used or the option is not applicable (delimited files).
   * Unknown worksheet names abort the import before any database write.
   */
  sheetName?: string;
  /** Number of leading source rows to skip before the header row. */
  skipRows?: number;
  /** Explicit field delimiter override; otherwise detected from the source. */
  delimiter?: string;
  /** Maximum rejected rows tolerated by a database load. Defaults per dialect. */
  maxErrors?: number;
  /** Source text encoding (for example `utf8`, `utf16le`, `latin1`). */
  encoding?: string;
}

/** A normalized source column descriptor shared by import planners. */
export interface ImportColumnDescriptor {
  sourceIndex: number;
  columnName: string;
  dataType: string;
}

/** A Netezza load status row from `_V_LOAD_STATUS`, when the view is accessible. */
export interface ImportLoadStatus {
  planId?: number;
  databaseName?: string;
  tableName?: string;
  schemaName?: string;
  userName?: string;
  bytesProcessed?: number;
  rowsInserted?: number;
  rowsRejected?: number;
  bytesDownloaded?: number;
}

export interface ImportProgressDetail {
  /** Best-effort database load monitoring; absent when the view is unavailable. */
  loadStatus?: ImportLoadStatus;
  /** Bytes already read from the generated import stream. */
  bytesRead?: number;
  /** Total bytes expected in the generated import stream, when known. */
  bytesTotal?: number;
}

/** Progress callback used by in-process product adapters. */
export type ProgressCallback = (
  message: string,
  increment?: number,
  logToOutput?: boolean,
  detail?: ImportProgressDetail,
) => void;

export interface SnowflakeWorkflowDetails {
  workflowMarkdown: string;
  createTableSql?: string;
  copyIntoSql?: string;
  warnings?: string[];
  nextSteps?: string[];
  stageName?: string;
  stagePath?: string;
  sourceFormat?: string;
}

export interface ImportResultDetails {
  sourceFile?: string;
  targetTable?: string;
  fileSize?: number;
  format?: string;
  rowsProcessed?: number;
  rowsInserted?: number;
  /** Rows rejected by the database load (for example Netezza MAXERRORS). */
  rowsRejected?: number;
  processingTime?: string;
  columns?: number;
  detectedDelimiter?: string;
  warnings?: string[];
  snowflakeWorkflow?: SnowflakeWorkflowDetails;
}

/** Existing import result shape, kept stable across desktop and companions. */
export interface ImportResult<
  TDetails extends ImportResultDetails = ImportResultDetails,
> {
  success: boolean;
  message: string;
  details?: TDetails;
}
