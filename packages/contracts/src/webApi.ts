import type { DatabaseKind } from './database';

export interface ApiError {
  code: string;
  message: string;
}

export interface WebUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
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
}
export interface MetadataColumn {
  name: string;
  type?: string;
  description?: string;
  isPk?: boolean;
  isFk?: boolean;
}

export type SchemaNodeKind = 'connection' | 'database' | 'schema' | 'group' | 'object' | 'column' | 'cte';

export interface SchemaTreeNode {
  id: string;
  parentId?: string;
  kind: SchemaNodeKind;
  label: string;
  description?: string;
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

export interface QueryStartRequest {
  connectionId: string;
  sql: string;
  maxRows?: number;
  timeoutSeconds?: number;
}
export interface QueryStartResponse { queryId: string; }
export interface QueryColumn { name: string; type?: string; }
export interface QueryStartedEvent { type: 'started'; queryId: string; startedAt: number; }
export interface QueryColumnsEvent { type: 'columns'; queryId: string; columns: QueryColumn[]; }
export interface QuerySessionEvent { type: 'session'; queryId: string; sessionId: string; totalRows: number; }
export interface QueryProgressEvent { type: 'progress'; queryId: string; totalRows: number; }
export interface QueryRowsEvent { type: 'rows'; queryId: string; rows: unknown[][]; totalRows: number; }
export interface QueryCompleteEvent {
  type: 'complete'; queryId: string; totalRows: number; limitReached: boolean; rowsAffected?: number;
}
export interface QueryErrorEvent { type: 'error'; queryId: string; message: string; }
export interface QueryCancelledEvent { type: 'cancelled'; queryId: string; totalRows: number; }
export type QueryEvent = QueryStartedEvent | QueryColumnsEvent | QuerySessionEvent | QueryProgressEvent | QueryRowsEvent | QueryCompleteEvent | QueryErrorEvent | QueryCancelledEvent;

export interface QuerySortSpec { columnIndex: number; desc: boolean; }
export interface QueryColumnFilterSpec { columnIndex: number; value: string; }
export interface QueryPageRequest {
  offset?: number;
  limit?: number;
  globalFilter?: string;
  columnFilters?: QueryColumnFilterSpec[];
  sorting?: QuerySortSpec[];
}

export interface QueryPageResponse {
  sessionId: string;
  columns: QueryColumn[];
  rows: unknown[][];
  offset: number;
  limit: number;
  totalRows: number;
  hasMore: boolean;
}

export type QueryExportFormat = 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'xlsx' | 'xlsb';

export interface QueryExportRequest extends QueryPageRequest {
  format: QueryExportFormat;
  fileName?: string;
}

export interface SqlLanguageContext {
  connectionId?: string;
  database?: string;
  schema?: string;
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

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  status: 'success' | 'error' | 'cancelled';
  durationMs: number;
  rowCount: number;
  createdAt: string;
}
