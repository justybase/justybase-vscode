import type { SqlLanguageContext } from '@justybase/contracts';
import { NetezzaWebLspCore, type CoreCompletionItem, type CoreDiagnostic, type WebLspContext, type WebLspMetadataRequestParams } from '@justybase/sql-core';
import { listColumns, listDatabases, listObjects, listSchemas } from './netezza';
import type { ApiConfig } from './config';
import type { AppStore } from './store';

interface WebSocketLike {
  readyState: number;
  send(payload: string): void;
  on(event: 'message' | 'close', handler: (payload: Buffer) => void): void;
}

interface RpcRequest { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; }
interface DocumentState { text: string; version: number; context: SqlLanguageContext; }

export interface LspSession {
  invalidateConnection(connectionId: string): void;
}

function contextFor(context: SqlLanguageContext | undefined): WebLspContext {
  return { connectionName: context?.connectionId, effectiveDatabase: context?.database, effectiveSchema: context?.schema, databaseKind: 'netezza', netezzaSchemasEnabled: true };
}

function objectKind(value: string | undefined): 'table' | 'view' | 'procedure' {
  const normalized = value?.toUpperCase();
  return normalized === 'VIEW' ? 'view' : normalized === 'PROCEDURE' ? 'procedure' : 'table';
}

async function requestMetadata(params: WebLspMetadataRequestParams, documents: Map<string, DocumentState>, store: AppStore, config: ApiConfig, userId: string): Promise<unknown> {
  const document = documents.get(params.documentUri);
  const context = document?.context;
  if (params.kind === 'context') return contextFor(context);
  const connectionId = context?.connectionId;
  const profile = connectionId ? store.getConnection(userId, connectionId) : undefined;
  if (!profile) return [];
  const database = params.database ?? context?.database;
  if (params.kind === 'databases') return listDatabases(profile, config.masterKey);
  if (!database) return [];
  if (params.kind === 'schemas') return listSchemas(profile, database, config.masterKey);
  if (params.kind === 'tables' || params.kind === 'views' || params.kind === 'procedures') {
    const objects = await listObjects(profile, database, params.schema, config.masterKey);
    const requested = params.kind === 'tables' ? 'TABLE' : params.kind === 'views' ? 'VIEW' : 'PROCEDURE';
    return objects.filter(item => requested === 'PROCEDURE' ? item.objectType?.toUpperCase() === 'PROCEDURE' : item.objectType?.toUpperCase() === requested).map(item => ({ name: item.name, database, schema: item.schema ?? params.schema, objectType: objectKind(item.objectType), description: item.description }));
  }
  if (params.kind === 'columns' || params.kind === 'tableInfo') {
    if (!params.table) return params.kind === 'columns' ? [] : null;
    const schema = params.schema ?? context?.schema ?? '';
    if (params.kind === 'tableInfo') {
      const objects = await listObjects(profile, database, schema || undefined, config.masterKey);
      const exists = objects.some(item => item.name.toUpperCase() === params.table!.toUpperCase()
        && (!schema || item.schema?.toUpperCase() === schema.toUpperCase()));
      if (!exists) return { exists: false, table: params.table, database, schema, columns: [] };
    }
    const columns = await listColumns(profile, database, schema, params.table, config.masterKey);
    if (params.kind === 'columns') return columns;
    return { exists: true, table: params.table, database, schema, columns };
  }
  if (params.kind === 'cachedTableInfo') return null;
  if (params.kind === 'warmDatabaseColumns' || params.kind === 'qualifyTable' || params.kind === 'netezzaDefaultSchema') return params.kind === 'qualifyTable' ? [] : null;
  return null;
}

function diagnosticResponse(items: CoreDiagnostic[]): Array<Record<string, unknown>> {
  return items.map(item => ({ range: item.range, severity: item.severity ?? 2, code: item.code, source: item.source ?? 'justybase-netezza', message: item.message }));
}

function completionResponse(items: CoreCompletionItem[]): Array<Record<string, unknown>> {
  return items.map(item => ({ label: item.label, kind: item.kind, detail: item.detail, insertText: item.insertText ?? item.label }));
}

export function attachLspSocket(socket: WebSocketLike, store: AppStore, config: ApiConfig, userId: string, onClose?: (session: LspSession) => void): LspSession {
  const documents = new Map<string, DocumentState>();
  const core = new NetezzaWebLspCore({
    requestMetadata: params => requestMetadata(params, documents, store, config, userId),
    logger: { error: message => console.error(message) },
  });
  const send = (message: unknown): void => { if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', ...message as object })); };
  const response = (id: number | string | undefined, result: unknown): void => { if (id !== undefined) send({ id, result }); };
  const error = (id: number | string | undefined, message: string): void => { if (id !== undefined) send({ id, error: { code: -32603, message } }); };

  async function publishDiagnostics(uri: string): Promise<void> {
    const document = documents.get(uri);
    if (!document) return;
    const version = document.version;
    const text = document.text;
    const items = await core.diagnostics(uri, version, text);
    const current = documents.get(uri);
    if (!current || current.version !== version || current.text !== text) return;
    send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: diagnosticResponse(items) } });
  }

  const session: LspSession = { invalidateConnection: connectionId => core.clearConnection(connectionId) };

  socket.on('message', raw => {
    let request: RpcRequest;
    try { request = JSON.parse(raw.toString()) as RpcRequest; } catch { return; }
    const params = request.params ?? {};
    void (async () => {
      try {
        if (request.method === 'initialize') {
          response(request.id, { capabilities: { textDocumentSync: 1, completionProvider: { triggerCharacters: ['.', ' ', '\n', '*'] }, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } });
          return;
        }
        if (request.method === 'initialized' || request.method === 'shutdown') { if (request.method === 'shutdown') response(request.id, null); return; }
        if (request.method === 'justybase/documentContext') {
          const uri = typeof params.uri === 'string' ? params.uri : '';
          const document = documents.get(uri);
          if (document) { document.context = (params.context ?? {}) as SqlLanguageContext; core.setContext(uri, contextFor(document.context)); }
          return;
        }
        if (request.method === 'textDocument/didOpen') {
          const textDocument = params.textDocument as { uri?: string; text?: string; version?: number } | undefined;
          if (textDocument?.uri) {
            const state: DocumentState = { text: textDocument.text ?? '', version: textDocument.version ?? 1, context: {} };
            documents.set(textDocument.uri, state);
            core.setContext(textDocument.uri, contextFor(state.context));
            await publishDiagnostics(textDocument.uri);
          }
          return;
        }
        if (request.method === 'textDocument/didChange') {
          const textDocument = params.textDocument as { uri?: string; version?: number } | undefined;
          const changes = params.contentChanges as Array<{ text?: string }> | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (document && changes && changes.length > 0 && textDocument?.uri) {
            document.text = changes[changes.length - 1]?.text ?? document.text;
            document.version = textDocument.version ?? document.version + 1;
            await publishDiagnostics(textDocument.uri);
          }
          return;
        }
        if (request.method === 'textDocument/didClose') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          if (textDocument?.uri) { documents.delete(textDocument.uri); core.close(textDocument.uri); send({ method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics: [] } }); }
          return;
        }
        if (request.method === 'textDocument/completion') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, { isIncomplete: false, items: [] }); return; }
          const items = await core.completion(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 });
          response(request.id, { isIncomplete: false, items: completionResponse(items) });
          return;
        }
        if (request.method === 'textDocument/diagnostic') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          response(request.id, { kind: 'full', items: document ? diagnosticResponse(await core.diagnostics(textDocument!.uri!, document.version, document.text)) : [] });
          return;
        }
        if (request.id !== undefined) response(request.id, null);
      } catch (reason: unknown) { error(request.id, reason instanceof Error ? reason.message : 'LSP request failed.'); }
    })();
  });
  socket.on('close', () => { for (const uri of documents.keys()) core.close(uri); documents.clear(); onClose?.(session); });
  send({ method: 'justybase/ready', params: { sessionId: String(Date.now()) } });
  return session;
}
