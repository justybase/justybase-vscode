import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { api } from './api';

interface RpcMessage { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown>; }
interface PendingRequest { resolve(value: unknown): void; reject(reason: unknown): void; }

interface CoreRangeLike { start: { line: number; character: number }; end: { line: number; character: number }; }
interface CoreSymbolLike { name: string; detail: string; kind: number; range: CoreRangeLike; selectionRange: CoreRangeLike; children?: CoreSymbolLike[]; }
interface CoreSignatureParameterLike { label: string; documentation?: string; }
interface CoreSignatureInformationLike { label: string; documentation?: string; parameters: CoreSignatureParameterLike[]; }
interface CoreSignatureHelpLike { signatures: CoreSignatureInformationLike[]; activeSignature: number; activeParameter: number; }
interface CoreSignatureHelpLike { signatures: CoreSignatureInformationLike[]; activeSignature: number; activeParameter: number; }
interface CoreSemanticTokenLike { line: number; character: number; length: number; type: string; modifiers: string[]; }
interface WebSnippetLike { prefix: string[]; body: string[]; description?: string; }

let cachedSnippets: Promise<WebSnippetLike[]> | null = null;
function loadSnippets(): Promise<WebSnippetLike[]> {
  if (!cachedSnippets) cachedSnippets = api.snippets().then(response => response.snippets ?? []).catch(() => []);
  return cachedSnippets;
}

function lspPosition(position: Monaco.Position): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

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
    this.syncContext();
    this.notify('textDocument/didChange', { textDocument: { uri: this.uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] });
  }
  public didChange(model: Monaco.editor.ITextModel): void {
    this.syncContext();
    this.notify('textDocument/didChange', { textDocument: { uri: this.uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] });
  }
  public completion(position: Monaco.Position): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/completion', { textDocument: { uri: this.uri }, position: lspPosition(position) }));
  }
  public hover(position: Monaco.Position): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/hover', { textDocument: { uri: this.uri }, position: lspPosition(position) }));
  }
  public definition(position: Monaco.Position): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/definition', { textDocument: { uri: this.uri }, position: lspPosition(position) }));
  }
  public references(position: Monaco.Position, includeDeclaration: boolean): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/references', { textDocument: { uri: this.uri }, position: lspPosition(position), context: { includeDeclaration } }));
  }
  public prepareRename(position: Monaco.Position): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/prepareRename', { textDocument: { uri: this.uri }, position: lspPosition(position) }));
  }
  public rename(position: Monaco.Position, newName: string): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/rename', { textDocument: { uri: this.uri }, position: lspPosition(position), newName }));
  }
  public signatureHelp(position: Monaco.Position): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/signatureHelp', { textDocument: { uri: this.uri }, position: lspPosition(position) }));
  }
  public documentSymbols(): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/documentSymbol', { textDocument: { uri: this.uri } }));
  }
  public inlayHints(): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/inlayHint', { textDocument: { uri: this.uri } }));
  }
  public formatting(options: { tabSize: number; insertSpaces: boolean; keywordCase?: EditorPreferences['keywordCase'] }): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/formatting', { textDocument: { uri: this.uri }, options }));
  }
  public semanticTokens(): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('textDocument/semanticTokens/full', { textDocument: { uri: this.uri } }));
  }
  public statementNav(offset: number, direction: 'before' | 'after'): Promise<unknown> {
    this.syncContext();
    return this.ready.then(() => this.request('justybase/statementNav', { uri: this.uri, offset, direction }));
  }
  public dispose(): void {
    this.notify('textDocument/didClose', { textDocument: { uri: this.uri } });
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error('LSP client disposed.'));
    this.pending.clear();
  }
  private syncContext(): void { this.notify('justybase/documentContext', { uri: this.uri, context: this.getContext() }); }
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

function monacoRange(_monaco: typeof Monaco, range: CoreRangeLike | undefined): Monaco.IRange {
  const start = range?.start ?? { line: 0, character: 0 };
  const end = range?.end ?? start;
  return { startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 };
}

function monacoLocation(monaco: typeof Monaco, location: { uri?: string; range?: CoreRangeLike }): Monaco.languages.Location | null {
  if (!location || !location.uri || !location.range) return null;
  return { uri: monaco.Uri.parse(location.uri), range: monacoRange(monaco, location.range) };
}

function monacoDocumentSymbol(_monaco: typeof Monaco, symbol: CoreSymbolLike): Monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: symbol.kind,
    tags: [],
    range: monacoRange(_monaco, symbol.range),
    selectionRange: monacoRange(_monaco, symbol.selectionRange),
    children: (symbol.children ?? []).map(child => monacoDocumentSymbol(_monaco, child)),
  };
}

function monacoSignatureHelp(_monaco: typeof Monaco, help: CoreSignatureHelpLike): Monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map(signature => ({
      label: signature.label,
      documentation: signature.documentation,
      parameters: signature.parameters.map(parameter => ({ label: parameter.label, documentation: parameter.documentation })),
    })),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  };
}

export function registerSqlLanguageFeatures(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco, getContext: () => SqlLanguageContext, getPreferences: () => EditorPreferences | null = () => null): void {
  const model = editor.getModel();
  if (!model) return;
  const client = new WebLspClient(model.uri.toString(), getContext);
  const suggestedFixes = new Map<string, string>();
  const markerKey = (code: string, line: number, character: number): string => `${code}:${line}:${character}`;
  const setMarkers = (params: Record<string, unknown>): void => {
    const preferences = getPreferences();
    const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics as Array<Record<string, unknown>> : [];
    suggestedFixes.clear();
    if (preferences?.linterEnabled === false) {
      monaco.editor.setModelMarkers(model, 'justybase-netezza-lsp', []);
      return;
    }
    monaco.editor.setModelMarkers(model, 'justybase-netezza-lsp', diagnostics.filter(item => {
      const code = typeof item.code === 'string' || typeof item.code === 'number' ? String(item.code) : '';
      const range = item.range as { start?: { line?: number; character?: number } } | undefined;
      const suggestedFix = (item.data as { suggestedFix?: unknown } | undefined)?.suggestedFix;
      if (typeof suggestedFix === 'string' && suggestedFix.trim()) suggestedFixes.set(markerKey(code, Number(range?.start?.line ?? 0), Number(range?.start?.character ?? 0)), suggestedFix);
      return preferences?.linterRules[code] !== 'off';
    }).map(item => {
      const range = item.range as { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined;
      const start = range?.start ?? {};
      const end = range?.end ?? start;
      const code = typeof item.code === 'string' || typeof item.code === 'number' ? String(item.code) : '';
      const configuredSeverity = preferences?.linterRules[code];
      const wireSeverity = Number(item.severity);
      const severity = configuredSeverity === 'error' ? monaco.MarkerSeverity.Error
        : configuredSeverity === 'warning' ? monaco.MarkerSeverity.Warning
          : configuredSeverity === 'information' ? monaco.MarkerSeverity.Info
            : configuredSeverity === 'hint' ? monaco.MarkerSeverity.Hint
              : wireSeverity === 1 ? monaco.MarkerSeverity.Error
                : wireSeverity === 3 ? monaco.MarkerSeverity.Info
                  : wireSeverity === 4 ? monaco.MarkerSeverity.Hint
                    : monaco.MarkerSeverity.Warning;
      return { message: String(item.message ?? ''), severity, code, startLineNumber: Number(start.line ?? 0) + 1, startColumn: Number(start.character ?? 0) + 1, endLineNumber: Number(end.line ?? start.line ?? 0) + 1, endColumn: Math.max(Number(start.character ?? 0) + 2, Number(end.character ?? 0) + 1), data: item.data as { suggestedFix?: string } | undefined };
    }));
  };
  client.setDiagnosticsHandler(setMarkers);
  void client.initialize(model).catch(async () => {
    try { const response = await api.diagnostics({ ...getContext(), sql: model.getValue() }); setMarkers({ diagnostics: response.diagnostics.map(item => ({ message: item.message, code: item.code, severity: item.severity === 'error' ? 1 : 2, range: { start: item.start, end: item.end } })) }); } catch { /* editor remains usable without diagnostics */ }
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
  const snippetDisposable = monaco.languages.registerCompletionItemProvider('sql', { provideCompletionItems: async (completionModel, position) => {
    const snippets = await loadSnippets();
    const word = completionModel.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const prefix = word.word.toLowerCase();
    return {
      suggestions: snippets
        .filter(snippet => snippet.prefix.some(item => item.toLowerCase().startsWith(prefix)))
        .map(snippet => ({
          label: snippet.prefix[0] ?? '',
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: snippet.description,
          insertText: snippet.body.join('\n'),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
    };
  } });
  const hoverDisposable = monaco.languages.registerHoverProvider('sql', {
    provideHover: async (_hoverModel, position) => {
      try {
        const response = await client.hover(position) as { contents?: { value?: string } | Array<{ value?: string }>; range?: CoreRangeLike } | null;
        if (!response?.contents) return null;
        const contents = Array.isArray(response.contents) ? response.contents : [response.contents];
        return { contents: contents.filter(item => !!item?.value).map(item => ({ value: String(item.value), isTrusted: true })) };
      } catch { return null; }
    },
  });
  const definitionDisposable = monaco.languages.registerDefinitionProvider('sql', {
    provideDefinition: async (_definitionModel, position) => {
      try {
        const response = await client.definition(position) as { uri?: string; range?: CoreRangeLike } | null;
        return monacoLocation(monaco, response ?? {});
      } catch { return null; }
    },
  });
  const referenceDisposable = monaco.languages.registerReferenceProvider('sql', {
    provideReferences: async (_referenceModel, position, context) => {
      try {
        const response = await client.references(position, context.includeDeclaration) as Array<{ uri?: string; range?: CoreRangeLike }> | null;
        return (response ?? []).map(location => monacoLocation(monaco, location)).filter((location): location is Monaco.languages.Location => location !== null);
      } catch { return []; }
    },
  });
  const renameDisposable = monaco.languages.registerRenameProvider('sql', {
    provideRenameEdits: async (_renameModel, position, newName) => {
      const response = await client.rename(position, newName) as { changes?: Record<string, Array<{ range?: CoreRangeLike; newText?: string }>> } | null;
      if (!response?.changes) throw new Error('No rename target at position.');
      const edits: Array<Monaco.languages.IWorkspaceTextEdit> = [];
      for (const [uri, textEdits] of Object.entries(response.changes)) {
        for (const textEdit of textEdits ?? []) {
          if (!textEdit.range) continue;
          edits.push({ resource: monaco.Uri.parse(uri), versionId: undefined, textEdit: { range: monacoRange(monaco, textEdit.range), text: textEdit.newText ?? '' } });
        }
      }
      return { edits };
    },
    resolveRenameLocation: async (_renameModel, position) => {
      try {
        const response = await client.prepareRename(position) as { range?: CoreRangeLike; placeholder?: string } | null;
        if (!response?.range) return null;
        return { range: monacoRange(monaco, response.range), text: response.placeholder ?? '' };
      } catch { return null; }
    },
  });
  const signatureHelpDisposable = monaco.languages.registerSignatureHelpProvider('sql', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: async (_signatureModel, position) => {
      try {
        const response = await client.signatureHelp(position) as CoreSignatureHelpLike | null;
        if (!response) return undefined;
        return { value: monacoSignatureHelp(monaco, response), dispose: () => undefined };
      } catch { return undefined; }
    },
  });
  const documentSymbolDisposable = monaco.languages.registerDocumentSymbolProvider('sql', {
    provideDocumentSymbols: async () => {
      try {
        const response = await client.documentSymbols() as CoreSymbolLike[] | null;
        return (response ?? []).map(symbol => monacoDocumentSymbol(monaco, symbol));
      } catch { return []; }
    },
  });
  const inlayHintsDisposable = monaco.languages.registerInlayHintsProvider('sql', {
    provideInlayHints: async (_inlayModel, _range, token) => {
      try {
        if (getPreferences()?.inlineTypeHints === false) return { hints: [], dispose: () => undefined };
        const response = await client.inlayHints() as Array<{ position?: { line?: number; character?: number }; label?: string; kind?: 'type' | 'parameter' | null }> | null;
        if (token.isCancellationRequested) return { hints: [], dispose: () => undefined };
        return {
          hints: (response ?? []).map(hint => ({
            position: { lineNumber: (hint.position?.line ?? 0) + 1, column: (hint.position?.character ?? 0) + 1 },
            label: hint.label ?? '',
            kind: hint.kind === 'parameter' ? monaco.languages.InlayHintKind.Parameter : monaco.languages.InlayHintKind.Type,
          })),
          dispose: () => undefined,
        };
      } catch { return { hints: [], dispose: () => undefined }; }
    },
  });
  const formatDisposable = monaco.languages.registerDocumentFormattingEditProvider('sql', {
    provideDocumentFormattingEdits: async (formatModel, options) => {
      const tabSize = options.tabSize;
      const insertSpaces = options.insertSpaces;
      try {
        const changes = await client.formatting({ tabSize, insertSpaces, keywordCase: getPreferences()?.keywordCase }) as Array<{ range?: CoreRangeLike; newText?: string }> | null;
        if (!Array.isArray(changes)) return [];
        return changes.map(change => ({ range: monacoRange(monaco, change.range), text: change.newText ?? '' }));
      } catch {
        try {
          const response = await api.formatSql({ ...getContext(), sql: formatModel.getValue(), tabSize, insertSpaces, keywordCase: getPreferences()?.keywordCase });
          return [{ range: new monaco.Range(1, 1, formatModel.getLineCount(), formatModel.getLineMaxColumn(formatModel.getLineCount())), text: response.sql }];
        } catch { return []; }
      }
    },
  });
  const codeActionDisposable = monaco.languages.registerCodeActionProvider('sql', {
    provideCodeActions: (actionModel, _range, context) => {
      const actions = context.markers.flatMap(marker => {
        const code = typeof marker.code === 'string' ? marker.code : typeof marker.code === 'object' ? marker.code.value : '';
        const suggestedFix = suggestedFixes.get(markerKey(code, marker.startLineNumber - 1, marker.startColumn - 1));
        if (!suggestedFix) return [];
        return [{
          title: `Apply ${code || 'SQL'} quick-fix`,
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: [marker],
          edit: {
            edits: [{ resource: actionModel.uri, versionId: actionModel.getVersionId(), textEdit: { range: { startLineNumber: marker.startLineNumber, startColumn: marker.startColumn, endLineNumber: marker.endLineNumber, endColumn: marker.endColumn }, text: suggestedFix } }],
          },
        } satisfies Monaco.languages.CodeAction];
      });
      return { actions, dispose: () => undefined };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // Semantic tokens (no TextMate grammar on the web — lexer/CST-based provider)
  const semanticTokenLegend: Monaco.languages.SemanticTokensLegend = {
    tokenTypes: ['enumMember', 'function', 'keyword', 'macro', 'modifier', 'variable', 'type', 'column', 'table', 'alias', 'schema', 'database', 'localVariable'],
    tokenModifiers: ['readonly', 'defaultLibrary', 'italic'],
  };
  const semanticTokenDisposable = monaco.languages.registerDocumentSemanticTokensProvider('sql', {
    getLegend: () => semanticTokenLegend,
    provideDocumentSemanticTokens: async () => {
      try {
        const response = await client.semanticTokens() as { types?: string[]; modifiers?: string[]; tokens?: CoreSemanticTokenLike[] } | null;
        if (!response || !Array.isArray(response.tokens)) return { data: new Uint32Array(0) };
        const typeIndex = new Map((response.types ?? []).map((name, index) => [name, index]));
        const modifierIndex = new Map((response.modifiers ?? []).map((name, index) => [name, index]));
        const data: number[] = [];
        let previousLine = 0;
        let previousCharacter = 0;
        for (const token of response.tokens) {
          const deltaLine = token.line - previousLine;
          const deltaStart = deltaLine === 0 ? token.character - previousCharacter : token.character;
          let typeIdx = typeIndex.get(token.type);
          if (typeIdx === undefined) typeIdx = Math.max(0, typeIndex.get('keyword') ?? 0);
          let modifierMask = 0;
          for (const modifier of token.modifiers ?? []) {
            const modifierIdx = modifierIndex.get(modifier);
            if (modifierIdx !== undefined) modifierMask |= (1 << modifierIdx);
          }
          data.push(deltaLine, deltaStart, token.length, typeIdx, modifierMask);
          previousLine = token.line;
          previousCharacter = token.character;
        }
        return { data: Uint32Array.from(data) };
      } catch { return { data: new Uint32Array(0) }; }
    },
    releaseDocumentSemanticTokens: () => undefined,
  });

  // Statement window navigation — Monaco keybindings (Ctrl/Cmd + Up/Down), mirroring the desktop
  async function navigateStatement(direction: 'before' | 'after'): Promise<void> {
    const position = editor.getPosition();
    const currentModel = editor.getModel();
    if (!position || !currentModel) return;
    const offset = currentModel.getOffsetAt(position);
    try {
      const target = await client.statementNav(offset, direction) as number | null;
      if (target === null || target === undefined) return;
      const targetPosition = currentModel.getPositionAt(target);
      editor.setPosition(targetPosition);
      editor.revealPositionInCenter(targetPosition);
    } catch { /* editor remains usable */ }
  }
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow, () => { void navigateStatement('before'); });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow, () => { void navigateStatement('after'); });
  editor.onDidDispose(() => {
    changeDisposable.dispose();
    completionDisposable.dispose();
    snippetDisposable.dispose();
    hoverDisposable.dispose();
    definitionDisposable.dispose();
    referenceDisposable.dispose();
    renameDisposable.dispose();
    signatureHelpDisposable.dispose();
    documentSymbolDisposable.dispose();
    inlayHintsDisposable.dispose();
    formatDisposable.dispose();
    codeActionDisposable.dispose();
    semanticTokenDisposable.dispose();
    client.dispose();
  });
}
