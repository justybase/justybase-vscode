/**
 * Mock for VS Code module - used in unit tests
 * This provides minimal mock implementations needed for testing
 */

export const window = {
  showInformationMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showQuickPick: jest.fn(),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    show: jest.fn(),
  })),
  createWebviewPanel: jest.fn(),
  createStatusBarItem: jest.fn(() => ({
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
    command: undefined,
    text: "",
    tooltip: undefined,
    color: undefined,
    backgroundColor: undefined,
  })),
  setStatusBarMessage: jest.fn(() => ({ dispose: jest.fn() })),
  activeTextEditor: undefined,
  createTextEditorDecorationType: jest.fn(() => ({
    dispose: jest.fn(),
  })),
  registerFileDecorationProvider: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeTextEditorSelection: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeVisibleTextEditors: jest.fn(() => ({ dispose: jest.fn() })),
  registerCustomEditorProvider: jest.fn(() => ({ dispose: jest.fn() })),
};

export const workspace = {
  getConfiguration: jest.fn(() => ({
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  })),
  textDocuments: [],
  onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  onDidOpenTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
};

export const Uri = {
  file: (path: string) => ({
    scheme: "file",
    path,
    fsPath: path,
    toString: () => `file://${path}`,
  }),
  parse: (value: string) => {
    const match = /^([a-z0-9+.-]+):(?:\/\/)?(.*)$/i.exec(value);
    if (!match) {
      return {
        scheme: "file",
        path: value,
        fsPath: value,
        toString: () => value,
      };
    }

    const [, scheme, remainder] = match;
    const path = remainder.startsWith("/") ? remainder : `/${remainder}`;
    return {
      scheme: scheme.toLowerCase(),
      path,
      fsPath: path,
      toString: () => value,
    };
  },
  joinPath: (base: any, ...paths: string[]) => ({
    fsPath: `${base.fsPath}/${paths.join("/")}`,
    toString: () => `${base.toString()}/${paths.join("/")}`,
  }),
};

export const commands = {
  registerCommand: jest.fn(),
  executeCommand: jest.fn(),
};

export const ExtensionContext = {};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export const languages = {
  registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerInlayHintsProvider: jest.fn(() => ({ dispose: jest.fn() })),
  createDiagnosticCollection: jest.fn(() => ({
    set: jest.fn(),
    delete: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  })),
  registerDocumentSymbolProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerSignatureHelpProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerFoldingRangeProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerCompletionItemProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerCodeLensProvider: jest.fn(() => ({ dispose: jest.fn() })),
  registerDocumentSemanticTokensProvider: jest.fn(() => ({ dispose: jest.fn() })),
};

export enum ViewColumn {
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class ThemeColor {
  constructor(public id: string) { }
}

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor,
  ) { }
}

export class TreeItem {
  label: string | { label: string; highlights?: [number, number][] };
  collapsibleState?: TreeItemCollapsibleState;
  iconPath?: string | { light: string; dark: string } | ThemeIcon;
  contextValue?: string;
  resourceUri?: unknown;
  command?: { command: string; title: string; arguments?: any[] };

  constructor(
    label: string | { label: string; highlights?: [number, number][] },
    collapsibleState?: TreeItemCollapsibleState,
  ) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

// Event Emitter mock
export class EventEmitter<T> {
  private _listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void) => {
    this._listeners.push(listener);
    return {
      dispose: () => {
        const index = this._listeners.indexOf(listener);
        if (index !== -1) {
          this._listeners.splice(index, 1);
        }
      },
    };
  };

  fire(data: T): void {
    this._listeners.forEach((listener) => listener(data));
  }

  dispose(): void {
    this._listeners = [];
  }
}

// Webview related mocks
export class Webview {
  html = "";
  options = {};
  onDidReceiveMessage = jest.fn(() => ({ dispose: jest.fn() }));
  postMessage = jest.fn().mockResolvedValue(true);
  asWebviewUri = jest.fn((uri: { fsPath: string }) => ({
    toString: () => `webview-uri://${uri.fsPath}`,
  }));
  cspSource = "mock-csp-source";
}

export class WebviewPanel {
  webview = new Webview();
  viewType = "";
  title = "";
  visible = true;
  active = true;
  onDidDispose = jest.fn(() => ({ dispose: jest.fn() }));
  onDidChangeViewState = jest.fn(() => ({ dispose: jest.fn() }));
  reveal = jest.fn();
  dispose = jest.fn();
}

// Language Model related mocks
export class MarkdownString {
  value: string;
  constructor(value?: string) {
    this.value = value || "";
  }
  appendText(value: string): this {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class Hover {
  constructor(
    public contents: unknown,
    public range?: Range,
  ) { }
}

export class LanguageModelToolResult {
  constructor(public content: unknown[]) { }
}

export class DataTransferItem {
  constructor(public value: any) { }
}

export class LanguageModelTextPart {
  constructor(public value: string) { }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class CancellationTokenSource {
  private _token: CancellationToken;
  constructor() {
    this._token = { isCancellationRequested: false };
  }
  get token(): CancellationToken {
    return this._token;
  }
  cancel(): void {
    this._token = { isCancellationRequested: true };
  }
  dispose(): void { }
}

export interface CancellationToken {
  isCancellationRequested: boolean;
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
}

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) { }
  translate(lineOffset?: number, characterOffset?: number): Position {
    return new Position(
      this.line + (lineOffset || 0),
      this.character + (characterOffset || 0),
    );
  }
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) { }
}

export class DocumentSymbol {
  children?: DocumentSymbol[];

  constructor(
    public name: string,
    public detail: string,
    public kind: SymbolKind,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

export class Selection extends Range {
  public anchor: Position;
  public active: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2
}

export class InlayHint {
  kind?: InlayHintKind;
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;

  constructor(
    public position: Position,
    public label: string,
    kind?: InlayHintKind
  ) {
    this.kind = kind;
  }
}

export class CodeLens {
  range: Range;
  command?: { title: string; command: string; arguments?: any[] };
  constructor(range: Range, command?: { title: string; command: string; arguments?: any[] }) {
    this.range = range;
    this.command = command;
  }
  get isResolved(): boolean {
    return this.command !== undefined;
  }
}

export class Diagnostic {
  source?: string;
  code?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity,
  ) { }
}

export class CompletionItem {
  label: string;
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  range?: Range;
  textEdit?: { range: Range; newText: string };

  constructor(label: string, kind?: CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList {
  items: CompletionItem[];
  isIncomplete: boolean;

  constructor(items: CompletionItem[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2,
}

export interface CompletionContext {
  triggerKind: CompletionTriggerKind;
  triggerCharacter?: string;
}

export enum DecorationRangeBehavior {
  OpenOpen = 1,
  ClosedClosed = 2,
  OpenClosed = 3,
  ClosedOpen = 4,
}

// Chat/AI related mocks
export const lm = {
  selectChatModels: jest.fn().mockResolvedValue([]),
};

export class LanguageModelChatMessage {
  static User(content: string) {
    return { role: "user", content };
  }
  static Assistant(content: string) {
    return { role: "assistant", content };
  }
  role: string;
  content: string;
  constructor(role: string, content: string) {
    this.role = role;
    this.content = content;
  }
}

export class LanguageModelChatRequestOptions {
  model!: string;
  messages!: LanguageModelChatMessage[];
  token?: any;
}

export class SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
  constructor(tokenTypes: string[], tokenModifiers?: string[]) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers ?? [];
  }
}

export class SemanticTokens {
  data: Uint32Array;
  resultId?: string;
  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

export class SemanticTokensBuilder {
  private data: number[] = [];
  constructor(_legend: SemanticTokensLegend) {
  }
  push(line: number, char: number, length: number, tokenType: number, tokenModifiers?: number): void {
    this.data.push(line, char, length, tokenType, tokenModifiers ?? 0);
  }
  build(resultId?: string): SemanticTokens {
    return new SemanticTokens(new Uint32Array(this.data), resultId);
  }
}
