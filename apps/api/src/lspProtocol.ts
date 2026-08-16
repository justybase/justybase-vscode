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
  invalidateAll(): void;
}

function contextFor(context: SqlLanguageContext | undefined): WebLspContext {
  return { connectionName: context?.connectionId, effectiveDatabase: context?.database, effectiveSchema: context?.schema, databaseKind: context?.databaseKind ?? 'netezza', netezzaSchemasEnabled: true };
}

function objectKind(value: string | undefined): 'table' | 'view' | 'procedure' {
  const normalized = value?.toUpperCase();
  return normalized === 'VIEW' ? 'view' : normalized === 'PROCEDURE' ? 'procedure' : 'table';
}

export async function requestMetadata(params: WebLspMetadataRequestParams, documents: Map<string, DocumentState>, store: AppStore, config: ApiConfig, userId: string): Promise<unknown> {
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
    const schema = params.schema ?? context?.schema;
    if (params.kind === 'tableInfo') {
      const objects = await listObjects(profile, database, schema || undefined, config.masterKey);
      const exists = objects.some(item => item.name.toUpperCase() === params.table!.toUpperCase()
        && (!schema || item.schema?.toUpperCase() === schema.toUpperCase()));
      if (!exists) return { exists: false, table: params.table, database, schema: schema ?? '', columns: [] };
    }
    if (!schema) {
      return params.kind === 'columns'
        ? []
        : { exists: true, table: params.table, database, schema: '', columns: [] };
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
  return items.map(item => ({ range: item.range, severity: item.severity ?? 2, code: item.code, source: item.source ?? 'justybase-netezza', message: item.message, data: item.data }));
}

function completionResponse(items: CoreCompletionItem[]): Array<Record<string, unknown>> {
  return items.map(item => ({ label: item.label, kind: item.kind, detail: item.detail, insertText: item.insertText ?? item.label }));
}

function hoverResponse(hover: { range?: { start: { line: number; character: number }; end: { line: number; character: number } }; contents: { kind: string; value: string } } | null): Record<string, unknown> | null {
  if (!hover) return null;
  return { range: hover.range, contents: { kind: hover.contents.kind, value: hover.contents.value } };
}

function locationResponse(location: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | null): Record<string, unknown> | null {
  if (!location) return null;
  return { uri: location.uri, range: location.range };
}

function locationsResponse(locations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> | null): Array<Record<string, unknown>> | null {
  if (!locations) return null;
  return locations.map(location => ({ uri: location.uri, range: location.range }));
}

function workspaceEditResponse(edit: { changes: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>> } | null): Record<string, unknown> | null {
  if (!edit) return null;
  return { changes: edit.changes };
}

export function attachLspSocket(socket: WebSocketLike, store: AppStore, config: ApiConfig, userId: string, onClose?: (session: LspSession) => void): LspSession {
  const documents = new Map<string, DocumentState>();
  const knownConnectionIds = new Set<string>();
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

  const session: LspSession = {
    invalidateConnection: connectionId => core.clearConnection(connectionId),
    invalidateAll: () => { for (const connectionId of knownConnectionIds) core.clearConnection(connectionId); },
  };

  socket.on('message', raw => {
    let request: RpcRequest;
    try { request = JSON.parse(raw.toString()) as RpcRequest; } catch { return; }
    const params = request.params ?? {};
    void (async () => {
      try {
        if (request.method === 'initialize') {
          response(request.id, { capabilities: { textDocumentSync: 1, completionProvider: { triggerCharacters: ['.', ' ', '\n', '*'] }, diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }, hoverProvider: true, definitionProvider: true, referencesProvider: true, renameProvider: { prepareProvider: true }, inlayHintProvider: true, signatureHelpProvider: { triggerCharacters: ['(', ','] }, documentSymbolProvider: true, documentFormattingProvider: true, semanticTokensProvider: { full: true, legend: { tokenTypes: ['enumMember', 'function', 'keyword', 'macro', 'modifier', 'variable', 'type', 'column', 'table', 'alias', 'schema', 'database', 'localVariable'], tokenModifiers: ['readonly', 'defaultLibrary', 'italic'] } } } });
          return;
        }
        if (request.method === 'initialized' || request.method === 'shutdown') { if (request.method === 'shutdown') response(request.id, null); return; }
        if (request.method === 'justybase/documentContext') {
          const uri = typeof params.uri === 'string' ? params.uri : '';
          const document = documents.get(uri);
          if (document) {
            document.context = (params.context ?? {}) as SqlLanguageContext;
            if (document.context.connectionId) knownConnectionIds.add(document.context.connectionId);
            core.setContext(uri, contextFor(document.context));
          }
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
        if (request.method === 'textDocument/hover') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const hover = await core.hover(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 });
          response(request.id, hoverResponse(hover));
          return;
        }
        if (request.method === 'textDocument/definition') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const location = await core.definition(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 });
          response(request.id, locationResponse(location));
          return;
        }
        if (request.method === 'textDocument/references') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const context = params.context as { includeDeclaration?: boolean } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const locations = await core.references(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 }, context?.includeDeclaration ?? true);
          response(request.id, locationsResponse(locations));
          return;
        }
        if (request.method === 'textDocument/prepareRename') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const prepare = await core.prepareRename(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 });
          response(request.id, prepare ? { range: prepare.range, placeholder: prepare.placeholder } : null);
          return;
        }
        if (request.method === 'textDocument/rename') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const newName = typeof params.newName === 'string' ? params.newName : '';
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const edit = await core.rename(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 }, newName);
          response(request.id, workspaceEditResponse(edit));
          return;
        }
        if (request.method === 'textDocument/inlayHint') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document) { response(request.id, []); return; }
          const hints = await core.inlayHints(textDocument!.uri!, document.version, document.text);
          response(request.id, hints.map(hint => ({ position: hint.position, label: hint.label, kind: hint.kind ? { value: hint.kind, tooltip: undefined } : { value: 'type', tooltip: undefined } })));
          return;
        }
        if (request.method === 'textDocument/signatureHelp') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const position = params.position as { line?: number; character?: number } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document || !position) { response(request.id, null); return; }
          const help = await core.signatureHelp(textDocument!.uri!, document.version, document.text, { line: position.line ?? 0, character: position.character ?? 0 });
          response(request.id, help ? { signatures: help.signatures, activeSignature: help.activeSignature, activeParameter: help.activeParameter } : null);
          return;
        }
        if (request.method === 'textDocument/documentSymbol') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document) { response(request.id, []); return; }
          const symbols = await core.documentSymbols(textDocument!.uri!, document.version, document.text);
          response(request.id, symbols.map(symbol => ({ name: symbol.name, detail: symbol.detail, kind: symbol.kind, range: symbol.range, selectionRange: symbol.selectionRange, children: symbol.children })));
          return;
        }
        if (request.method === 'textDocument/formatting') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document) { response(request.id, []); return; }
          const options = params.options as { tabSize?: number; insertSpaces?: boolean; keywordCase?: 'upper' | 'lower' | 'preserve' } | undefined;
          const formatted = await core.format(document.text, document.context.databaseKind ?? 'netezza', { tabWidth: options?.insertSpaces === false ? 4 : Math.max(1, options?.tabSize ?? 4), keywordCase: options?.keywordCase });
          const lineCount = document.text.split('\n').length;
          response(request.id, [{ range: { start: { line: 0, character: 0 }, end: { line: Math.max(0, lineCount - 1), character: Number.MAX_SAFE_INTEGER } }, newText: formatted }]);
          return;
        }
        if (request.method === 'textDocument/semanticTokens/full') {
          const textDocument = params.textDocument as { uri?: string } | undefined;
          const document = textDocument?.uri ? documents.get(textDocument.uri) : undefined;
          if (!document) { response(request.id, { types: [], modifiers: [], tokens: [] }); return; }
          response(request.id, await core.semanticTokens(textDocument!.uri!, document.version, document.text));
          return;
        }
        if (request.method === 'justybase/statementNav') {
          const uri = typeof params.uri === 'string' ? params.uri : '';
          const offset = typeof params.offset === 'number' ? params.offset : 0;
          const direction = params.direction === 'before' ? 'before' : 'after';
          const document = uri ? documents.get(uri) : undefined;
          if (!document) { response(request.id, null); return; }
          const result = await core.window(uri, document.version, document.text, offset, 'sentence', direction);
          response(request.id, result);
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
