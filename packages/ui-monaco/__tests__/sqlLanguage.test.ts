import type * as Monaco from 'monaco-editor';
import { disposeSqlLanguageFeatures, registerSqlLanguageFeatures } from '../src/sqlLanguage';
import type { SqlLanguageApi } from '../src/sqlLanguage';

interface DisposableLike { dispose(): void; }

class FakeModel {
  public readonly uri = { toString: () => this.uriValue };
  private readonly listeners: Array<() => void> = [];

  public constructor(private readonly uriValue: string, private readonly value: string) {}
  public getValue(): string { return this.value; }
  public getVersionId(): number { return 1; }
  public onDidChangeContent(listener: () => void): DisposableLike { this.listeners.push(listener); return { dispose: () => undefined }; }
  public getListenerCount(): number { return this.listeners.length; }
}

class FakeEditor {
  private readonly disposeListeners: Array<() => void> = [];

  public constructor(private readonly model: FakeModel) {}
  public getModel(): FakeModel { return this.model; }
  public addCommand(): string { return 'command'; }
  public onDidDispose(listener: () => void): DisposableLike { this.disposeListeners.push(listener); return { dispose: () => undefined }; }
}

class FakeSocket {
  public readonly readyState = 1;
  public addEventListener(): void { /* The lifecycle test does not need a live handshake. */ }
  public send(): void { /* Requests are intentionally left pending until disposal. */ }
  public close(): void { /* no-op */ }
}

function createApi(): SqlLanguageApi {
  return {
    openWebSocket: () => new FakeSocket() as unknown as WebSocket,
    snippets: async () => ({ snippets: [] }),
    completion: async () => ({ items: [] }),
    diagnostics: async () => ({ diagnostics: [] }),
    formatSql: async input => ({ sql: input.sql }),
  };
}

function createMonaco(providerDisposals: DisposableLike[]): typeof Monaco {
  const register = (): DisposableLike => {
    const disposable = { dispose: () => { providerDisposals.push(disposable); } };
    return disposable;
  };
  const fake = {
    languages: {
      registerCompletionItemProvider: register,
      registerHoverProvider: register,
      registerDefinitionProvider: register,
      registerReferenceProvider: register,
      registerRenameProvider: register,
      registerSignatureHelpProvider: register,
      registerDocumentSymbolProvider: register,
      registerInlayHintsProvider: register,
      registerDocumentFormattingEditProvider: register,
      registerCodeActionProvider: register,
      registerDocumentSemanticTokensProvider: register,
      CompletionItemKind: { Function: 1, Field: 2, Struct: 3, Interface: 4, Keyword: 5, Snippet: 6 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      InlayHintKind: { Parameter: 1, Type: 2 },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    },
    editor: { setModelMarkers: () => undefined },
    Range: class {
      public constructor(public readonly startLineNumber: number, public readonly startColumn: number, public readonly endLineNumber: number, public readonly endColumn: number) {}
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    Selection: class {
      public constructor(public readonly selectionStartLineNumber: number, public readonly selectionStartColumn: number, public readonly positionLineNumber: number, public readonly positionColumn: number) {}
    },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { UpArrow: 2, DownArrow: 3 },
  };
  return fake as unknown as typeof Monaco;
}

describe('shared Monaco SQL language lifecycle', () => {
  it('releases one document without tearing down providers used by another tab', () => {
    const providerDisposals: DisposableLike[] = [];
    const monaco = createMonaco(providerDisposals);
    const api = createApi();
    const firstModel = new FakeModel('inmemory://first.sql', 'SELECT 1');
    const secondModel = new FakeModel('inmemory://second.sql', 'SELECT 2');
    const first = registerSqlLanguageFeatures(new FakeEditor(firstModel) as unknown as Monaco.editor.IStandaloneCodeEditor, monaco, api, () => ({}));
    const second = registerSqlLanguageFeatures(new FakeEditor(secondModel) as unknown as Monaco.editor.IStandaloneCodeEditor, monaco, api, () => ({}));
    const registeredProviderCount = 12;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(firstModel.getListenerCount()).toBe(2);
    expect(secondModel.getListenerCount()).toBe(2);

    first?.dispose();
    expect(providerDisposals).toHaveLength(0);

    second?.dispose();
    expect(providerDisposals).toHaveLength(0);
    disposeSqlLanguageFeatures(monaco);
    expect(providerDisposals).toHaveLength(registeredProviderCount);
  });
});
