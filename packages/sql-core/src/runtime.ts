import type { Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { netezzaSqlAuthoring } from '../../../src/dialects/netezza/sql/authoring';
import { LspCompletionEngine } from '../../../src/server/completionEngine';
import { toDiagnostic } from '../../../src/server/diagnosticsUtils';
import { MetadataBridge } from '../../../src/server/metadataBridge';
import { LspSchemaProvider } from '../../../src/server/lspSchemaProvider';
import { DocumentParseSession } from '../../../src/sqlParser/documentParseSession';
import { SqlValidator } from '../../../src/sqlParser/validator';
import type { MetadataRequestParams, MetadataResponse } from '../../../src/lsp/protocol';
import type { DatabaseKind } from '../../../src/contracts/database';

export type WebLspMetadataKind = 'context' | 'databases' | 'schemas' | 'tables' | 'views' | 'procedures' | 'columns' | 'cachedTableInfo' | 'tableInfo' | 'warmDatabaseColumns' | 'qualifyTable' | 'netezzaDefaultSchema';
export interface WebLspMetadataRequestParams {
  documentUri: string;
  kind: WebLspMetadataKind;
  database?: string;
  schema?: string;
  table?: string;
  databases?: string[];
}

interface CorePosition { line: number; character: number; }
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

export class NetezzaWebLspCore {
  private readonly contexts = new Map<string, WebLspContext>();
  private readonly parseSession = new DocumentParseSession();
  private readonly metadataBridge: MetadataBridge;
  private readonly completionEngine: LspCompletionEngine;

  public constructor(options: WebLspCoreOptions) {
    this.metadataBridge = new MetadataBridge(options.requestMetadata as (params: MetadataRequestParams) => Promise<MetadataResponse>, options.logger);
    this.completionEngine = new LspCompletionEngine(this.metadataBridge, this.parseSession);
  }

  public setContext(documentUri: string, context: WebLspContext): void {
    const previous = this.contexts.get(documentUri);
    if (previous && previous.connectionName === context.connectionName
      && previous.effectiveDatabase === context.effectiveDatabase
      && previous.effectiveSchema === context.effectiveSchema
      && previous.databaseKind === context.databaseKind
      && previous.netezzaSchemasEnabled === context.netezzaSchemasEnabled) return;
    this.contexts.set(documentUri, context);
    this.metadataBridge.clearDocument(documentUri);
  }

  public clearConnection(connectionName: string): void {
    this.metadataBridge.clearConnection(connectionName);
  }

  public async completion(documentUri: string, version: number, sql: string, position: Position): Promise<CoreCompletionItem[]> {
    const document = this.document(documentUri, version, sql);
    return this.completionEngine.provideCompletionItems(document, position);
  }

  public async diagnostics(documentUri: string, version: number, sql: string): Promise<CoreDiagnostic[]> {
    const document = this.document(documentUri, version, sql);
    const context = await this.metadataBridge.warmValidationCache(documentUri, sql);
    const schemaProvider = new LspSchemaProvider(this.metadataBridge, documentUri, context.effectiveDatabase);
    const validator = new SqlValidator(schemaProvider, netezzaSqlAuthoring.validation);
    const parseResult = await this.parseSession.getParseResultAsync({
      documentUri,
      documentVersion: version,
      sql,
      databaseKind: context.databaseKind,
      validationProfile: netezzaSqlAuthoring.validation,
    });
    const result = validator.validateFromParseResult(sql, parseResult);
    return [...result.errors, ...result.warnings].map(issue => toDiagnostic(issue));
  }

  public close(documentUri: string): void {
    this.contexts.delete(documentUri);
    this.metadataBridge.clearDocument(documentUri);
    this.parseSession.invalidateDocument(documentUri);
  }

  private document(uri: string, version: number, sql: string): TextDocument {
    this.parseSession.bindDocumentVersion(uri, version, sql);
    return TextDocument.create(uri, 'sql', version, sql);
  }
}
