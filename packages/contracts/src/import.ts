/** Options applied to a tabular import column selection and type mapping. */
export interface ImportColumnOptions {
  selectedColumnIndexes?: number[];
  forcedColumnTypes?: Record<number, string>;
  columnNameOverrides?: Record<number, string>;
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

/** Progress callback used by in-process product adapters. */
export type ProgressCallback = (
  message: string,
  increment?: number,
  logToOutput?: boolean,
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
