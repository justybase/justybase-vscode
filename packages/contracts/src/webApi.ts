import type {
  DatabaseDesignerCapabilities,
  DatabaseObjectSnapshot,
  DatabaseDesignerTarget,
  DatabaseKind,
} from './database';

export interface ApiError {
  code: string;
  message: string;
}

export interface WebUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface AdminUserSummary extends WebUser {
  active: boolean;
  createdAt: string;
}

export interface AdminUserCreateRequest {
  username: string;
  password: string;
  role?: 'admin' | 'user';
}

export interface AdminUserUpdateRequest {
  active?: boolean;
  password?: string;
  role?: 'admin' | 'user';
}

export interface AdminRestoreRequest {
  fileName: string;
  contentBase64: string;
  restoreConfirmed: boolean;
}

export interface AdminRestoreResponse {
  message: string;
  restoredUsers: number;
  restoredConnections: number;
}

export interface AuthResponse {
  user: WebUser;
}

export interface ConnectionProfileSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  dbType: DatabaseKind;
  readOnly: boolean;
}

export interface ConnectionProfileInput {
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  dbType?: DatabaseKind;
  readOnly?: boolean;
}

export interface ConnectionProfileUpdate {
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  dbType?: DatabaseKind;
  readOnly?: boolean;
}

export interface MetadataDatabase { name: string; }
export interface MetadataSchema { name: string; database: string; }
export interface MetadataObject {
  name: string;
  schema?: string;
  database?: string;
  objectType?: string;
  description?: string;
  /** Source SQL for a view, when the provider can expose it cheaply. */
  viewSql?: string;
}
export interface MetadataColumn {
  name: string;
  type?: string;
  description?: string;
  isPk?: boolean;
  isFk?: boolean;
}

/** Target used by the capability-aware object designer API. */
export interface DesignerCapabilitiesRequest {
  connectionId: string;
  database?: string;
  schema?: string;
  objectName?: string;
  objectType?: string;
}

export interface DesignerCapabilitiesResponse {
  target: DatabaseDesignerTarget;
  capabilities: DatabaseDesignerCapabilities;
  runtimeAvailable: boolean;
  readOnly: boolean;
}

/** Snapshot identity carried by a designer write preview/apply request. */
export interface DesignerChangeContext {
  target: DatabaseDesignerTarget;
  baseFingerprint: string;
}

export type DesignerSnapshotRequest = DesignerCapabilitiesRequest;

export interface DesignerSnapshotResponse {
  target: DatabaseDesignerTarget;
  snapshot: DatabaseObjectSnapshot;
}

export type SchemaNodeKind = 'connection' | 'database' | 'schema' | 'group' | 'object' | 'column' | 'cte';

export interface SchemaTreeNode {
  id: string;
  parentId?: string;
  kind: SchemaNodeKind;
  label: string;
  description?: string;
  viewSql?: string;
  database?: string;
  schema?: string;
  objectName?: string;
  objectType?: string;
  columnType?: string;
  hasChildren: boolean;
  isLoading?: boolean;
}

export interface SchemaTreeResponse {
  nodes: SchemaTreeNode[];
  stale?: boolean;
}

export interface SchemaSearchRequest {
  connectionId: string;
  term: string;
  database?: string;
  schema?: string;
  objectTypes?: string[];
  searchAllDatabases?: boolean;
}

export interface SchemaSearchResult {
  name: string;
  database: string;
  schema?: string;
  objectType: string;
  description?: string;
  matchType: 'name' | 'description' | 'column';
}

export interface SchemaSearchResponse {
  items: SchemaSearchResult[];
  stale?: boolean;
}

export interface EditorPreferences {
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
  minimap: boolean;
  lineNumbers: boolean;
  formatOnSave: boolean;
  formatOnType: boolean;
  keywordCase: 'upper' | 'lower' | 'preserve';
  inlineTypeHints: boolean;
  linterEnabled: boolean;
  linterRules: Record<string, 'error' | 'warning' | 'information' | 'hint' | 'off'>;
}

export type EditorPreferencesPatch = Partial<EditorPreferences>;

export type QueryExecutionMode = 'single' | 'script' | 'explain';

export interface QueryStartRequest {
  connectionId: string;
  sql: string;
  /** Database to use for this execution. When omitted, the profile database is used. */
  database?: string;
  /** `single` preserves the existing one-query API; `script` executes split statements sequentially. */
  mode?: QueryExecutionMode;
  /** Character offset used by `single` mode when the client wants the statement under the cursor. */
  cursorOffset?: number;
  /** Explicit confirmation for DML/DDL on a profile that is not read-only. */
  writeConfirmed?: boolean;
  /** Short-lived server-issued preview token matching this exact SQL and connection. */
  writePreviewToken?: string;
  /** Optional optimistic-concurrency context from the Object Designer snapshot. */
  designer?: DesignerChangeContext;
  maxRows?: number;
  timeoutSeconds?: number;
}
export interface QueryStartResponse { queryId: string; statementCount?: number; }
export interface QueryPreviewStatement {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
  commandType: string;
  readOnly: boolean;
  warnings: string[];
}
export interface QueryPreviewResponse {
  database: string;
  readOnly: boolean;
  containsWrite: boolean;
  previewToken: string;
  expiresAt: number;
  statements: QueryPreviewStatement[];
}
export interface QueryColumn { name: string; type?: string; }
export interface QueryEventBase {
  queryId: string;
  /** Monotonically increasing per-query event number, used for WebSocket replay. */
  sequence?: number;
  statementIndex?: number;
  statementCount?: number;
}
export interface QueryStartedEvent extends QueryEventBase { type: 'started'; startedAt: number; mode?: QueryExecutionMode; }
export interface QueryStatementStartedEvent extends QueryEventBase { type: 'statement-started'; statementSql?: string; }
export interface QueryColumnsEvent extends QueryEventBase { type: 'columns'; columns: QueryColumn[]; }
export interface QuerySessionEvent extends QueryEventBase { type: 'session'; sessionId: string; totalRows: number; }
export interface QueryProgressEvent extends QueryEventBase { type: 'progress'; totalRows: number; }
export interface QueryRowsEvent extends QueryEventBase { type: 'rows'; rows: unknown[][]; totalRows: number; }
export interface QueryCompleteEvent extends QueryEventBase {
  type: 'complete'; totalRows: number; limitReached: boolean; rowsAffected?: number; message?: string; commandType?: string;
}
export interface QueryErrorEvent extends QueryEventBase { type: 'error'; message: string; }
export interface QueryCancelledEvent extends QueryEventBase { type: 'cancelled'; totalRows: number; scope?: 'statement' | 'batch'; }
export interface QueryBatchCompleteEvent extends QueryEventBase {
  type: 'batch-complete';
  status: 'complete' | 'error' | 'cancelled';
  completedStatements: number;
  message?: string;
}
export type QueryEvent = QueryStartedEvent | QueryStatementStartedEvent | QueryColumnsEvent | QuerySessionEvent | QueryProgressEvent | QueryRowsEvent | QueryCompleteEvent | QueryErrorEvent | QueryCancelledEvent | QueryBatchCompleteEvent;

export interface QuerySortSpec { columnIndex: number; desc: boolean; }
export interface QueryColumnFilterSpec { columnIndex: number; value: string; }
export interface QueryPageRequest {
  /** Statement result within a script. Defaults to statement 0 for compatibility. */
  statementIndex?: number;
  offset?: number;
  limit?: number;
  globalFilter?: string;
  columnFilters?: QueryColumnFilterSpec[];
  sorting?: QuerySortSpec[];
}

export interface QueryPageResponse {
  sessionId: string;
  statementIndex?: number;
  columns: QueryColumn[];
  rows: unknown[][];
  offset: number;
  limit: number;
  totalRows: number;
  hasMore: boolean;
  rowsAffected?: number;
  limitReached?: boolean;
  message?: string;
}

export type QueryAggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface QueryAggregateRequest extends QueryPageRequest {
  functions?: QueryAggregateFunction[];
  columnIndices?: number[];
}

export interface QueryAggregateValue {
  columnIndex: number;
  count: number;
  /** Numeric results may be strings to preserve 64-bit and decimal precision. */
  sum?: number | string | null;
  avg?: number | string | null;
  min?: unknown;
  max?: unknown;
}

export interface QueryAggregateResponse {
  statementIndex?: number;
  filteredRowCount: number;
  values: QueryAggregateValue[];
}

export interface QueryGroupAggregate {
  function: QueryAggregateFunction;
  columnIndex?: number;
}

export interface QueryGroupRequest extends QueryPageRequest {
  groupByColumnIndices: number[];
  aggregates?: QueryGroupAggregate[];
  groupLimit?: number;
}

export interface QueryGroupResponse {
  statementIndex?: number;
  columns: QueryColumn[];
  rows: unknown[][];
  totalGroups: number;
}

export type QueryExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'xlsx' | 'xlsb';

export interface QueryExportRequest extends QueryPageRequest {
  format: QueryExportFormat;
  fileName?: string;
}

export type QueryAuditStatus = 'success' | 'error' | 'cancelled';
export interface QueryAuditEntry {
  id: string;
  connectionId: string;
  database: string;
  statementIndex: number;
  statementCount: number;
  commandType: string;
  sql: string;
  status: QueryAuditStatus;
  rowsAffected?: number;
  durationMs: number;
  confirmed: boolean;
  createdAt: string;
}

export interface TableWriteTarget {
  connectionId: string;
  database?: string;
  schema: string;
  table: string;
}

export interface WriteOperationPreviewResponse {
  sql: string;
  previewToken: string;
  expiresAt: number;
  warnings: string[];
  rowCount: number;
}

export interface QueryEditPreviewRequest extends TableWriteTarget {
  key: Record<string, unknown>;
  changes: Record<string, unknown>;
}

export interface QueryEditRequest extends QueryEditPreviewRequest {
  writeConfirmed: boolean;
  writePreviewToken: string;
}

export interface QueryImportPreviewRequest extends TableWriteTarget {
  columns: string[];
  rows: unknown[][];
}

export interface QueryImportRequest extends QueryImportPreviewRequest {
  writeConfirmed: boolean;
  writePreviewToken: string;
}

export type QueryFileImportFormat = 'csv' | 'xlsx' | 'xlsb';

export interface QueryFileImportPreviewRequest extends TableWriteTarget {
  fileName: string;
  contentBase64: string;
  format: QueryFileImportFormat;
  delimiter?: string;
  hasHeader?: boolean;
  sheetName?: string;
}

export interface QueryFileImportRequest extends QueryFileImportPreviewRequest {
  writeConfirmed: boolean;
  writePreviewToken: string;
}

export interface QueryWriteResponse {
  sql: string;
  rowsAffected: number;
  message: string;
}

export interface SqlLanguageContext {
  connectionId?: string;
  database?: string;
  schema?: string;
  databaseKind?: DatabaseKind;
}

export interface SqlCompletionRequest extends SqlLanguageContext {
  sql: string;
  offset: number;
}

export interface SqlCompletionItem {
  label: string;
  kind: 'keyword' | 'table' | 'view' | 'column' | 'function';
  detail?: string;
  insertText?: string;
}

export interface SqlCompletionResponse {
  items: SqlCompletionItem[];
}

export interface SqlDiagnosticPosition {
  line: number;
  character: number;
}

export interface SqlDiagnostic {
  message: string;
  severity: 'error' | 'warning';
  code?: string;
  start: SqlDiagnosticPosition;
  end: SqlDiagnosticPosition;
}

export interface SqlDiagnosticsRequest extends SqlLanguageContext {
  sql: string;
}

export interface SqlDiagnosticsResponse {
  diagnostics: SqlDiagnostic[];
}

export interface SqlFormatRequest extends SqlLanguageContext {
  sql: string;
  tabSize?: number;
  insertSpaces?: boolean;
  keywordCase?: EditorPreferences['keywordCase'];
}

export interface SqlFormatResponse {
  sql: string;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  database: string;
  sql: string;
  status: 'success' | 'error' | 'cancelled';
  durationMs: number;
  rowCount: number;
  createdAt: string;
}
