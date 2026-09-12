import type {
  QueryEvent,
  QueryExportRequest,
  QueryPageRequest,
  QueryPageResponse,
  QueryStartRequest,
  QueryStartResponse,
} from '@justybase/contracts';

export interface QueryEventSubscription {
  close(): void;
  getLastSequence(): number;
}

export interface ElectronApiClient {
  startQuery(input: QueryStartRequest): Promise<QueryStartResponse>;
  queryPage(queryId: string, input: QueryPageRequest): Promise<QueryPageResponse>;
  cancelQuery(queryId: string): Promise<{ ok: true }>;
  exportQuery(queryId: string, input: QueryExportRequest): Promise<{ readonly blob: Blob; readonly fileName: string }>;
  connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: (error: Error) => void): QueryEventSubscription;
}

export interface ElectronApiClientOptions {
  readonly fetcher?: typeof globalThis.fetch;
  readonly WebSocket?: new (url: string) => WebSocket;
}

function csrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const raw = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('justybase_csrf='));
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.slice('justybase_csrf='.length));
  } catch {
    return raw.slice('justybase_csrf='.length);
  }
}

function websocketUrl(): string {
  if (typeof window === 'undefined' || !window.location.host) throw new Error('Electron WebSocket location is unavailable.');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') return value.message;
  return 'Electron API request failed.';
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isQueryEventColumn(value: unknown): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  return (value.type === undefined || typeof value.type === 'string')
    && (value.scale === undefined || (isNonNegativeInteger(value.scale) && value.scale <= 1000));
}

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

/** Same-origin API transport used after main has installed the session cookie. */
export function createElectronApiClient(options: ElectronApiClientOptions = {}): ElectronApiClient {
  const fetcher = options.fetcher ?? globalThis.fetch?.bind(globalThis) ?? (async () => {
    throw new Error('Fetch is unavailable in the Electron renderer.');
  }) as typeof fetch;

  async function request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const csrf = csrfCookie();
    const response = await fetcher(route, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-justybase-csrf': csrf } : {}),
        ...(init.headers ?? {}),
      },
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok) throw new Error(readErrorMessage(body));
    return body as T;
  }

  async function download(route: string, init: RequestInit, fallbackName: string): Promise<{ readonly blob: Blob; readonly fileName: string }> {
    const csrf = csrfCookie();
    const response = await fetcher(route, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/octet-stream, application/json',
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-justybase-csrf': csrf } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      let message = 'Electron export failed.';
      try { message = readErrorMessage(await response.json()); } catch { /* non-JSON error */ }
      throw new Error(message);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/iu.exec(disposition)?.[1] ?? fallbackName;
    return { blob: await response.blob(), fileName };
  }

  function connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: (error: Error) => void): QueryEventSubscription {
    const WebSocketConstructor = options.WebSocket ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
    if (!WebSocketConstructor) throw new Error('WebSocket is unavailable in the Electron renderer.');
    let socket: WebSocket | undefined;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let lastSequence = 0;

    const connect = (): void => {
      if (closed) return;
      socket = new WebSocketConstructor(websocketUrl());
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
          // The next replay starts after the last validated sequence.
        }
      });
      socket.addEventListener('error', () => socket?.close());
      socket.addEventListener('close', () => {
        if (closed) return;
        reconnectAttempts += 1;
        if (reconnectAttempts >= 5) {
          closed = true;
          onError?.(new Error('Electron query stream disconnected after five reconnect attempts.'));
          return;
        }
        reconnectTimer = setTimeout(connect, Math.min(5_000, 200 * 2 ** Math.min(reconnectAttempts - 1, 4)));
      });
    };

    connect();
    return {
      close: () => {
        closed = true;
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
        socket?.close();
        socket = undefined;
      },
      getLastSequence: () => lastSequence,
    };
  }

  return {
    startQuery: input => request<QueryStartResponse>('/api/query', { method: 'POST', body: JSON.stringify(input) }),
    queryPage: (queryId, input) => request<QueryPageResponse>(`/api/query/${encodeURIComponent(queryId)}/page`, { method: 'POST', body: JSON.stringify(input) }),
    cancelQuery: queryId => request<{ ok: true }>(`/api/query/${encodeURIComponent(queryId)}/cancel`, { method: 'POST' }),
    exportQuery: (queryId, input) => download(`/api/query/${encodeURIComponent(queryId)}/export`, { method: 'POST', body: JSON.stringify(input) }, `justybase-result.${input.format}`),
    connectToQueryEvents,
  };
}
