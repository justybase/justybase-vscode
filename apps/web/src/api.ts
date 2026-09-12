import { createContext, createElement, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
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
  MetadataDdlRequest,
  MetadataDdlResponse,
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
  QueryPageRequest,
  QueryPageResponse,
  QueryPreviewResponse,
  QueryStartRequest,
  QueryStartResponse,
  QueryWriteResponse,
  SchemaSearchRequest,
  SchemaSearchResponse,
  SchemaTreeResponse,
  SqlCompletionRequest,
  SqlCompletionResponse,
  SqlDiagnosticsRequest,
  SqlDiagnosticsResponse,
  SqlFormatRequest,
  SqlFormatResponse,
  DatabaseKind,
  WebUser,
  WriteOperationPreviewResponse,
} from '@justybase/contracts';

export class ApiRequestError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiClientOptions {
  /** Root URL for HTTP requests. Empty means same-origin relative URLs. */
  httpBaseUrl?: string;
  /** WebSocket origin, e.g. `wss://example.test`. */
  webSocketBaseUrl?: string;
  /** Allows hosts/tests to supply their CSRF-cookie integration. */
  csrfAdapter?: () => string | undefined | Promise<string | undefined>;
  /** Injectable transport for tests and embedded consumers. */
  fetch?: typeof globalThis.fetch;
  /** Injectable WebSocket constructor for tests and embedded consumers. */
  WebSocket?: new (url: string) => WebSocket;
}

export interface QueryEventSubscription {
  close(): void;
  getLastSequence(): number;
}

const queryEventTypes = new Set<QueryEvent['type']>([
  'started',
  'statement-started',
  'columns',
  'session',
  'progress',
  'rows',
  'complete',
  'error',
  'cancelled',
  'batch-complete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiRequestError(
      response.status,
      response.ok ? 'The API returned an invalid JSON response.' : 'Request failed.',
    );
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isQueryEventColumn(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  return (value.type === undefined || typeof value.type === 'string')
    && (value.scale === undefined || (isNonNegativeInteger(value.scale) && value.scale <= 1000));
}

/** Rejects malformed or foreign frames before they reach a product adapter. */
function parseQueryEvent(value: unknown, queryId: string): QueryEvent | undefined {
  if (!isRecord(value) || value.queryId !== queryId || typeof value.type !== 'string' || !queryEventTypes.has(value.type as QueryEvent['type'])) return undefined;
  if (value.sequence !== undefined && !isNonNegativeInteger(value.sequence)) return undefined;
  if (value.statementIndex !== undefined && !isNonNegativeInteger(value.statementIndex)) return undefined;
  switch (value.type as QueryEvent['type']) {
    case 'columns':
      return Array.isArray(value.columns) && value.columns.every(isQueryEventColumn) ? value as unknown as QueryEvent : undefined;
    case 'session':
    case 'progress':
      return isNonNegativeInteger(value.totalRows) ? value as unknown as QueryEvent : undefined;
    case 'rows':
      return Array.isArray(value.rows) && value.rows.every(row => Array.isArray(row))
        && isNonNegativeInteger(value.totalRows)
        && value.rows.length <= value.totalRows
        ? value as unknown as QueryEvent
        : undefined;
    case 'complete':
      return isNonNegativeInteger(value.totalRows)
        && typeof value.limitReached === 'boolean'
        && (value.rowsAffected === undefined || isNonNegativeInteger(value.rowsAffected))
        && (value.message === undefined || typeof value.message === 'string')
        && (value.commandType === undefined || typeof value.commandType === 'string')
        ? value as unknown as QueryEvent
        : undefined;
    case 'error':
      return typeof value.message === 'string' ? value as unknown as QueryEvent : undefined;
    case 'cancelled':
      return isNonNegativeInteger(value.totalRows)
        && (value.scope === undefined || value.scope === 'statement' || value.scope === 'batch')
        ? value as unknown as QueryEvent
        : undefined;
    case 'batch-complete':
      return (value.status === 'complete' || value.status === 'error' || value.status === 'cancelled')
        && isNonNegativeInteger(value.completedStatements)
        && (value.message === undefined || typeof value.message === 'string')
        ? value as unknown as QueryEvent
        : undefined;
    case 'started':
      return (value.startedAt === undefined || (typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)))
        && (value.mode === undefined || value.mode === 'single' || value.mode === 'script' || value.mode === 'explain')
        ? value as unknown as QueryEvent
        : undefined;
    case 'statement-started':
      return value.statementSql === undefined || typeof value.statementSql === 'string'
        ? value as unknown as QueryEvent
        : undefined;
  }
}

function trimBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/$/u, '');
}

function sameOriginWebSocketBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function websocketBaseUrlForHttpBase(httpBaseUrl: string): string | undefined {
  if (!httpBaseUrl) return undefined;
  try {
    const base = new URL(httpBaseUrl, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined;
    const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${base.host}`;
  } catch {
    return undefined;
  }
}

function readBrowserCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie.split('; ').find(value => value.startsWith('justybase_csrf='))?.slice('justybase_csrf='.length);
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const httpBaseUrl = trimBaseUrl(options.httpBaseUrl);
  const webSocketBaseUrl = trimBaseUrl(options.webSocketBaseUrl)
    || websocketBaseUrlForHttpBase(httpBaseUrl)
    || sameOriginWebSocketBaseUrl();
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('Fetch is unavailable. Provide fetch in ApiClientOptions.');
  const customCsrfAdapter = options.csrfAdapter;
  let csrfToken: string | undefined;
  let remoteCsrfBootstrap: Promise<string | undefined> | undefined;

  function isRemoteHttpOrigin(): boolean {
    if (!httpBaseUrl || typeof window === 'undefined') return false;
    try {
      return new URL(httpBaseUrl, window.location.href).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  function rememberCsrfToken(response: Response): void {
    if (customCsrfAdapter) return;
    const responseToken = response.headers.get('x-justybase-csrf');
    if (responseToken) csrfToken = responseToken;
  }

  async function fetchRemoteCsrfToken(): Promise<string | undefined> {
    if (remoteCsrfBootstrap) return remoteCsrfBootstrap;
    const bootstrap = (async (): Promise<string | undefined> => {
      try {
        const response = await fetchImpl(joinUrl(httpBaseUrl, '/api/auth/csrf'), {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        rememberCsrfToken(response);
        if (!response.ok) return undefined;
        const body = await response.json() as { csrfToken?: unknown };
        if (typeof body.csrfToken === 'string' && body.csrfToken.length > 0) csrfToken = body.csrfToken;
      } catch {
        return undefined;
      }
      return csrfToken;
    })();
    remoteCsrfBootstrap = bootstrap;
    try {
      return await bootstrap;
    } finally {
      if (remoteCsrfBootstrap === bootstrap) remoteCsrfBootstrap = undefined;
    }
  }

  async function resolveCsrfToken(path: string, method?: string): Promise<string | undefined> {
    if (customCsrfAdapter) return customCsrfAdapter();
    const remoteOrigin = isRemoteHttpOrigin();
    if (!remoteOrigin) {
      const browserToken = readBrowserCsrfCookie();
      if (browserToken) {
        csrfToken = browserToken;
        return browserToken;
      }
    }
    if (csrfToken) return csrfToken;
    const normalizedMethod = (method ?? 'GET').toUpperCase();
    if (!remoteOrigin || ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod) || path === '/api/auth/login' || path === '/api/auth/test-login') return undefined;
    return fetchRemoteCsrfToken();
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const csrf = await resolveCsrfToken(path, init?.method);
    const response = await fetchImpl(joinUrl(httpBaseUrl, path), {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf ? { 'x-justybase-csrf': csrf } : {}),
        ...(init?.headers ?? {}),
      },
      credentials: 'include',
    });
    rememberCsrfToken(response);
    const body = await readJsonResponse(response) as T | { message?: string };
    if (!response.ok) {
      throw new ApiRequestError(
        response.status,
        typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
          ? body.message
          : 'Request failed.',
      );
    }
    return body as T;
  }

  async function download(path: string, init: RequestInit, fallbackName: string): Promise<{ blob: Blob; fileName: string }> {
    const csrf = await resolveCsrfToken(path, init.method);
    const response = await fetchImpl(joinUrl(httpBaseUrl, path), {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(csrf ? { 'x-justybase-csrf': csrf } : {}),
      },
      credentials: 'include',
    });
    rememberCsrfToken(response);
    if (!response.ok) {
      const body = await readJsonResponse(response) as { message?: string };
      throw new ApiRequestError(response.status, body.message ?? 'Download failed.');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/iu.exec(disposition)?.[1] ?? fallbackName;
    return { blob: await response.blob(), fileName };
  }

  function connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: (error: Error) => void): QueryEventSubscription {
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let lastSequence = 0;

    const connect = (): void => {
      if (closed) return;
      socket = openWebSocket('/api/ws');
      socket.addEventListener('open', () => {
        reconnectAttempts = 0;
        socket?.send(JSON.stringify({ type: 'subscribe', queryId, afterSequence: lastSequence }));
      });
      socket.addEventListener('message', event => {
        try {
          const parsed = parseQueryEvent(JSON.parse(String(event.data)) as unknown, queryId);
          if (!parsed) return;
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
          if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
          onError?.(new Error('Query result stream disconnected after five reconnect attempts.'));
          return;
        }
        const delay = Math.min(5000, 200 * 2 ** Math.min(reconnectAttempts - 1, 4));
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    connect();
    return {
      close: () => {
        closed = true;
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        socket?.close();
      },
      getLastSequence: () => lastSequence,
    };
  }

  const openWebSocket = (path: string): WebSocket => {
    const WebSocketConstructor = options.WebSocket ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
    if (!WebSocketConstructor || !webSocketBaseUrl) throw new Error('WebSocket is unavailable. Provide WebSocket and webSocketBaseUrl in ApiClientOptions.');
    return new WebSocketConstructor(joinUrl(webSocketBaseUrl, path));
  };

  async function logout(): Promise<{ ok: true }> {
    try {
      return await request<{ ok: true }>('/api/auth/logout', { method: 'POST' });
    } finally {
      // A new login must never inherit a token issued for the previous
      // session. The browser cookie, when available, will be read again on
      // the next request.
      csrfToken = undefined;
      remoteCsrfBootstrap = undefined;
    }
  }

  return {
    me: () => request<{ user: WebUser }>('/api/auth/me'),
    login: (username: string, password: string) => request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    // Test credentials stay server-side. This request intentionally has no
    // body, so they cannot enter React state, the DOM, the URL, or storage.
    testLogin: () => request<AuthResponse>('/api/auth/test-login', { method: 'POST' }),
    logout,
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
    ddl: (input: MetadataDdlRequest) => request<MetadataDdlResponse>(`/api/metadata/ddl?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)] as [string, string])).toString()}`),
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
    cancelQuery: (queryId: string) => request<{ ok: true }>(`/api/query/${encodeURIComponent(queryId)}/cancel`, { method: 'POST' }),
    queryPage: (queryId: string, input: QueryPageRequest) => request<QueryPageResponse>(`/api/query/${encodeURIComponent(queryId)}/page`, { method: 'POST', body: JSON.stringify(input) }),
    aggregate: (queryId: string, input: QueryAggregateRequest = {}) => request<QueryAggregateResponse>(`/api/query/${encodeURIComponent(queryId)}/aggregate`, { method: 'POST', body: JSON.stringify(input) }),
    group: (queryId: string, input: QueryGroupRequest) => request<QueryGroupResponse>(`/api/query/${encodeURIComponent(queryId)}/group`, { method: 'POST', body: JSON.stringify(input) }),
    exportQuery: (queryId: string, input: QueryExportRequest) => download(`/api/query/${encodeURIComponent(queryId)}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, `justybase-query.${input.format}`),
    editorPreferences: () => request<EditorPreferences>('/api/preferences/editor'),
    updateEditorPreferences: (input: EditorPreferencesPatch) => request<EditorPreferences>('/api/preferences/editor', { method: 'PATCH', body: JSON.stringify(input) }),
    schemaTree: (connectionId: string, parentId?: string) => request<SchemaTreeResponse>(`/api/schema/tree?connectionId=${encodeURIComponent(connectionId)}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ''}`),
    searchSchema: (input: SchemaSearchRequest) => request<SchemaSearchResponse>('/api/schema/search', { method: 'POST', body: JSON.stringify(input) }),
    completion: (input: SqlCompletionRequest) => request<SqlCompletionResponse>('/api/lsp/completion', { method: 'POST', body: JSON.stringify(input) }),
    diagnostics: (input: SqlDiagnosticsRequest) => request<SqlDiagnosticsResponse>('/api/lsp/diagnostics', { method: 'POST', body: JSON.stringify(input) }),
    formatSql: (input: SqlFormatRequest) => request<SqlFormatResponse>('/api/lsp/format', { method: 'POST', body: JSON.stringify(input) }),
    snippets: (databaseKind?: DatabaseKind) => request<{ snippets: Array<{ prefix: string[]; body: string[]; description?: string }> }>(`/api/lsp/snippets${databaseKind ? `?databaseKind=${encodeURIComponent(databaseKind)}` : ''}`),
    adminUsers: () => request<AdminUserSummary[]>('/api/admin/users'),
    createAdminUser: (input: AdminUserCreateRequest) => request<AdminUserSummary>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
    updateAdminUser: (id: string, input: AdminUserUpdateRequest) => request<AdminUserSummary>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    adminBackup: () => download('/api/admin/backup', {}, 'justybase-backup.sqlite'),
    adminRestore: (input: AdminRestoreRequest) => request<AdminRestoreResponse>('/api/admin/restore', { method: 'POST', body: JSON.stringify(input) }),
    openWebSocket,
    connectToQueryEvents,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }): ReactElement {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used below ApiClientProvider.');
  return client;
}

/** Allows reusable Web panels to be embedded below a different composition root. */
export function useOptionalApiClient(): ApiClient | null {
  return useContext(ApiClientContext);
}
