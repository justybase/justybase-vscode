import type {
  AuthResponse,
  AdminRestoreRequest,
  AdminRestoreResponse,
  AdminUserCreateRequest,
  AdminUserSummary,
  AdminUserUpdateRequest,
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  ConnectionProfileSummary,
  DesignerCapabilitiesRequest,
  DesignerCapabilitiesResponse,
  DesignerSnapshotResponse,
  EditorPreferences,
  EditorPreferencesPatch,
  HistoryEntry,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
  QueryEvent,
  QueryAggregateRequest,
  QueryAggregateResponse,
  QueryAuditEntry,
  QueryEditPreviewRequest,
  QueryEditRequest,
  QueryExportRequest,
  QueryFileImportPreviewRequest,
  QueryFileImportRequest,
  QueryGroupRequest,
  QueryGroupResponse,
  QueryImportPreviewRequest,
  QueryImportRequest,
  QueryPreviewResponse,
  QueryStartRequest,
  QueryStartResponse,
  QueryPageRequest,
  QueryPageResponse,
  QueryWriteResponse,
  WriteOperationPreviewResponse,
  SchemaSearchRequest,
  SchemaSearchResponse,
  SchemaTreeResponse,
  SqlCompletionRequest,
  SqlCompletionResponse,
  SqlDiagnosticsRequest,
  SqlDiagnosticsResponse,
  SqlFormatRequest,
  SqlFormatResponse,
  WebUser,
} from '@justybase/contracts';

export class ApiRequestError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('justybase_csrf='))?.slice('justybase_csrf='.length);
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-justybase-csrf': csrf } : {}), ...(init?.headers ?? {}) }, credentials: 'include' });
  const body = await response.json() as T | { message?: string };
  if (!response.ok) throw new ApiRequestError(response.status, typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : 'Request failed.');
  return body as T;
}

export const api = {
  me: () => request<{ user: WebUser }>('/api/auth/me'),
  login: (username: string, password: string) => request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  connections: () => request<ConnectionProfileSummary[]>('/api/connections'),
  createConnection: (input: ConnectionProfileInput) => request<ConnectionProfileSummary>('/api/connections', { method: 'POST', body: JSON.stringify(input) }),
  updateConnection: (id: string, input: ConnectionProfileUpdate) => request<ConnectionProfileSummary>(`/api/connections/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteConnection: (id: string) => request<{ ok: true }>(`/api/connections/${id}`, { method: 'DELETE' }),
  testConnectionProfile: (input: ConnectionProfileInput) => request<{ ok: true }>('/api/connections/test', { method: 'POST', body: JSON.stringify(input) }),
  testConnection: (id: string) => request<{ ok: true }>(`/api/connections/${id}/test`, { method: 'POST' }),
  databases: (connectionId: string) => request<MetadataDatabase[]>(`/api/metadata/databases?connectionId=${encodeURIComponent(connectionId)}`),
  schemas: (connectionId: string, database: string) => request<MetadataSchema[]>(`/api/metadata/schemas?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}`),
  objects: (connectionId: string, database: string, schema?: string) => request<MetadataObject[]>(`/api/metadata/objects?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}${schema ? `&schema=${encodeURIComponent(schema)}` : ''}`),
  columns: (connectionId: string, database: string, schema: string, table: string) => request<MetadataColumn[]>(`/api/metadata/columns?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`),
  designerCapabilities: (input: DesignerCapabilitiesRequest) => request<DesignerCapabilitiesResponse>(`/api/designer/capabilities?${new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined) as Array<[string, string]>).toString()}`),
  designerSnapshot: (input: DesignerCapabilitiesRequest) => request<DesignerSnapshotResponse>(`/api/designer/snapshot?${new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined) as Array<[string, string]>).toString()}`),
  history: () => request<HistoryEntry[]>('/api/history'),
  audit: (limit = 200) => request<QueryAuditEntry[]>(`/api/audit?limit=${encodeURIComponent(String(limit))}`),
  startQuery: (input: QueryStartRequest) => request<QueryStartResponse>('/api/query', { method: 'POST', body: JSON.stringify(input) }),
  previewQuery: (input: QueryStartRequest) => request<QueryPreviewResponse>('/api/query/preview', { method: 'POST', body: JSON.stringify(input) }),
  editPreview: (input: QueryEditPreviewRequest) => request<WriteOperationPreviewResponse>('/api/query/edit/preview', { method: 'POST', body: JSON.stringify(input) }),
  edit: (input: QueryEditRequest) => request<QueryWriteResponse>('/api/query/edit', { method: 'POST', body: JSON.stringify(input) }),
  importPreview: (input: QueryImportPreviewRequest) => request<WriteOperationPreviewResponse>('/api/query/import/preview', { method: 'POST', body: JSON.stringify(input) }),
  importRows: (input: QueryImportRequest) => request<QueryWriteResponse>('/api/query/import', { method: 'POST', body: JSON.stringify(input) }),
  importFilePreview: (input: QueryFileImportPreviewRequest) => request<WriteOperationPreviewResponse>('/api/query/import-file/preview', { method: 'POST', body: JSON.stringify(input) }),
  importFile: (input: QueryFileImportRequest) => request<QueryWriteResponse>('/api/query/import-file', { method: 'POST', body: JSON.stringify(input) }),
  cancelQuery: (queryId: string) => request<{ ok: true }>(`/api/query/${queryId}/cancel`, { method: 'POST' }),
  queryPage: (queryId: string, input: QueryPageRequest) => request<QueryPageResponse>(`/api/query/${queryId}/page`, { method: 'POST', body: JSON.stringify(input) }),
  aggregate: (queryId: string, input: QueryAggregateRequest = {}) => request<QueryAggregateResponse>(`/api/query/${queryId}/aggregate`, { method: 'POST', body: JSON.stringify(input) }),
  group: (queryId: string, input: QueryGroupRequest) => request<QueryGroupResponse>(`/api/query/${queryId}/group`, { method: 'POST', body: JSON.stringify(input) }),
  exportQuery: async (queryId: string, input: QueryExportRequest): Promise<{ blob: Blob; fileName: string }> => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('justybase_csrf='))?.slice('justybase_csrf='.length);
    const response = await fetch(`/api/query/${queryId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-justybase-csrf': csrf } : {}) }, credentials: 'include', body: JSON.stringify(input) });
    if (!response.ok) {
      const body = await response.json() as { message?: string };
      throw new ApiRequestError(response.status, body.message ?? 'Export failed.');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/i.exec(disposition)?.[1] ?? `justybase-query.${input.format}`;
    return { blob: await response.blob(), fileName };
  },
  editorPreferences: () => request<EditorPreferences>('/api/preferences/editor'),
  updateEditorPreferences: (input: EditorPreferencesPatch) => request<EditorPreferences>('/api/preferences/editor', { method: 'PATCH', body: JSON.stringify(input) }),
  schemaTree: (connectionId: string, parentId?: string) => request<SchemaTreeResponse>(`/api/schema/tree?connectionId=${encodeURIComponent(connectionId)}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ''}`),
  searchSchema: (input: SchemaSearchRequest) => request<SchemaSearchResponse>('/api/schema/search', { method: 'POST', body: JSON.stringify(input) }),
  completion: (input: SqlCompletionRequest) => request<SqlCompletionResponse>('/api/lsp/completion', { method: 'POST', body: JSON.stringify(input) }),
  diagnostics: (input: SqlDiagnosticsRequest) => request<SqlDiagnosticsResponse>('/api/lsp/diagnostics', { method: 'POST', body: JSON.stringify(input) }),
  formatSql: (input: SqlFormatRequest) => request<SqlFormatResponse>('/api/lsp/format', { method: 'POST', body: JSON.stringify(input) }),
  snippets: () => request<{ snippets: Array<{ prefix: string[]; body: string[]; description?: string }> }>('/api/lsp/snippets'),
  adminUsers: () => request<AdminUserSummary[]>('/api/admin/users'),
  createAdminUser: (input: AdminUserCreateRequest) => request<AdminUserSummary>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  updateAdminUser: (id: string, input: AdminUserUpdateRequest) => request<AdminUserSummary>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  adminBackup: async (): Promise<{ blob: Blob; fileName: string }> => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('justybase_csrf='))?.slice('justybase_csrf='.length);
    const response = await fetch('/api/admin/backup', { headers: csrf ? { 'x-justybase-csrf': csrf } : {}, credentials: 'include' });
    if (!response.ok) throw new ApiRequestError(response.status, 'Backup failed.');
    const disposition = response.headers.get('content-disposition') ?? '';
    return { blob: await response.blob(), fileName: /filename="([^"]+)"/i.exec(disposition)?.[1] ?? 'justybase-backup.sqlite' };
  },
  adminRestore: (input: AdminRestoreRequest) => request<AdminRestoreResponse>('/api/admin/restore', { method: 'POST', body: JSON.stringify(input) }),
};

export interface QueryEventSubscription {
  close(): void;
  getLastSequence(): number;
}

export function connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: (error: Error) => void): QueryEventSubscription {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: number | undefined;
  let reconnectAttempts = 0;
  let lastSequence = 0;

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      socket?.send(JSON.stringify({ type: 'subscribe', queryId, afterSequence: lastSequence }));
    });
    socket.addEventListener('message', event => {
      try {
        const parsed = JSON.parse(String(event.data)) as QueryEvent;
        if (parsed.sequence !== undefined) {
          if (parsed.sequence <= lastSequence) return;
          lastSequence = parsed.sequence;
        }
        onEvent(parsed);
      } catch {
        // Ignore malformed frames; the next replay still starts at lastSequence.
      }
    });
    socket.addEventListener('error', () => socket?.close());
    socket.addEventListener('close', () => {
      if (closed) return;
      reconnectAttempts += 1;
      if (reconnectAttempts >= 5) {
        closed = true;
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        onError?.(new Error('Query result stream disconnected after five reconnect attempts.'));
        return;
      }
      const delay = Math.min(5000, 200 * 2 ** Math.min(reconnectAttempts - 1, 4));
      reconnectTimer = window.setTimeout(connect, delay);
    });
  };
  connect();
  return {
    close: () => {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    },
    getLastSequence: () => lastSequence,
  };
}
