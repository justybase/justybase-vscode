import type { Position } from 'vscode-languageserver/node';
import type { DatabaseKind } from '@justybase/contracts';

export type WebLspMetadataKind = 'context' | 'databases' | 'schemas' | 'tables' | 'views' | 'procedures' | 'columns' | 'cachedTableInfo' | 'tableInfo' | 'warmDatabaseColumns' | 'qualifyTable' | 'netezzaDefaultSchema';
export interface WebLspMetadataRequestParams {
  documentUri: string;
  kind: WebLspMetadataKind;
  database?: string;
  schema?: string;
  table?: string;
  databases?: string[];
}
export interface CorePosition { line: number; character: number; }
export interface CoreCompletionItem { label: string; kind?: number; detail?: string; insertText?: string; }
export interface CoreDiagnostic { range: { start: CorePosition; end: CorePosition }; severity?: number; code?: string | number; source?: string; message: string; data?: { suggestedFix?: string }; }
export interface CoreRange { start: CorePosition; end: CorePosition; }
export interface CoreMarkupContent { kind: 'markdown' | 'plaintext'; value: string; }
export interface CoreHover { range?: CoreRange; contents: CoreMarkupContent; }
export interface CoreLocation { uri: string; range: CoreRange; }
export interface CoreTextEdit { range: CoreRange; newText: string; }
export interface CoreWorkspaceEdit { changes: Record<string, CoreTextEdit[]>; }
export interface CoreRenamePrepare { range: CoreRange; placeholder: string; }
export interface CoreInlayHint { position: CorePosition; label: string; kind?: 'type' | 'parameter'; }
export interface CoreSignatureParameter { label: string; documentation?: string; }
export interface CoreSignatureInformation { label: string; documentation?: string; parameters: CoreSignatureParameter[]; }
export interface CoreSignatureHelp { signatures: CoreSignatureInformation[]; activeSignature: number; activeParameter: number; }
export interface CoreDocumentSymbol { name: string; detail: string; kind: number; range: CoreRange; selectionRange: CoreRange; children?: CoreDocumentSymbol[]; }
export type CoreKeywordCase = 'upper' | 'lower' | 'preserve';
export interface CoreFormatOptions { tabWidth?: number; keywordCase?: CoreKeywordCase; linesBetweenQueries?: number; }
export interface CoreStatementBoundary { index: number; startOffset: number; endOffset: number; sql: string; }
export interface CoreStatementAtPosition { sql: string; start: number; end: number; }
export declare function splitSqlStatements(sql: string): CoreStatementBoundary[];
export declare function getSqlStatementAtPosition(sql: string, offset: number): CoreStatementAtPosition | null;
export type CoreSemanticTokenType = 'enumMember' | 'function' | 'keyword' | 'macro' | 'modifier' | 'variable' | 'type' | 'column' | 'table' | 'alias' | 'schema' | 'database' | 'localVariable';
export type CoreSemanticTokenModifier = 'readonly' | 'defaultLibrary' | 'italic';
export interface CoreSemanticToken { line: number; character: number; length: number; type: CoreSemanticTokenType; modifiers: CoreSemanticTokenModifier[]; }
export interface CoreSemanticTokenResult { types: CoreSemanticTokenType[]; modifiers: CoreSemanticTokenModifier[]; tokens: CoreSemanticToken[]; }

export interface WebLspContext {
  connectionName?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  databaseKind?: DatabaseKind;
  netezzaSchemasEnabled?: boolean;
}

export interface WebLspCoreOptions {
  requestMetadata(params: WebLspMetadataRequestParams): Promise<unknown>;
  logger?: { error(message: string): void };
}

export declare class NetezzaWebLspCore {
  constructor(options: WebLspCoreOptions);
  setContext(documentUri: string, context: WebLspContext): void;
  clearConnection(connectionName: string): void;
  completion(documentUri: string, version: number, sql: string, position: Position): Promise<CoreCompletionItem[]>;
  diagnostics(documentUri: string, version: number, sql: string): Promise<CoreDiagnostic[]>;
  hover(documentUri: string, version: number, sql: string, position: Position): Promise<CoreHover | null>;
  definition(documentUri: string, version: number, sql: string, position: Position): Promise<CoreLocation | null>;
  references(documentUri: string, version: number, sql: string, position: Position, includeDeclaration: boolean): Promise<CoreLocation[] | null>;
  prepareRename(documentUri: string, version: number, sql: string, position: Position): Promise<CoreRenamePrepare | null>;
  rename(documentUri: string, version: number, sql: string, position: Position, newName: string): Promise<CoreWorkspaceEdit | null>;
  inlayHints(documentUri: string, version: number, sql: string, range?: CoreRange): Promise<CoreInlayHint[]>;
  signatureHelp(documentUri: string, version: number, sql: string, position: Position): Promise<CoreSignatureHelp | null>;
  documentSymbols(documentUri: string, version: number, sql: string): Promise<CoreDocumentSymbol[]>;
  format(sql: string, databaseKind?: DatabaseKind, options?: CoreFormatOptions): Promise<string>;
  semanticTokens(documentUri: string, version: number, sql: string): Promise<CoreSemanticTokenResult>;
  window(documentUri: string, version: number, sql: string, offset: number, units: 'sentence', direction: 'before' | 'after'): Promise<number | null>;
  close(documentUri: string): void;
}
