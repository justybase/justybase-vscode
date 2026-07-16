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
export interface CoreDiagnostic { range: { start: CorePosition; end: CorePosition }; severity?: number; code?: string | number; source?: string; message: string; }

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
  close(documentUri: string): void;
}
