import type {
  AuthResponse,
  ConnectionProfileInput,
  ConnectionProfileUpdate,
  ConnectionProfileSummary,
  EditorPreferences,
  EditorPreferencesPatch,
  HistoryEntry,
  MetadataColumn,
  MetadataDatabase,
  MetadataObject,
  MetadataSchema,
  QueryEvent,
  QueryExportRequest,
  QueryStartRequest,
  QueryStartResponse,
  QueryPageRequest,
  QueryPageResponse,
  SchemaSearchRequest,
  SchemaSearchResponse,
  SchemaTreeResponse,
  SqlCompletionRequest,
  SqlCompletionResponse,
  SqlDiagnosticsRequest,
  SqlDiagnosticsResponse,
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
  databases: (connectionId: string) => request<MetadataDatabase[]>(`/api/metadata/databases?connectionId=${encodeURIComponent(connectionId)}`),
  schemas: (connectionId: string, database: string) => request<MetadataSchema[]>(`/api/metadata/schemas?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}`),
  objects: (connectionId: string, database: string, schema?: string) => request<MetadataObject[]>(`/api/metadata/objects?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}${schema ? `&schema=${encodeURIComponent(schema)}` : ''}`),
  columns: (connectionId: string, database: string, schema: string, table: string) => request<MetadataColumn[]>(`/api/metadata/columns?connectionId=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`),
  history: () => request<HistoryEntry[]>('/api/history'),
  startQuery: (input: QueryStartRequest) => request<QueryStartResponse>('/api/query', { method: 'POST', body: JSON.stringify(input) }),
  cancelQuery: (queryId: string) => request<{ ok: true }>(`/api/query/${queryId}/cancel`, { method: 'POST' }),
  queryPage: (queryId: string, input: QueryPageRequest) => request<QueryPageResponse>(`/api/query/${queryId}/page`, { method: 'POST', body: JSON.stringify(input) }),
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
};

export function connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: () => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', queryId })));
  socket.addEventListener('message', event => onEvent(JSON.parse(String(event.data)) as QueryEvent));
  socket.addEventListener('error', () => onError?.());
  return socket;
}
