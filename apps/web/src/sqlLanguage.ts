import type * as Monaco from 'monaco-editor';
import type { SqlLanguageContext } from '@justybase/contracts';
import { api } from './api';

interface RpcMessage { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown>; }
interface PendingRequest { resolve(value: unknown): void; reject(reason: unknown): void; }

class WebLspClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readonly ready: Promise<void>;
  private readonly uri: string;
  private readonly getContext: () => SqlLanguageContext;
  private onDiagnostics: ((params: Record<string, unknown>) => void) | undefined;

  public constructor(uri: string, getContext: () => SqlLanguageContext) {
    this.uri = uri;
    this.getContext = getContext;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(`${protocol}//${window.location.host}/api/lsp`);
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => {
        void this.request('initialize', { capabilities: {}, initializationOptions: {} }).then(() => {
          this.notify('initialized', {});
          this.notify('textDocument/didOpen', { textDocument: { uri: this.uri, languageId: 'sql', version: 1, text: '' } });
          resolve();
        }).catch(reject);
      });
      this.socket.addEventListener('error', () => reject(new Error('LSP WebSocket unavailable.')));
    });
    this.socket.addEventListener('message', event => {
      let message: RpcMessage;
      try { message = JSON.parse(String(event.data)) as RpcMessage; } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'LSP request failed.'));
        else pending.resolve(message.result);
      } else if (message.method === 'textDocument/publishDiagnostics' && message.params) this.onDiagnostics?.(message.params);
    });
  }

  public setDiagnosticsHandler(handler: (params: Record<string, unknown>) => void): void { this.onDiagnostics = handler; }
  public async initialize(model: Monaco.editor.ITextModel): Promise<void> {
    await this.ready;
    this.notify('justybase/documentContext', { uri: this.uri, context: this.getContext() });
    this.notify('textDocument/didChange', { textDocument: { uri: this.uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] });
  }
  public didChange(model: Monaco.editor.ITextModel): void {
    this.notify('justybase/documentContext', { uri: this.uri, context: this.getContext() });
    this.notify('textDocument/didChange', { textDocument: { uri: this.uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] });
  }
  public completion(position: Monaco.Position): Promise<unknown> {
    this.notify('justybase/documentContext', { uri: this.uri, context: this.getContext() });
    return this.ready.then(() => this.request('textDocument/completion', { textDocument: { uri: this.uri }, position: { line: position.lineNumber - 1, character: position.column - 1 } }));
  }
  public dispose(): void {
    this.notify('textDocument/didClose', { textDocument: { uri: this.uri } });
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error('LSP client disposed.'));
    this.pending.clear();
  }
  private notify(method: string, params: unknown): void { if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params })); }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
}

function completionKind(monaco: typeof Monaco, kind: number): Monaco.languages.CompletionItemKind {
  if (kind === 3) return monaco.languages.CompletionItemKind.Function;
  if (kind === 5) return monaco.languages.CompletionItemKind.Field;
  if (kind === 7) return monaco.languages.CompletionItemKind.Struct;
  if (kind === 8) return monaco.languages.CompletionItemKind.Interface;
  return monaco.languages.CompletionItemKind.Keyword;
}

export function registerSqlLanguageFeatures(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco, getContext: () => SqlLanguageContext): void {
  const model = editor.getModel();
  if (!model) return;
  const client = new WebLspClient(model.uri.toString(), getContext);
  const setMarkers = (params: Record<string, unknown>): void => {
    const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics as Array<Record<string, unknown>> : [];
    monaco.editor.setModelMarkers(model, 'justybase-netezza-lsp', diagnostics.map(item => {
      const range = item.range as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
      const start = range?.start ?? {};
      const end = range?.end ?? start;
      return { message: String(item.message ?? ''), severity: Number(item.severity) === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, startLineNumber: Number(start.line ?? 0) + 1, startColumn: Number(start.character ?? 0) + 1, endLineNumber: Number(end.line ?? start.line ?? 0) + 1, endColumn: Math.max(Number(start.character ?? 0) + 2, Number(end.character ?? 0) + 1) };
    }));
  };
  client.setDiagnosticsHandler(setMarkers);
  void client.initialize(model).catch(async () => {
    try { const response = await api.diagnostics({ ...getContext(), sql: model.getValue() }); setMarkers({ diagnostics: response.diagnostics.map(item => ({ message: item.message, severity: item.severity === 'error' ? 1 : 2, range: { start: item.start, end: item.end } })) }); } catch { /* editor remains usable without diagnostics */ }
  });
  const changeDisposable = model.onDidChangeContent(() => client.didChange(model));
  const completionDisposable = monaco.languages.registerCompletionItemProvider('sql', { triggerCharacters: ['.', ' ', '\n'], provideCompletionItems: async (completionModel, position) => {
    try {
      const response = await client.completion(position) as { items?: Array<{ label: string; kind?: number; detail?: string; insertText?: string }> };
      const word = completionModel.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: (response.items ?? []).map(item => ({ label: item.label, kind: completionKind(monaco, item.kind ?? 14), detail: item.detail, insertText: item.insertText ?? item.label, range })) };
    } catch {
      try { const response = await api.completion({ ...getContext(), sql: completionModel.getValue(), offset: completionModel.getOffsetAt(position) }); const word = completionModel.getWordUntilPosition(position); const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn); return { suggestions: response.items.map(item => ({ label: item.label, kind: completionKind(monaco, item.kind === 'function' ? 3 : item.kind === 'column' ? 5 : 14), detail: item.detail, insertText: item.insertText ?? item.label, range })) }; } catch { return { suggestions: [] }; }
    }
  } });
  editor.onDidDispose(() => { changeDisposable.dispose(); completionDisposable.dispose(); client.dispose(); });
}
