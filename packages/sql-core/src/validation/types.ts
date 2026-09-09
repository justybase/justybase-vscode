export interface TokenPosition {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  offset: number;
}

export interface ValidationError {
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  position: TokenPosition;
  code: string;
  suggestedFix?: string;
}

export interface ColumnInfo {
  name: string;
  alias?: string;
  dataType?: string;
  description?: string;
  position?: TokenPosition;
  isDistributionKey?: boolean;
}

export interface TableInfo {
  name: string;
  alias?: string;
  schema?: string;
  database?: string;
  isCte: boolean;
  isTempTable: boolean;
  /** True when the relation name contains a script macro reference. */
  isDynamicMacro?: boolean;
  columns: ColumnInfo[];
  position?: TokenPosition;
}

export interface CteInfo extends TableInfo {
  recursive: boolean;
}

export interface Scope {
  tables: Map<string, TableInfo>;
  ctes: Map<string, CteInfo>;
  parent?: Scope;
  level: number;
  position?: TokenPosition;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  scope: Scope;
}

export interface ScopeSeed {
  createdProcedures?: readonly string[];
  createdTables?: readonly TableInfo[];
}

/** Statement range shared by desktop incremental validation and sql-core. */
export interface StatementBoundary {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
}
