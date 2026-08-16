import {
  InlayHintKind,
  type InlayHintLabelPart,
  type Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { netezzaSqlAuthoring } from '../../../src/dialects/netezza/sql/authoring';
import { LspCompletionEngine } from '../../../src/server/completionEngine';
import { toDiagnostic } from '../../../src/server/diagnosticsUtils';
import { MetadataBridge } from '../../../src/server/metadataBridge';
import { LspSchemaProvider } from '../../../src/server/lspSchemaProvider';
import { DocumentParseSession } from '../../../src/sqlParser/documentParseSession';
import { SqlValidator } from '../../../src/sqlParser/validator';
import { QualityEngineCore } from '../../../src/sqlParser/qualityEngineCore';
import type { MetadataRequestParams, MetadataResponse } from '../../../src/lsp/protocol';
import type { DatabaseKind } from '../../../src/contracts/database';
import { LspInlayHintEngine } from '../../../src/server/inlayHintEngine';
import { provideHover, type HoverDependencies } from '../../../src/server/hoverEngine';
import {
  collectSqlSymbolUsages,
  collectSqlSymbolUsagesFromCst,
  formatSqlRenameReplacement,
  resolveSqlRenameSymbolWithSession,
} from '../../../src/sqlParser';
import { SqlParser } from '../../../src/sql/sqlParser';
import { getDatabaseSqlAuthoring } from '../../../src/core/sqlAuthoringRegistry';
import { findFunctionCall, getTextBeforeCursor } from '../../../src/server/signatureHelpUtils';
import { buildFunctionSignatureDocumentation } from '../../../src/server/functionCompletionUtils';
import { formatSql, type SqlFormatterOptions } from '../../../src/services/sqlFormatter';
import { isLargeScriptDocument } from '../../../src/sqlParser/validationConfig';
import { toDocumentParseRequestFromParts } from '../../../src/server/documentParseRequest';
import type { AliasInfo, LocalDefinition } from '../../../src/providers/types';
import { parseSemanticScopeWithParser } from '../../../src/providers/parsers/parserSqlContext';
import { collectIdentifierOccurrencesFromScope, type IdentifierSemanticRole } from '../../../src/providers/parsers/identifierRoleCollector';
import { resolveSqlParsingRuntime } from '../../../src/sqlParser/parsingRuntime';
import { buildSqlSourceScanIndex } from '../../../src/sql/sqlSourceScan';
import { KEYWORD_TOKEN_NAMES, MACRO_TOKEN_NAMES, MODIFIER_TOKEN_NAMES } from '../../../src/sql/semanticTokenNames';

export type CoreSemanticTokenType = 'enumMember' | 'function' | 'keyword' | 'macro' | 'modifier' | 'variable' | 'type' | 'column' | 'table' | 'alias' | 'schema' | 'database' | 'localVariable';
export type CoreSemanticTokenModifier = 'readonly' | 'defaultLibrary' | 'italic';
export interface CoreSemanticToken { line: number; character: number; length: number; type: CoreSemanticTokenType; modifiers: CoreSemanticTokenModifier[]; }
export interface CoreSemanticTokenResult { types: CoreSemanticTokenType[]; modifiers: CoreSemanticTokenModifier[]; tokens: CoreSemanticToken[]; }

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

export interface CoreStatementBoundary {
  index: number;
  startOffset: number;
  endOffset: number;
  sql: string;
}

export interface CoreStatementAtPosition {
  sql: string;
  start: number;
  end: number;
}

/** Parser-backed script splitting shared by the web API and other clients. */
export function splitSqlStatements(sql: string): CoreStatementBoundary[] {
  return SqlParser.splitStatementsWithPositions(sql).map((statement, index) => ({
    index,
    startOffset: statement.startOffset,
    endOffset: statement.endOffset,
    sql: statement.sql,
  }));
}

/** Returns the statement containing the cursor, respecting comments, quotes and NZPLSQL bodies. */
export function getSqlStatementAtPosition(sql: string, offset: number): CoreStatementAtPosition | null {
  const statement = SqlParser.getStatementAtPosition(sql, Math.max(0, Math.min(offset, sql.length)));
  if (!statement) return null;
  const raw = sql.slice(statement.start, statement.end);
  const leadingWhitespace = raw.search(/\S/);
  const content = raw.trim();
  const start = leadingWhitespace < 0 ? statement.start : statement.start + leadingWhitespace;
  return { sql: content, start, end: start + content.length };
}

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

interface OutlineSymbol {
  kind: string;
  name: string;
  occurrences: Array<{ kind: string; role: 'definition' | 'reference'; startOffset: number; endOffset: number; text: string; }>;
}

const LSP_SYMBOL_STRUCT = 23;
const LSP_SYMBOL_VARIABLE = 13;
const LSP_SYMBOL_CLASS = 5;
const LSP_SYMBOL_FIELD = 8;
const LSP_SYMBOL_OBJECT = 19;

export class NetezzaWebLspCore {
  private readonly contexts = new Map<string, WebLspContext>();
  private readonly parseSession = new DocumentParseSession();
  private readonly metadataBridge: MetadataBridge;
  private readonly completionEngine: LspCompletionEngine;
  private readonly inlayHintEngine: LspInlayHintEngine;

  public constructor(options: WebLspCoreOptions) {
    this.metadataBridge = new MetadataBridge(options.requestMetadata as (params: MetadataRequestParams) => Promise<MetadataResponse>, options.logger);
    this.completionEngine = new LspCompletionEngine(this.metadataBridge, this.parseSession);
    this.inlayHintEngine = new LspInlayHintEngine(this.metadataBridge, this.parseSession);
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
    const parserDiagnostics: CoreDiagnostic[] = [...result.errors, ...result.warnings].map(issue => {
      const diagnostic = toDiagnostic(issue) as unknown as CoreDiagnostic & { data?: { suggestedFix?: string } };
      const suggestedFix = (diagnostic.data as { suggestedFix?: string } | undefined)?.suggestedFix;
      return {
        range: diagnostic.range,
        severity: diagnostic.severity,
        code: diagnostic.code,
        source: diagnostic.source,
        message: diagnostic.message,
        data: suggestedFix ? { suggestedFix } : undefined,
      };
    });

    // NZ/NZP quality rules (vscode-free core). LSP already owns SQL/PAR
    // diagnostics, so we only run the quality rules — mirroring the desktop
    // linter when the language client is active.
    const qualityCore = new QualityEngineCore(validator, netezzaSqlAuthoring.qualityRules);
    const qualityResult = qualityCore.analyzeQualityRulesOnly(sql);
    const qualityDiagnostics: CoreDiagnostic[] = qualityResult.issues.map(issue => ({
      range: this.offsetRangeForOffsets(sql, issue.startOffset, issue.endOffset),
      // LintSeverity is 0=Error..3=Hint (vscode numbering); the LSP wire format
      // (and parser diagnostics below) is 1=Error..4=Hint — convert so both
      // families agree and Monaco's severity===1 -> Error mapping is correct.
      severity: (issue.severity ?? 1) + 1,
      code: issue.ruleId,
      source: 'Netezza Quality',
      message: issue.message,
      data: issue.suggestedFix ? { suggestedFix: issue.suggestedFix } : undefined,
    }));

    return [...qualityDiagnostics, ...parserDiagnostics].sort(compareDiagnostics);
  }

  private offsetRangeForOffsets(sql: string, startOffset: number, endOffset: number): CoreRange {
    const safeStart = Math.max(0, Math.min(startOffset, sql.length));
    const safeEnd = Math.max(safeStart + 1, Math.min(endOffset, sql.length));
    const startLine = sql.slice(0, safeStart).split('\n').length - 1;
    const endLine = sql.slice(0, safeEnd).split('\n').length - 1;
    const startCharacter = safeStart - sql.lastIndexOf('\n', safeStart - 1) - 1;
    const endCharacter = safeEnd - sql.lastIndexOf('\n', safeEnd - 1) - 1;
    return {
      start: { line: startLine, character: Math.max(0, startCharacter) },
      end: { line: endLine, character: Math.max(0, endCharacter) },
    };
  }

  public async hover(documentUri: string, version: number, sql: string, position: Position): Promise<CoreHover | null> {
    const document = this.document(documentUri, version, sql);
    const dependencies: HoverDependencies = {
      resolveSqlRenameSymbol: (statementSql, offset, databaseKind) =>
        resolveSqlRenameSymbolWithSession(this.parseSession, this.parseRequest(documentUri, version, statementSql, databaseKind), offset),
      getStatementAtPosition: (statementSql, offset) =>
        SqlParser.getStatementAtPosition(statementSql, offset, { documentId: documentUri, version }),
      getAliasBindings: (statementSql, statementOffset, databaseKind) =>
        this.sessionAliasBindings(documentUri, version, statementSql, statementOffset, databaseKind),
      getCompletionLocalDefinitions: (fullSql, statementSql, statementOffset, databaseKind, cursorOffset) =>
        this.sessionCompletionDefinitions(documentUri, version, fullSql, statementSql, statementOffset, databaseKind, cursorOffset),
      findLocalDefinition,
      formatObjectPath,
      isCancellationRequested: () => false,
    };
    return provideHover(document, { position }, dependencies, this.metadataBridge) as Promise<CoreHover | null>;
  }

  public async definition(documentUri: string, version: number, sql: string, position: Position): Promise<CoreLocation | null> {
    const document = this.document(documentUri, version, sql);
    const context = await this.metadataBridge.getContext(documentUri);
    const symbol = resolveSqlRenameSymbolWithSession(this.parseSession, this.parseRequest(documentUri, version, sql, context.databaseKind), document.offsetAt(position));
    if (!symbol) return null;
    const occurrence = symbol.occurrences.find(item => item.role === 'definition') ?? symbol.target;
    return { uri: documentUri, range: this.offsetRange(document, occurrence.startOffset, occurrence.endOffset) };
  }

  public async references(documentUri: string, version: number, sql: string, position: Position, includeDeclaration: boolean): Promise<CoreLocation[] | null> {
    const document = this.document(documentUri, version, sql);
    const context = await this.metadataBridge.getContext(documentUri);
    const symbol = resolveSqlRenameSymbolWithSession(this.parseSession, this.parseRequest(documentUri, version, sql, context.databaseKind), document.offsetAt(position));
    if (!symbol) return null;
    const occurrences = includeDeclaration
      ? symbol.occurrences
      : symbol.occurrences.filter(occurrence => occurrence.role !== 'definition');
    return occurrences.map(occurrence => ({ uri: documentUri, range: this.offsetRange(document, occurrence.startOffset, occurrence.endOffset) }));
  }

  public async prepareRename(documentUri: string, version: number, sql: string, position: Position): Promise<CoreRenamePrepare | null> {
    const document = this.document(documentUri, version, sql);
    const context = await this.metadataBridge.getContext(documentUri);
    const symbol = resolveSqlRenameSymbolWithSession(this.parseSession, this.parseRequest(documentUri, version, sql, context.databaseKind), document.offsetAt(position));
    if (!symbol) return null;
    return { range: this.offsetRange(document, symbol.target.startOffset, symbol.target.endOffset), placeholder: symbol.name };
  }

  public async rename(documentUri: string, version: number, sql: string, position: Position, newName: string): Promise<CoreWorkspaceEdit | null> {
    const document = this.document(documentUri, version, sql);
    const trimmedName = newName.trim();
    if (!trimmedName) return null;
    const context = await this.metadataBridge.getContext(documentUri);
    const symbol = resolveSqlRenameSymbolWithSession(this.parseSession, this.parseRequest(documentUri, version, sql, context.databaseKind), document.offsetAt(position));
    if (!symbol) return null;
    return {
      changes: {
        [documentUri]: symbol.occurrences.map(occurrence => ({
          range: this.offsetRange(document, occurrence.startOffset, occurrence.endOffset),
          newText: formatSqlRenameReplacement(occurrence.text, trimmedName),
        })),
      },
    };
  }

  public async inlayHints(documentUri: string, version: number, sql: string, range?: CoreRange): Promise<CoreInlayHint[]> {
    const document = this.document(documentUri, version, sql);
    const lspRange = range
      ? { start: range.start, end: range.end }
      : { start: { line: 0, character: 0 }, end: { line: document.lineCount, character: Number.MAX_SAFE_INTEGER } };
    const hints = await this.inlayHintEngine.provideInlayHints(document, lspRange, () => false);
    return hints.map(hint => ({
      position: hint.position,
      label: inlayHintLabel(hint.label),
      kind: hint.kind === InlayHintKind.Type ? 'type' : hint.kind === InlayHintKind.Parameter ? 'parameter' : undefined,
    }));
  }

  public async signatureHelp(documentUri: string, version: number, sql: string, position: Position): Promise<CoreSignatureHelp | null> {
    const document = this.document(documentUri, version, sql);
    const context = await this.metadataBridge.getContext(documentUri);
    const offset = document.offsetAt(position);
    const functionCall = findFunctionCall(getTextBeforeCursor(document, offset));
    if (!functionCall) return null;
    const signatures = getDatabaseSqlAuthoring(context.databaseKind).signatures.get(functionCall.functionName.toUpperCase());
    if (!signatures || signatures.length === 0) return null;
    return {
      signatures: signatures.map(signature => ({
        label: `${signature.name}(${signature.parameters.join(', ')})`,
        documentation: buildFunctionSignatureDocumentation([signature])?.value,
        parameters: signature.parameters.map(parameter => ({ label: String(parameter) })),
      })),
      activeSignature: 0,
      activeParameter: functionCall.argumentPosition,
    };
  }

  public async documentSymbols(documentUri: string, version: number, sql: string): Promise<CoreDocumentSymbol[]> {
    const document = this.document(documentUri, version, sql);
    if (isLargeScriptDocument(document.lineCount, sql.length)) return [];
    const context = await this.metadataBridge.getContext(documentUri);
    const symbols = this.collectOutlineSymbols(documentUri, version, sql, context.databaseKind);
    return symbols.map(symbol => this.createCoreDocumentSymbol(document, symbol));
  }

  public async format(sql: string, databaseKind?: DatabaseKind, options?: CoreFormatOptions): Promise<string> {
    return formatSql(sql, { ...options, databaseKind } satisfies SqlFormatterOptions);
  }

  public async semanticTokens(documentUri: string, version: number, sql: string): Promise<CoreSemanticTokenResult> {
    const context = await this.metadataBridge.getContext(documentUri);
    const databaseKind = context.databaseKind ?? 'netezza';
    const legend: CoreSemanticTokenResult = {
      types: ['enumMember', 'function', 'keyword', 'macro', 'modifier', 'variable', 'type', 'column', 'table', 'alias', 'schema', 'database', 'localVariable'],
      modifiers: ['readonly', 'defaultLibrary', 'italic'],
      tokens: [],
    };
    const authoring = tryGetSemanticAuthoring(databaseKind);
    const tokens = computeSemanticTokens(sql, databaseKind, authoring);
    return { ...legend, tokens };
  }

  public async window(documentUri: string, version: number, sql: string, offset: number, units: 'sentence', direction: 'before' | 'after'): Promise<number | null> {
    const statement = SqlParser.getAdjacentStatementAtPosition(sql, Math.max(0, Math.min(offset, sql.length)), direction === 'before' ? -1 : 1, { documentId: documentUri, version });
    return statement ? statement.contentStart : null;
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

  private parseRequest(documentUri: string, version: number, sql: string, databaseKind?: DatabaseKind) {
    return toDocumentParseRequestFromParts(documentUri, version, sql, databaseKind);
  }

  private sessionAliasBindings(documentUri: string, version: number, statementSql: string, statementOffset: number, databaseKind?: DatabaseKind): Map<string, AliasInfo> {
    try {
      return this.parseSession.getSemanticScope({
        documentUri,
        documentVersion: version,
        sql: statementSql,
        databaseKind,
        cursorOffset: statementOffset,
      }).preferredAliasBindings;
    } catch {
      return new Map<string, AliasInfo>();
    }
  }

  private sessionCompletionDefinitions(documentUri: string, version: number, fullSql: string, statementSql: string, statementOffset: number, databaseKind?: DatabaseKind, cursorOffset?: number): LocalDefinition[] {
    const persistent = this.sessionPersistentDefinitions(documentUri, version, fullSql, databaseKind);
    const visible = databaseKind === 'oracle' && cursorOffset !== undefined
      ? this.sessionVisibleDocumentDefinitions(documentUri, version, fullSql, cursorOffset, databaseKind)
      : this.sessionVisibleStatementDefinitions(documentUri, version, statementSql, statementOffset, databaseKind);
    return mergeLocalDefinitions(persistent, visible);
  }

  private sessionVisibleDocumentDefinitions(documentUri: string, version: number, sql: string, cursorOffset: number, databaseKind?: DatabaseKind): LocalDefinition[] {
    try {
      return this.parseSession.getSemanticScope({
        documentUri,
        documentVersion: version,
        sql,
        databaseKind,
        cursorOffset,
      }).visibleLocalDefinitions;
    } catch {
      return [];
    }
  }

  private sessionVisibleStatementDefinitions(documentUri: string, version: number, statementSql: string, statementOffset: number, databaseKind?: DatabaseKind): LocalDefinition[] {
    try {
      return this.parseSession.getSemanticScope({
        documentUri,
        documentVersion: version,
        sql: statementSql,
        databaseKind,
        cursorOffset: statementOffset,
      }).visibleLocalDefinitions;
    } catch {
      return [];
    }
  }

  private sessionPersistentDefinitions(documentUri: string, version: number, sql: string, databaseKind?: DatabaseKind): LocalDefinition[] {
    try {
      return this.parseSession.getSemanticScope({
        documentUri,
        documentVersion: version,
        sql,
        databaseKind,
      }).localDefinitions.filter(definition => {
        const normalizedType = definition.type.toUpperCase();
        return normalizedType === 'TABLE' || normalizedType === 'TEMP TABLE';
      });
    } catch {
      return [];
    }
  }

  private collectOutlineSymbols(documentUri: string, version: number, sql: string, databaseKind?: DatabaseKind): OutlineSymbol[] {
    if (!sql.trim()) return [];
    const macroSymbols = collectMacroVariableSymbols(sql);
    const parseResult = this.parseSession.getParseResult(this.parseRequest(documentUri, version, sql, databaseKind));
    if (parseResult.lexResult.errors.length === 0 && parseResult.cst && parseResult.actionableParserErrors.length === 0) {
      return sortSymbolsByDefinitionOffset([...macroSymbols, ...collectSqlSymbolUsagesFromCst(parseResult.cst)]);
    }
    return sortSymbolsByDefinitionOffset([...macroSymbols, ...collectSqlSymbolUsages(sql)]);
  }

  private createCoreDocumentSymbol(document: TextDocument, symbol: OutlineSymbol): CoreDocumentSymbol {
    const definition = symbol.occurrences.find(occurrence => occurrence.role === 'definition');
    if (!definition) {
      const firstOccurrence = symbol.occurrences[0];
      const range = this.offsetRange(document, firstOccurrence.startOffset, firstOccurrence.endOffset);
      return { name: symbol.name, detail: symbolDescription(symbol), kind: symbolKind(symbol.kind), range, selectionRange: range };
    }
    let minOffset = definition.startOffset;
    let maxOffset = definition.endOffset;
    for (const occurrence of symbol.occurrences) {
      minOffset = Math.min(minOffset, occurrence.startOffset);
      maxOffset = Math.max(maxOffset, occurrence.endOffset);
    }
    const references = symbol.occurrences.filter(occurrence => occurrence.role === 'reference');
    const children = references.length > 0
      ? references.map(reference => {
        const refRange = this.offsetRange(document, reference.startOffset, reference.endOffset);
        return { name: reference.text, detail: 'Reference', kind: LSP_SYMBOL_FIELD, range: refRange, selectionRange: refRange };
      })
      : undefined;
    return {
      name: symbol.name,
      detail: symbolDescription(symbol),
      kind: symbolKind(symbol.kind),
      range: this.offsetRange(document, minOffset, maxOffset),
      selectionRange: this.offsetRange(document, definition.startOffset, definition.endOffset),
      children,
    };
  }

  private offsetRange(document: TextDocument, startOffset: number, endOffset: number): CoreRange {
    const safeStart = Math.max(0, startOffset);
    const safeEnd = Math.max(safeStart + 1, endOffset);
    return { start: toCorePosition(document.positionAt(safeStart)), end: toCorePosition(document.positionAt(safeEnd)) };
  }
}

function inlayHintLabel(label: string | InlayHintLabelPart[]): string {
  if (typeof label === 'string') return label;
  return label.map(part => part.value).join('');
}

function toCorePosition(position: { line: number; character: number }): CorePosition {
  return { line: position.line, character: position.character };
}

function mergeLocalDefinitions(base: LocalDefinition[], current: LocalDefinition[]): LocalDefinition[] {
  const merged = new Map<string, LocalDefinition>();
  for (const definition of base) merged.set(definition.name.toUpperCase(), definition);
  for (const definition of current) merged.set(definition.name.toUpperCase(), definition);
  return Array.from(merged.values());
}

function findLocalDefinition(localDefinitions: LocalDefinition[], name: string): LocalDefinition | undefined {
  const normalizedName = name.toUpperCase();
  return localDefinitions.find(definition => definition.name.toUpperCase() === normalizedName);
}

export function formatObjectPath(database: string | undefined, schema: string | undefined, table: string): string {
  if (database && schema) return `${database}.${schema}.${table}`;
  if (database) return `${database}..${table}`;
  if (schema) return `${schema}.${table}`;
  return table;
}

interface MacroDeclaration { symbol: OutlineSymbol; normalizedName: string; startOffset: number; }

function collectMacroVariableSymbols(sql: string): OutlineSymbol[] {
  const declarations: MacroDeclaration[] = [];
  const declarationPattern = /^\s*%let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gim;
  for (const match of sql.matchAll(declarationPattern)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;
    const nameStart = match.index + match[0].lastIndexOf(name);
    declarations.push({
      normalizedName: name.toUpperCase(),
      startOffset: nameStart,
      symbol: {
        kind: 'macro_variable',
        name,
        occurrences: [{ kind: 'macro_variable', role: 'definition', startOffset: nameStart, endOffset: nameStart + name.length, text: name }],
      },
    });
  }
  if (declarations.length > 0) {
    for (const reference of scanMacroReferences(sql)) {
      const normalizedName = reference.name.toUpperCase();
      const matchingDeclarations = declarations.filter(candidate => candidate.normalizedName === normalizedName && candidate.startOffset < reference.startOffset);
      const declaration = matchingDeclarations[matchingDeclarations.length - 1];
      if (declaration) {
        declaration.symbol.occurrences.push({ kind: 'macro_variable', role: 'reference', startOffset: reference.startOffset, endOffset: reference.endOffset, text: reference.text });
      }
    }
  }
  return declarations.map(declaration => declaration.symbol);
}

function scanMacroReferences(sql: string): Array<{ name: string; startOffset: number; endOffset: number; text: string }> {
  const references: Array<{ name: string; startOffset: number; endOffset: number; text: string }> = [];
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (sql[index] === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index + 1 < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    if (sql[index] === "'") { index = skipQuotedLiteral(sql, index, "'"); continue; }
    if (sql[index] === '"') { index = skipQuotedLiteral(sql, index, '"'); continue; }
    const reference = readMacroReferenceAt(sql, index);
    if (reference) { references.push(reference); index = reference.endOffset; continue; }
    index++;
  }
  return references;
}

function readMacroReferenceAt(sql: string, offset: number): { name: string; startOffset: number; endOffset: number; text: string } | undefined {
  const ampersand = sql.slice(offset).match(/^&([A-Za-z_][A-Za-z0-9_]*)/);
  if (ampersand?.[1]) return { name: ampersand[1], startOffset: offset, endOffset: offset + ampersand[0].length, text: ampersand[0] };
  const braced = sql.slice(offset).match(/^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/);
  if (braced?.[1]) return { name: braced[1], startOffset: offset, endOffset: offset + braced[0].length, text: braced[0] };
  const dollar = sql.slice(offset).match(/^\$([A-Za-z_][A-Za-z0-9_]*)/);
  if (dollar?.[1]) return { name: dollar[1], startOffset: offset, endOffset: offset + dollar[0].length, text: dollar[0] };
  return undefined;
}

function skipQuotedLiteral(sql: string, startOffset: number, quote: "'" | '"'): number {
  let offset = startOffset + 1;
  while (offset < sql.length) {
    if (sql[offset] === quote) {
      if (sql[offset + 1] === quote) { offset += 2; continue; }
      return offset + 1;
    }
    offset++;
  }
  return offset;
}

function sortSymbolsByDefinitionOffset(symbols: OutlineSymbol[]): OutlineSymbol[] {
  return [...symbols].sort((left, right) => getSymbolStartOffset(left) - getSymbolStartOffset(right));
}

function compareDiagnostics(left: CoreDiagnostic, right: CoreDiagnostic): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  if (left.range.start.character !== right.range.start.character) {
    return left.range.start.character - right.range.start.character;
  }
  return String(left.code ?? '').localeCompare(String(right.code ?? ''));
}

function getSymbolStartOffset(symbol: OutlineSymbol): number {
  const definition = symbol.occurrences.find(occurrence => occurrence.role === 'definition');
  return definition?.startOffset ?? symbol.occurrences[0]?.startOffset ?? 0;
}

function symbolKind(kind: string): number {
  switch (kind) {
    case 'cte': return LSP_SYMBOL_STRUCT;
    case 'table_alias': return LSP_SYMBOL_VARIABLE;
    case 'table': return LSP_SYMBOL_CLASS;
    case 'macro_variable':
    case 'local_variable': return LSP_SYMBOL_VARIABLE;
    default: return LSP_SYMBOL_OBJECT;
  }
}

function symbolDescription(symbol: OutlineSymbol): string {
  const refCount = symbol.occurrences.filter(occurrence => occurrence.role === 'reference').length;
  const kindLabel = symbolKindLabel(symbol.kind);
  return `${kindLabel} (${refCount} reference${refCount !== 1 ? 's' : ''})`;
}

function symbolKindLabel(kind: string): string {
  switch (kind) {
    case 'cte': return 'CTE';
    case 'table_alias': return 'Alias';
    case 'table': return 'Table';
    case 'macro_variable': return 'Macro variable';
    case 'local_variable': return 'PL/SQL local variable';
    default: return 'Symbol';
  }
}

function tryGetSemanticAuthoring(databaseKind?: DatabaseKind): ReturnType<typeof getDatabaseSqlAuthoring> {
  try {
    return getDatabaseSqlAuthoring(databaseKind);
  } catch {
    return getDatabaseSqlAuthoring('netezza');
  }
}

type SemanticAuthoring = ReturnType<typeof getDatabaseSqlAuthoring>;

function roleToSemanticTokenType(role: IdentifierSemanticRole): CoreSemanticTokenType | undefined {
  switch (role) {
    case 'column': return 'column';
    case 'table':
    case 'cte': return 'table';
    case 'alias': return 'alias';
    case 'schema': return 'schema';
    case 'database': return 'database';
    case 'localVariable': return 'localVariable';
    default: return undefined;
  }
}

function isAuthoringType(word: string, databaseKind: DatabaseKind, authoring: SemanticAuthoring): boolean {
  const spec = authoring.validation.getTypeSpec(word);
  if (spec) return true;
  if (databaseKind === 'netezza') {
    // netezza-relaxed authoring also exposes its merged type spec via the
    // validation profile; netezza-specific types are already part of the
    // netezzaSqlAuthoring profile so the direct lookup is enough.
    return authoring.validation.getTypeSpec(word) !== undefined;
  }
  return false;
}

function semanticModifiers(role: IdentifierSemanticRole | undefined): CoreSemanticTokenModifier[] {
  const modifiers: CoreSemanticTokenModifier[] = [];
  if (role === 'alias') modifiers.push('italic');
  return modifiers;
}

function computeSemanticTokens(sql: string, databaseKind: DatabaseKind, authoring: SemanticAuthoring): CoreSemanticToken[] {
  const runtime = resolveSqlParsingRuntime({ databaseKind });
  const lexResult = runtime.SqlLexer.tokenize(sql);
  const scope = parseSemanticScopeWithParser(sql, undefined, databaseKind);
  const identifierRoles = collectIdentifierOccurrencesFromScope(scope);
  const scanIndex = buildSqlSourceScanIndex(sql);
  const tokens: CoreSemanticToken[] = [];

  for (const lexToken of lexResult.tokens) {
    const startOffset = lexToken.startOffset;
    const image = lexToken.image;
    const tokenTypeName = lexToken.tokenType.name;
    if (!image || image.length <= 0) continue;
    if (scanIndex.isInComment(startOffset)) continue;

    const roleOccurrence = identifierRoles.get(startOffset);
    const roleKind = roleOccurrence?.role;
    const type = classifySemanticTokenType(tokenTypeName, image, databaseKind, authoring, roleOccurrence);
    if (!type) continue;

    const line = Math.max(0, (lexToken.startLine ?? 1) - 1);
    const character = Math.max(0, (lexToken.startColumn ?? 1) - 1);
    tokens.push({ line, character, length: image.length, type, modifiers: semanticModifiers(roleKind) });
  }

  return tokens;
}

function classifySemanticTokenType(tokenTypeName: string, image: string, databaseKind: DatabaseKind, authoring: SemanticAuthoring, roleOccurrence: { role: IdentifierSemanticRole } | undefined): CoreSemanticTokenType | undefined {
  if (KEYWORD_TOKEN_NAMES.has(tokenTypeName)) return 'keyword';
  if (MACRO_TOKEN_NAMES.has(tokenTypeName)) return 'macro';
  if (MODIFIER_TOKEN_NAMES.has(tokenTypeName)) return 'modifier';
  if (tokenTypeName === 'Identifier') {
    const word = image.toUpperCase();
    const validation = authoring.validation;
    if (validation.builtinFunctions.has(word)) return 'function';
    if (validation.specialBuiltinValues.has(word)) return 'enumMember';
    if (validation.systemColumns.size > 0 && validation.systemColumns.has(word)) return 'variable';
    if (isAuthoringType(word, databaseKind, authoring)) return 'type';
    if (roleOccurrence) return roleToSemanticTokenType(roleOccurrence.role);
    return 'keyword';
  }
  if (/^[A-Za-z_]/.test(image)) return 'keyword';
  return undefined;
}
