import type { SqlCompletionItem, SqlCompletionRequest, SqlCompletionResponse, SqlDiagnostic, SqlDiagnosticsRequest, SqlDiagnosticsResponse, SqlFormatRequest, SqlFormatResponse, SqlLanguageContext } from '@justybase/contracts';
import { NetezzaWebLspCore, type CoreDiagnostic } from './sqlCoreLsp';
import { requestMetadata } from './lspProtocol';
import type { ApiConfig } from './config';
import type { ApiDatabaseRuntimeRegistry } from './databaseRuntime/contracts';
import type { AppStore, StoredConnection } from './store';
import { ApiMetadataService } from './metadataCache';
import { getSqlAuthoring } from './sqlAuthoring';

interface HttpDocumentState { text: string; version: number; context: SqlLanguageContext; }
interface HttpCoreCacheEntry {
  connectionId?: string;
  documentUri: string;
  documents: Map<string, HttpDocumentState>;
  core: NetezzaWebLspCore;
}

function getProfile(store: AppStore, userId: string, connectionId: string | undefined): StoredConnection | undefined {
  return connectionId ? store.getConnection(userId, connectionId) : undefined;
}

export async function provideSqlCompletion(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  request: SqlCompletionRequest,
  metadataService = new ApiMetadataService(),
): Promise<SqlCompletionResponse> {
  const entry = getHttpCore(store, runtimes, userId, request, metadataService);
  const position = positionAt(request.sql, request.offset);
  const items = await entry.core.completion(entry.documentUri, entry.documents.get(entry.documentUri)?.version ?? 1, request.sql, position);
  return { items: items.map(toHttpCompletionItem) };
}

function getHttpCore(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  request: SqlCompletionRequest,
  metadataService: ApiMetadataService,
): HttpCoreCacheEntry {
  const context: SqlLanguageContext = {
    connectionId: request.connectionId,
    database: request.database,
    schema: request.schema,
    databaseKind: request.databaseKind ?? 'netezza',
  };
  const connectionId = context.connectionId ?? '-';
  const keyParts = [context.database, context.schema];
  const entry = metadataService.getOrCreateContext(
    userId,
    { id: connectionId, dbType: context.databaseKind },
    'lsp-core',
    keyParts,
    () => {
      const key = [userId, connectionId, context.database ?? '-', context.schema ?? '-'].map(value => encodeURIComponent(value)).join('|');
      const documentUri = `http://justybase.invalid/${encodeURIComponent(userId)}/completion/${key}`;
      const documents = new Map<string, HttpDocumentState>();
      const core = new NetezzaWebLspCore({
        requestMetadata: params => requestMetadata(params, documents, store, runtimes, userId, metadataService),
        authoring: getSqlAuthoring(context.databaseKind),
      });
      return {
        connectionId: context.connectionId,
        documentUri,
        documents,
        core,
      };
    },
  );
  const previous = entry.documents.get(entry.documentUri);
  entry.documents.set(entry.documentUri, {
    text: request.sql,
    version: (previous?.version ?? 0) + 1,
    context,
  });
  entry.core.setContext(entry.documentUri, {
    connectionName: context.connectionId,
    effectiveDatabase: context.database,
    effectiveSchema: context.schema,
    databaseKind: context.databaseKind,
    netezzaSchemasEnabled: true,
  });
  return entry;
}

function toHttpCompletionItem(item: { label: string; kind?: number; detail?: string; insertText?: string }): SqlCompletionItem {
  const kind = item.kind === 14
    ? 'keyword'
    : item.kind === 3
      ? 'function'
      : item.kind === 5
        ? 'column'
        : item.kind === 17
          ? 'view'
          : item.kind === 9
            ? item.detail?.toLocaleLowerCase().startsWith('schema') ? 'schema' : 'database'
            : 'table';
  return { label: item.label, kind, detail: item.detail, insertText: item.insertText };
}

function positionAt(sql: string, offset: number): { line: number; character: number } {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  const before = sql.slice(0, safeOffset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
}

function diagnostic(sql: string, message: string, severity: SqlDiagnostic['severity'], offset: number, code: string): SqlDiagnostic {
  return { message, severity, code, start: positionAt(sql, offset), end: positionAt(sql, Math.min(sql.length, offset + 1)) };
}

interface LegacyDelimiterState {
  quoteOpen: boolean;
  parentheses: number;
  unexpectedClosingParenthesisOffsets: number[];
}

function scanLegacyDelimiters(sql: string): LegacyDelimiterState {
  let quoteOpen = false;
  let parentheses = 0;
  const unexpectedClosingParenthesisOffsets: number[] = [];
  for (let index = 0; index < sql.length; index += 1) {
    if (sql[index] === "'" && sql[index + 1] === "'") { index += 1; continue; }
    if (sql[index] === "'") { quoteOpen = !quoteOpen; continue; }
    if (quoteOpen) continue;
    if (sql[index] === '(') parentheses += 1;
    if (sql[index] === ')') {
      parentheses -= 1;
      if (parentheses < 0) {
        unexpectedClosingParenthesisOffsets.push(index);
        parentheses = 0;
      }
    }
  }
  return { quoteOpen, parentheses, unexpectedClosingParenthesisOffsets };
}

function mapCoreDiagnostic(sql: string, item: CoreDiagnostic, state: LegacyDelimiterState): SqlDiagnostic {
  const parserCode = String(item.code ?? '');
  const code = parserCode.startsWith('LEX') && state.quoteOpen
    ? 'WEB002'
    : parserCode.startsWith('PAR') && state.unexpectedClosingParenthesisOffsets.length > 0
      ? 'WEB001'
      : parserCode.startsWith('PAR') && state.parentheses > 0
        ? 'WEB003'
        : parserCode;
  const message = code === 'WEB001'
    ? 'Unexpected closing parenthesis.'
    : code === 'WEB002'
      ? 'Unterminated string literal.'
      : code === 'WEB003'
        ? 'Unclosed parenthesis.'
        : item.message;
  const compatibilityPosition = code === 'WEB003' ? positionAt(sql, sql.length) : undefined;
  return {
    message,
    severity: item.severity === 1 ? 'error' : 'warning',
    code: code || undefined,
    start: compatibilityPosition ?? item.range.start,
    end: compatibilityPosition ?? item.range.end,
    data: item.data,
  };
}

async function provideDialectDiagnostics(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  request: SqlDiagnosticsRequest,
  metadataService: ApiMetadataService,
): Promise<SqlDiagnostic[]> {
  const documentUri = `http://justybase.invalid/${encodeURIComponent(userId)}/lsp-diagnostics`;
  const documents = new Map([[documentUri, {
    text: request.sql,
    version: 1,
    context: {
      connectionId: request.connectionId,
      database: request.database,
      schema: request.schema,
      databaseKind: request.databaseKind ?? 'netezza',
    },
  }]]);
  const core = new NetezzaWebLspCore({
    requestMetadata: params => requestMetadata(params, documents, store, runtimes, userId, metadataService),
    authoring: getSqlAuthoring(request.databaseKind),
  });
  core.setContext(documentUri, {
    connectionName: request.connectionId,
    effectiveDatabase: request.database,
    effectiveSchema: request.schema,
    databaseKind: request.databaseKind ?? 'netezza',
    netezzaSchemasEnabled: true,
  });
  const state = scanLegacyDelimiters(request.sql);
  const diagnostics = await core.diagnostics(documentUri, 1, request.sql);
  return diagnostics.map(item => mapCoreDiagnostic(request.sql, item, state));
}

export async function provideSqlDiagnostics(
  store: AppStore,
  runtimes: ApiDatabaseRuntimeRegistry,
  userId: string,
  request: SqlDiagnosticsRequest,
  metadataService = new ApiMetadataService(),
): Promise<SqlDiagnosticsResponse> {
  const sql = request.sql;
  const diagnostics = await provideDialectDiagnostics(store, runtimes, userId, request, metadataService);
  const profile = getProfile(store, userId, request.connectionId);
  if (profile?.readOnly && sql.trim() && !runtimes.isReadOnlySql(profile, sql)) diagnostics.push(diagnostic(sql, 'This connection is read-only; the statement may be rejected.', 'warning', 0, 'WEB004'));
  return { diagnostics };
}

/** Direct HTTP formatter for clients that do not keep the LSP WebSocket open. */
export async function formatSqlDocument(_store: AppStore, _config: ApiConfig, _userId: string, request: SqlFormatRequest): Promise<SqlFormatResponse> {
  const core = new NetezzaWebLspCore({ requestMetadata: async params => params.kind === 'context' ? { databaseKind: 'netezza' } : [] });
  return { sql: await core.format(request.sql, { databaseKind: request.databaseKind ?? 'netezza', tabWidth: Math.max(1, request.tabSize ?? 4), keywordCase: request.keywordCase }) };
}
