import type { DatabaseKind, DatabaseSqlAuthoring } from "@justybase/contracts";
import {
  NETEZZA_SQL_AUTHORING,
  NetezzaSqlSemanticValidator,
  QualityEngineCore,
  collectNetezzaAuthoringContext,
  getQualityRuleIdForParserCode,
  resolveSqlRenameSymbol,
  collectSqlSymbolUsages,
  splitSqlStatements,
  formatSqlWithProfile,
  getSqlFormatterProfile,
  formatSqlRenameReplacement,
  SqlLexer,
  type ColumnInfo,
  type NetezzaTableReference,
  type QualificationProposal,
  type SchemaProvider,
  type TableInfo,
  type ValidationError,
} from "@justybase/sql-core";

export { getSqlStatementAtPosition, splitSqlStatements } from "@justybase/sql-core";

export type CoreSemanticTokenType =
  | "enumMember"
  | "function"
  | "keyword"
  | "macro"
  | "modifier"
  | "variable"
  | "type"
  | "column"
  | "table"
  | "alias"
  | "schema"
  | "database"
  | "localVariable";
export type CoreSemanticTokenModifier = "readonly" | "defaultLibrary" | "italic";
export interface CoreSemanticToken {
  line: number;
  character: number;
  length: number;
  type: CoreSemanticTokenType;
  modifiers: CoreSemanticTokenModifier[];
}
export interface CoreSemanticTokenResult {
  types: CoreSemanticTokenType[];
  modifiers: CoreSemanticTokenModifier[];
  tokens: CoreSemanticToken[];
}

export type WebLspMetadataKind =
  | "context"
  | "databases"
  | "schemas"
  | "tables"
  | "views"
  | "procedures"
  | "columns"
  | "cachedTableInfo"
  | "tableInfo"
  | "warmDatabaseColumns"
  | "qualifyTable"
  | "netezzaDefaultSchema";
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
export interface CoreRange { start: CorePosition; end: CorePosition; }
export interface CoreDiagnostic {
  range: CoreRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  data?: { suggestedFix?: string };
}
export interface CoreMarkupContent { kind: "markdown" | "plaintext"; value: string; }
export interface CoreHover { range?: CoreRange; contents: CoreMarkupContent; }
export interface CoreLocation { uri: string; range: CoreRange; }
export interface CoreTextEdit { range: CoreRange; newText: string; }
export interface CoreWorkspaceEdit { changes: Record<string, CoreTextEdit[]>; }
export interface CoreRenamePrepare { range: CoreRange; placeholder: string; }
export interface CoreInlayHint { position: CorePosition; label: string; kind?: "type" | "parameter"; }
export interface CoreSignatureParameter { label: string; documentation?: string; }
export interface CoreSignatureInformation { label: string; documentation?: string; parameters: CoreSignatureParameter[]; }
export interface CoreSignatureHelp { signatures: CoreSignatureInformation[]; activeSignature: number; activeParameter: number; }
export interface CoreDocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  range: CoreRange;
  selectionRange: CoreRange;
  children?: CoreDocumentSymbol[];
}
export type CoreKeywordCase = "upper" | "lower" | "preserve";
export interface CoreFormatOptions {
  tabWidth?: number;
  keywordCase?: CoreKeywordCase;
  linesBetweenQueries?: number;
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
  /** Dialect authoring remains available even when execution is unavailable. */
  authoring?: DatabaseSqlAuthoring;
  /** WebSocket sessions can contain documents for multiple database kinds. */
  authoringForContext?: (context: WebLspContext) => DatabaseSqlAuthoring;
  logger?: { error(message: string): void };
}

interface DocumentState {
  context: WebLspContext;
  tableLists: Set<string>;
  tables: Map<string, ApiTableInfo>;
  knownMissingTables: Set<string>;
  qualificationProposals: Map<string, QualificationProposal[]>;
}

interface MetadataColumn {
  name: string;
  type?: string;
  dataType?: string;
  description?: string;
}

interface MetadataTable {
  exists?: boolean;
  table?: string;
  database?: string;
  schema?: string;
  objectType?: string;
  description?: string;
  columns?: MetadataColumn[];
}

const LSP_SYMBOL_VARIABLE = 13;
const LSP_SYMBOL_CLASS = 5;
const LSP_SYMBOL_FIELD = 8;
const LSP_SYMBOL_OBJECT = 19;
const KEYWORD_TOKEN_NAMES = new Set([
  "Select", "From", "Where", "Join", "Inner", "Left", "Right", "Full", "Outer", "On",
  "And", "Or", "Not", "Insert", "Into", "Update", "Delete", "Create", "Drop", "Alter",
  "Table", "View", "GroupBy", "OrderBy", "Having", "Limit", "Offset", "Union", "Intersect",
  "Except", "As", "Distinct", "All", "Null", "Is", "Like", "In", "Between", "Exists", "Case",
  "When", "Then", "Else", "End", "Values", "Set", "Cross", "Natural", "With", "Recursive",
]);

const LARGE_DOCUMENT_LINE_THRESHOLD = 500;
const LARGE_DOCUMENT_CHAR_THRESHOLD = 150_000;
const LSP_COMPLETION_TABLE = 7;
const LSP_COMPLETION_VIEW = 17;

interface ApiTableInfo extends TableInfo {
  objectType?: "TABLE" | "VIEW" | "PROCEDURE";
  description?: string;
}

export class NetezzaWebLspCore {
  private readonly documents = new Map<string, DocumentState>();
  private readonly requestMetadata: WebLspCoreOptions["requestMetadata"];
  private readonly authoring: DatabaseSqlAuthoring;
  private readonly authoringForContext: (context: WebLspContext) => DatabaseSqlAuthoring;

  public constructor(options: WebLspCoreOptions) {
    this.requestMetadata = options.requestMetadata;
    this.authoring = options.authoring ?? NETEZZA_SQL_AUTHORING;
    this.authoringForContext = options.authoringForContext ?? (() => this.authoring);
  }

  private getAuthoring(context: WebLspContext): DatabaseSqlAuthoring {
    return this.authoringForContext(context);
  }

  public setContext(documentUri: string, context: WebLspContext): void {
    const current = this.documents.get(documentUri);
    if (current && sameContext(current.context, context)) return;
    this.documents.set(documentUri, {
      context,
      tableLists: new Set<string>(),
      tables: new Map<string, ApiTableInfo>(),
      knownMissingTables: new Set<string>(),
      qualificationProposals: new Map<string, QualificationProposal[]>(),
    });
  }

  public clearConnection(connectionName: string): void {
    for (const [uri, state] of this.documents) {
      if (state.context.connectionName !== connectionName) continue;
      state.tableLists.clear();
      state.tables.clear();
      state.knownMissingTables.clear();
      state.qualificationProposals.clear();
      this.documents.set(uri, state);
    }
  }

  public async completion(
    documentUri: string,
    _version: number,
    sql: string,
    position: CorePosition,
  ): Promise<CoreCompletionItem[]> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") {
      return this.genericCompletion(documentUri, sql, position, state);
    }
    const offset = offsetAt(sql, position);
    if (isCompletionSuppressed(sql, offset)) return [];
    if (state.context.effectiveDatabase) await this.ensureTableList(documentUri, state);
    const prefix = sql.slice(0, offset);
    const authoring = collectNetezzaAuthoringContext(sql);
    // Qualified completion needs column metadata, not just the object list used
    // for top-level suggestions. Reuse the same cache warming path as diagnostics.
    await this.warmTables(documentUri, state, authoring.tableReferences);
    const currentWord = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(prefix)?.[0] ?? "";
    const qualifier = /(?:^|[^A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_$]*)\.[A-Za-z0-9_$]*$/.exec(prefix)?.[1];
    if (qualifier) {
      const table = findCompletionTable(qualifier, state.tables, authoring.tableReferences);
      const columnPrefix = currentWord.toUpperCase();
      const columns = table?.columns ?? [];
      const seenColumns = new Set<string>();
      return columns
        .filter((column) => column.name.toUpperCase().startsWith(columnPrefix))
        .filter((column) => {
          const key = column.name.toUpperCase();
          if (seenColumns.has(key)) return false;
          seenColumns.add(key);
          return true;
        })
        .map((column) => ({ label: column.name, kind: 5, detail: column.dataType }));
    }
    const normalized = currentWord.toUpperCase();
    const items: CoreCompletionItem[] = [
      ...NETEZZA_SQL_AUTHORING.completionKeywords.map((label) => ({ label, kind: 14 })),
      ...Array.from(NETEZZA_SQL_AUTHORING.signatures.values()).flatMap((signatures) =>
        signatures.map((signature) => ({ label: signature.name, kind: 3, detail: "Netezza function" }))),
    ];
    if (state.context.effectiveDatabase) {
      for (const table of state.tables.values()) {
        items.push({ label: table.name, kind: table.objectType === "VIEW" ? LSP_COMPLETION_VIEW : LSP_COMPLETION_TABLE, detail: table.objectType ?? "TABLE" });
      }
    }
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.kind}:${item.label.toUpperCase()}`;
      if (seen.has(key) || (normalized && !item.label.toUpperCase().startsWith(normalized))) return false;
      seen.add(key);
      return true;
    }).slice(0, 200);
  }

  public async diagnostics(
    documentUri: string,
    _version: number,
    sql: string,
  ): Promise<CoreDiagnostic[]> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") {
      return this.genericDiagnostics(sql, this.getAuthoring(state.context));
    }
    await this.warmTables(
      documentUri,
      state,
      collectNetezzaAuthoringContext(sql).tableReferences,
    );
    const schemaProvider = new ApiSchemaProvider(state);
    const validator = new NetezzaSqlSemanticValidator(schemaProvider);
    const validation = validator.validate(sql);
    const quality = new QualityEngineCore(validator, NETEZZA_SQL_AUTHORING.qualityRules)
      .analyzeQualityRulesOnly(sql);
    const parserDiagnostics = [...validation.errors, ...validation.warnings].map((diagnostic) =>
      this.toCoreDiagnostic(sql, diagnostic));
    const qualityDiagnostics = quality.issues.map((issue) => ({
      range: rangeFromOffsets(sql, issue.startOffset, issue.endOffset),
      severity: issue.severity + 1,
      code: issue.ruleId,
      source: "justybase-netezza",
      message: issue.message,
      data: issue.suggestedFix ? { suggestedFix: issue.suggestedFix } : undefined,
    }));
    return [...parserDiagnostics, ...qualityDiagnostics].sort(compareDiagnostics);
  }

  public async hover(documentUri: string, _version: number, sql: string, position: CorePosition): Promise<CoreHover | null> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") {
      return this.genericHover(documentUri, sql, position, state);
    }
    const offset = offsetAt(sql, position);
    const authoring = collectNetezzaAuthoringContext(sql);
    if (state.context.effectiveDatabase) await this.ensureTableList(documentUri, state);
    await this.warmTables(documentUri, state, authoring.tableReferences);

    const qualifiedColumn = authoring.qualifiedColumnReferences.find((reference) =>
      (reference.qualifierStartOffset !== undefined && reference.qualifierEndOffset !== undefined
        && offset >= reference.qualifierStartOffset && offset <= reference.qualifierEndOffset)
      || (reference.columnStartOffset !== undefined && reference.columnEndOffset !== undefined
        && offset >= reference.columnStartOffset && offset <= reference.columnEndOffset),
    );
    if (qualifiedColumn) {
      const table = findCompletionTable(qualifiedColumn.qualifier, state.tables, authoring.tableReferences);
      const column = table?.columns.find((item) => item.name.toUpperCase() === qualifiedColumn.column.toUpperCase());
      if (table && column) {
        return this.metadataColumnHover(
          sql,
          qualifiedColumn.column,
          qualifiedColumn.columnStartOffset ?? offset,
          qualifiedColumn.columnEndOffset ?? offset + qualifiedColumn.column.length,
          qualifiedColumn.qualifier,
          table,
          column,
        );
      }
    }

    const tableReference = authoring.tableReferences.find((reference) =>
      (reference.nameStartOffset !== undefined && reference.nameEndOffset !== undefined
        && offset >= reference.nameStartOffset && offset <= reference.nameEndOffset)
      || (reference.aliasStartOffset !== undefined && reference.aliasEndOffset !== undefined
        && offset >= reference.aliasStartOffset && offset <= reference.aliasEndOffset),
    );
    if (tableReference) {
      const table = findCompletionTable(tableReference.alias ?? tableReference.name, state.tables, authoring.tableReferences)
        ?? Array.from(state.tables.values()).find((item) => item.name.toUpperCase() === tableReference.name.toUpperCase());
      if (table) return this.metadataTableHover(sql, tableReference, table, offset);
    }

    const hoveredIdentifier = identifierAtOffset(sql, offset);
    const metadataTable = hoveredIdentifier
      ? Array.from(state.tables.values()).find(table => table.name.toUpperCase() === hoveredIdentifier.normalized.toUpperCase())
      : undefined;
    if (metadataTable && hoveredIdentifier) {
      return this.metadataTableHover(sql, {
        name: metadataTable.name,
        nameStartOffset: hoveredIdentifier.start,
        nameEndOffset: hoveredIdentifier.end,
      }, metadataTable, offset);
    }

    const resolution = resolveSqlRenameSymbol(sql, offset);
    if (!resolution) return null;
    return {
      range: rangeFromOffsets(sql, resolution.target.startOffset, resolution.target.endOffset),
      contents: { kind: "markdown", value: `**${resolution.kind}** \`${resolution.name}\`` },
    };
  }

  public async definition(documentUri: string, _version: number, sql: string, position: CorePosition): Promise<CoreLocation | null> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericDefinition(documentUri, sql, position);
    const resolution = resolveSqlRenameSymbol(sql, offsetAt(sql, position));
    const definition = resolution?.occurrences.find((occurrence) => occurrence.role === "definition");
    return definition
      ? { uri: documentUri, range: rangeFromOffsets(sql, definition.startOffset, definition.endOffset) }
      : null;
  }

  public async references(documentUri: string, _version: number, sql: string, position: CorePosition, includeDeclaration: boolean): Promise<CoreLocation[] | null> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericReferences(documentUri, sql, position, includeDeclaration);
    const resolution = resolveSqlRenameSymbol(sql, offsetAt(sql, position));
    if (!resolution) return null;
    return resolution.occurrences
      .filter((occurrence) => includeDeclaration || occurrence.role !== "definition")
      .map((occurrence) => ({ uri: documentUri, range: rangeFromOffsets(sql, occurrence.startOffset, occurrence.endOffset) }));
  }

  public async prepareRename(_documentUri: string, _version: number, sql: string, position: CorePosition): Promise<CoreRenamePrepare | null> {
    const state = await this.ensureState(_documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericPrepareRename(sql, position);
    const resolution = resolveSqlRenameSymbol(sql, offsetAt(sql, position));
    return resolution
      ? { range: rangeFromOffsets(sql, resolution.target.startOffset, resolution.target.endOffset), placeholder: resolution.name }
      : null;
  }

  public async rename(documentUri: string, _version: number, sql: string, position: CorePosition, newName: string): Promise<CoreWorkspaceEdit | null> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericRename(documentUri, sql, position, newName);
    if (!newName.trim()) return null;
    const resolution = resolveSqlRenameSymbol(sql, offsetAt(sql, position));
    if (!resolution) return null;
    return {
      changes: {
        [documentUri]: resolution.occurrences.map((occurrence) => ({
          range: rangeFromOffsets(sql, occurrence.startOffset, occurrence.endOffset),
          newText: formatSqlRenameReplacement(occurrence.text, newName),
        })),
      },
    };
  }

  public async inlayHints(
    documentUri: string,
    _version: number,
    sql: string,
    range?: CoreRange,
  ): Promise<CoreInlayHint[]> {
    const state = await this.ensureState(documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return [];
    const authoring = collectNetezzaAuthoringContext(sql);
    await this.warmTables(documentUri, state, authoring.tableReferences);
    const startOffset = range ? offsetAt(sql, range.start) : 0;
    const endOffset = range ? offsetAt(sql, range.end) : sql.length;
    const hints: CoreInlayHint[] = [];
    const seen = new Set<string>();

    for (const reference of authoring.qualifiedColumnReferences) {
      if (reference.endOffset < startOffset || reference.endOffset > endOffset) continue;
      const table = findCompletionTable(reference.qualifier, state.tables, authoring.tableReferences);
      const column = table?.columns.find((item) =>
        item.name.toUpperCase() === reference.column.toUpperCase(),
      );
      const dataType = column?.dataType?.trim();
      if (!dataType) continue;
      const key = `${reference.endOffset}|${dataType.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({
        position: positionAt(sql, reference.endOffset),
        label: ` ${dataType}`,
        kind: "type",
      });
    }

    return hints;
  }

  public async signatureHelp(_documentUri: string, _version: number, sql: string, position: CorePosition): Promise<CoreSignatureHelp | null> {
    const state = await this.ensureState(_documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericSignatureHelp(sql, position, this.getAuthoring(state.context));
    const prefix = sql.slice(0, offsetAt(sql, position));
    const match = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(([^()]*)$/.exec(prefix);
    if (!match) return null;
    const signatures = this.getAuthoring(state.context).signatures.get(match[1].toUpperCase());
    if (!signatures?.length) return null;
    const activeParameter = match[2].split(",").length - 1;
    return {
      signatures: signatures.map((signature) => ({
        label: `${signature.name}(${signature.parameters.join(", ")})`,
        documentation: signature.description,
        parameters: signature.parameters.map((parameter) => ({ label: parameter })),
      })),
      activeSignature: 0,
      activeParameter,
    };
  }

  private genericSignatureHelp(sql: string, position: CorePosition, authoring = this.authoring): CoreSignatureHelp | null {
    const prefix = sql.slice(0, offsetAt(sql, position));
    const match = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(([^()]*)$/u.exec(prefix);
    if (!match) return null;
    const signatures = authoring.signatures.get(match[1].toUpperCase());
    if (!signatures?.length) return null;
    return {
      signatures: signatures.map(signature => ({
        label: `${signature.name}(${signature.parameters.join(', ')})`,
        documentation: signature.description,
        parameters: signature.parameters.map(parameter => ({ label: parameter })),
      })),
      activeSignature: 0,
      activeParameter: match[2].split(',').length - 1,
    };
  }

  public async documentSymbols(documentUri: string, _version: number, sql: string): Promise<CoreDocumentSymbol[]> {
    const state = await this.ensureState(documentUri);
    if (isLargeDocument(sql)) return [];
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return this.genericDocumentSymbols(sql);
    const sqlSymbols = collectSqlSymbolUsages(sql).map((symbol) => {
      const definition = symbol.occurrences.find((occurrence) => occurrence.role === "definition") ?? symbol.occurrences[0];
      const min = Math.min(...symbol.occurrences.map((occurrence) => occurrence.startOffset));
      const max = Math.max(...symbol.occurrences.map((occurrence) => occurrence.endOffset));
      const range = rangeFromOffsets(sql, min, max);
      const selectionRange = definition
        ? rangeFromOffsets(sql, definition.startOffset, definition.endOffset)
        : range;
      return {
        name: symbol.name,
        detail: `${symbol.kind} (${symbol.occurrences.filter((occurrence) => occurrence.role === "reference").length} references)`,
        kind: symbol.kind === "cte" ? LSP_SYMBOL_CLASS : symbol.kind === "table_alias" ? LSP_SYMBOL_VARIABLE : LSP_SYMBOL_OBJECT,
        range,
        selectionRange,
        children: symbol.occurrences
          .filter((occurrence) => occurrence.role === "reference")
          .map((occurrence) => ({
            name: occurrence.text,
            detail: "Reference",
            kind: LSP_SYMBOL_FIELD,
            range: rangeFromOffsets(sql, occurrence.startOffset, occurrence.endOffset),
            selectionRange: rangeFromOffsets(sql, occurrence.startOffset, occurrence.endOffset),
          })),
      } satisfies CoreDocumentSymbol;
    });
    return [...collectMacroDocumentSymbols(sql), ...sqlSymbols].sort((left, right) => {
      const leftOffset = left.selectionRange.start.line * 1_000_000 + left.selectionRange.start.character;
      const rightOffset = right.selectionRange.start.line * 1_000_000 + right.selectionRange.start.character;
      return leftOffset - rightOffset;
    });
  }

  private async genericCompletion(
    documentUri: string,
    sql: string,
    position: CorePosition,
    state: DocumentState,
  ): Promise<CoreCompletionItem[]> {
    const authoring = this.getAuthoring(state.context);
    const offset = offsetAt(sql, position);
    if (isCompletionSuppressed(sql, offset)) return [];
    await this.ensureTableList(documentUri, state);
    const prefix = sql.slice(0, offset);
    const currentWord = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(prefix)?.[0] ?? "";
    const qualifier = /(?:^|[^A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_$]*)\.[A-Za-z0-9_$]*$/.exec(prefix)?.[1];
    const genericKeywords = authoring.completionKeywords;
    const genericFunctions = Array.from(authoring.signatures.keys());
    const items: CoreCompletionItem[] = [
      ...genericKeywords.map(label => ({ label, kind: 14 })),
      ...genericFunctions.map(label => ({ label, kind: 3, detail: `${state.context.databaseKind ?? "SQL"} function` })),
    ];
    if (qualifier) {
      const foundTable = Array.from(state.tables.values()).find(candidate =>
        candidate.name.toUpperCase() === qualifier.toUpperCase()
        || candidate.alias?.toUpperCase() === qualifier.toUpperCase());
      const table = foundTable && foundTable.columns.length === 0
        ? await this.loadGenericTableInfo(documentUri, state, foundTable)
        : foundTable;
      if (table) {
        return table.columns
          .filter(column => column.name.toUpperCase().startsWith(currentWord.toUpperCase()))
          .map(column => ({ label: column.name, kind: 5, detail: column.dataType }));
      }
    }
    for (const table of state.tables.values()) {
      items.push({ label: table.name, kind: table.objectType === "VIEW" ? LSP_COMPLETION_VIEW : LSP_COMPLETION_TABLE, detail: table.objectType ?? "TABLE" });
    }
    const normalized = currentWord.toUpperCase();
    const seen = new Set<string>();
    return items.filter(item => {
      const key = `${item.kind}:${item.label.toUpperCase()}`;
      if (seen.has(key) || (normalized && !item.label.toUpperCase().startsWith(normalized))) return false;
      seen.add(key);
      return true;
    }).slice(0, 200);
  }

  private genericDiagnostics(sql: string, authoring = this.authoring): CoreDiagnostic[] {
    const state = scanGenericDelimiters(sql);
    const diagnostics: CoreDiagnostic[] = state.unexpectedClosingParenthesisOffsets.map(offset => ({
      range: rangeFromOffsets(sql, offset, offset + 1),
      severity: 1,
      code: "WEB001",
      source: "justybase-web",
      message: "Unexpected closing parenthesis.",
    }));
    if (state.quoteOpen) diagnostics.push({
      range: rangeFromOffsets(sql, Math.max(0, sql.lastIndexOf("'")), sql.length),
      severity: 1,
      code: "WEB002",
      source: "justybase-web",
      message: "Unterminated string literal.",
    });
    if (state.parentheses > 0) diagnostics.push({
      range: rangeFromOffsets(sql, sql.length, sql.length),
      severity: 1,
      code: "WEB003",
      source: "justybase-web",
      message: "Unclosed parenthesis.",
    });
    const qualityDiagnostics = authoring.qualityRules
      .filter(rule => !rule.onDemandOnly)
      .flatMap(rule => rule.check(sql).map(issue => ({
        range: rangeFromOffsets(sql, issue.startOffset, issue.endOffset),
        severity: issue.severity + 1,
        code: issue.ruleId,
        source: `justybase-${authoring.validation.databaseKind ?? 'sql'}`,
        message: issue.message,
        data: issue.suggestedFix ? { suggestedFix: issue.suggestedFix } : undefined,
      })));
    return [...diagnostics, ...qualityDiagnostics].sort(compareDiagnostics);
  }

  private async genericHover(documentUri: string, sql: string, position: CorePosition, state: DocumentState): Promise<CoreHover | null> {
    const offset = offsetAt(sql, position);
    if (isCompletionSuppressed(sql, offset)) return null;
    await this.ensureTableList(documentUri, state);
    const word = identifierAtOffset(sql, offset);
    if (!word) return null;
    const qualifier = /([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*$/.exec(sql.slice(0, word.start))?.[1];
    const table = qualifier
      ? Array.from(state.tables.values()).find(candidate => candidate.name.toUpperCase() === qualifier.toUpperCase() || candidate.alias?.toUpperCase() === qualifier.toUpperCase())
      : Array.from(state.tables.values()).find(candidate => candidate.name.toUpperCase() === word.normalized.toUpperCase());
    if (!table) return null;
    const tableWithColumns = table.columns.length > 0
      ? table
      : await this.loadGenericTableInfo(documentUri, state, table);
    if (qualifier) {
      const column = tableWithColumns?.columns.find(candidate => candidate.name.toUpperCase() === word.normalized.toUpperCase());
      return column ? this.metadataColumnHover(sql, word.text, word.start, word.end, qualifier, tableWithColumns, column) : null;
    }
    return this.metadataTableHover(sql, { name: tableWithColumns.name, nameStartOffset: word.start, nameEndOffset: word.end }, tableWithColumns, offset);
  }

  private async loadGenericTableInfo(documentUri: string, state: DocumentState, table: ApiTableInfo): Promise<ApiTableInfo> {
    const response = await this.requestMetadata({
      documentUri,
      kind: "tableInfo",
      database: table.database ?? state.context.effectiveDatabase,
      schema: table.schema ?? state.context.effectiveSchema,
      table: table.name,
    });
    const metadata = parseMetadataTable(response);
    const loaded = metadata ? toTableInfo(metadata, table.name) : undefined;
    if (!loaded) return table;
    const merged = { ...table, ...loaded, objectType: loaded.objectType ?? table.objectType, description: loaded.description ?? table.description };
    state.tables.set(tableKey(merged.database, merged.schema, merged.name), merged);
    return merged;
  }

  private async genericDefinition(documentUri: string, sql: string, position: CorePosition): Promise<CoreLocation | null> {
    const target = identifierAtOffset(sql, offsetAt(sql, position));
    if (!target) return null;
    const first = findIdentifierOccurrences(sql, target.normalized)[0];
    return first ? { uri: documentUri, range: rangeFromOffsets(sql, first.start, first.end) } : null;
  }

  private async genericReferences(documentUri: string, sql: string, position: CorePosition, includeDeclaration: boolean): Promise<CoreLocation[] | null> {
    const target = identifierAtOffset(sql, offsetAt(sql, position));
    if (!target) return null;
    const occurrences = findIdentifierOccurrences(sql, target.normalized);
    const filtered = includeDeclaration ? occurrences : occurrences.slice(1);
    return filtered.map(item => ({ uri: documentUri, range: rangeFromOffsets(sql, item.start, item.end) }));
  }

  private async genericPrepareRename(sql: string, position: CorePosition): Promise<CoreRenamePrepare | null> {
    const target = identifierAtOffset(sql, offsetAt(sql, position));
    return target ? { range: rangeFromOffsets(sql, target.start, target.end), placeholder: target.text } : null;
  }

  private async genericRename(documentUri: string, sql: string, position: CorePosition, newName: string): Promise<CoreWorkspaceEdit | null> {
    const target = identifierAtOffset(sql, offsetAt(sql, position));
    if (!target || !newName.trim()) return null;
    return { changes: { [documentUri]: findIdentifierOccurrences(sql, target.normalized).map(item => ({
      range: rangeFromOffsets(sql, item.start, item.end),
      newText: formatSqlRenameReplacement(item.text, newName),
    })) } };
  }

  private genericDocumentSymbols(sql: string): CoreDocumentSymbol[] {
    return collectMacroDocumentSymbols(sql);
  }

  private metadataColumnHover(
    sql: string,
    name: string,
    startOffset: number,
    endOffset: number,
    qualifier: string,
    table: ApiTableInfo,
    column: ColumnInfo,
  ): CoreHover {
    const lines = [`**column** \`${name}\``];
    if (column.dataType) lines.push(`: \`${column.dataType}\``);
    lines.push(`${qualifier} → \`${formatObjectPath(table.database, table.schema, table.name)}\``);
    if (column.description) lines.push("", `Description: ${truncateHoverText(column.description)}`);
    return { range: rangeFromOffsets(sql, startOffset, endOffset), contents: { kind: "markdown", value: lines.join("\n") } };
  }

  private metadataTableHover(sql: string, reference: NetezzaTableReference, table: ApiTableInfo, offset: number): CoreHover {
    const startOffset = reference.nameStartOffset ?? offset;
    const endOffset = reference.nameEndOffset ?? startOffset + reference.name.length;
    const lines = [`**${table.objectType === "VIEW" ? "view" : "table"}** \`${reference.alias ?? reference.name}\``, `\`${formatObjectPath(table.database, table.schema, table.name)}\``];
    if (table.description) lines.push("", truncateHoverText(table.description));
    if (table.columns.length) {
      lines.push("", "---", "", table.columns.map(column => {
        let line = `- **${column.name}**`;
        if (column.dataType) line += ` : \`${column.dataType}\``;
        if (column.description) line += ` — _${truncateHoverText(column.description)}_`;
        return line;
      }).join("\n"));
    }
    return { range: rangeFromOffsets(sql, startOffset, endOffset), contents: { kind: "markdown", value: lines.join("\n") } };
  }

  public async format(
    sql: string,
    optionsOrDatabaseKind?: (CoreFormatOptions & { databaseKind?: DatabaseKind }) | DatabaseKind,
    legacyOptions?: CoreFormatOptions,
  ): Promise<string> {
    const options = typeof optionsOrDatabaseKind === "string"
      ? { ...legacyOptions, databaseKind: optionsOrDatabaseKind }
      : optionsOrDatabaseKind;
    return formatSqlWithProfile(
      sql,
      getSqlFormatterProfile(options?.databaseKind),
      options,
    );
  }

  public async semanticTokens(_documentUri: string, _version: number, sql: string): Promise<CoreSemanticTokenResult> {
    const state = await this.ensureState(_documentUri);
    if (state.context.databaseKind && state.context.databaseKind !== "netezza") return genericSemanticTokens(sql, this.getAuthoring(state.context));
    const usages = collectSqlSymbolUsages(sql);
    const roles = new Map<number, string>();
    for (const usage of usages) {
      for (const occurrence of usage.occurrences) roles.set(occurrence.startOffset, usage.kind);
    }
    const lexical = SqlLexer.tokenize(sql);
    const tokens: CoreSemanticToken[] = [];
    for (const token of lexical.tokens) {
      const image = token.image;
      if (!image || token.startOffset === undefined) continue;
      const tokenName = token.tokenType.name;
      const role = roles.get(token.startOffset);
      let type: CoreSemanticTokenType | undefined;
      if (KEYWORD_TOKEN_NAMES.has(tokenName)) type = "keyword";
      else if (tokenName === "Identifier" && NETEZZA_SQL_AUTHORING.signatures.has(image.toUpperCase())) type = "function";
      else if (role === "cte" || role === "table") type = "table";
      else if (role === "table_alias") type = "alias";
      else if (role === "local_variable") type = "localVariable";
      else if (tokenName === "Identifier") type = "column";
      if (!type) continue;
      tokens.push({
        line: Math.max(0, (token.startLine ?? 1) - 1),
        character: Math.max(0, (token.startColumn ?? 1) - 1),
        length: image.length,
        type,
        modifiers: role === "table_alias" ? ["italic"] : [],
      });
    }
    return {
      types: ["enumMember", "function", "keyword", "macro", "modifier", "variable", "type", "column", "table", "alias", "schema", "database", "localVariable"],
      modifiers: ["readonly", "defaultLibrary", "italic"],
      tokens,
    };
  }

  public async window(_documentUri: string, _version: number, sql: string, offset: number, _units: "sentence", direction: "before" | "after"): Promise<number | null> {
    const statements = splitSqlStatements(sql);
    if (direction === "before") {
      const previous = statements.filter((statement) => statement.startOffset < offset).at(-1);
      return previous?.startOffset ?? null;
    }
    return statements.find((statement) => statement.startOffset > offset)?.startOffset ?? null;
  }

  public close(documentUri: string): void {
    this.documents.delete(documentUri);
  }

  private async ensureState(documentUri: string): Promise<DocumentState> {
    const current = this.documents.get(documentUri);
    if (current) return current;
    const response = await this.requestMetadata({ documentUri, kind: "context" });
    const context = parseContext(response);
    const state: DocumentState = {
      context,
      tableLists: new Set<string>(),
      tables: new Map<string, ApiTableInfo>(),
      knownMissingTables: new Set<string>(),
      qualificationProposals: new Map<string, QualificationProposal[]>(),
    };
    this.documents.set(documentUri, state);
    return state;
  }

  private async ensureTableList(documentUri: string, state: DocumentState): Promise<void> {
    if (!state.context.effectiveDatabase) return;
    const key = `${state.context.effectiveDatabase}|${state.context.effectiveSchema ?? ""}`.toUpperCase();
    if (state.tableLists.has(key)) return;
    const responses = [
      await this.requestMetadata({
        documentUri,
        kind: "tables",
        database: state.context.effectiveDatabase,
        schema: state.context.effectiveSchema,
      }),
      await this.requestMetadata({
        documentUri,
        kind: "views",
        database: state.context.effectiveDatabase,
        schema: state.context.effectiveSchema,
      }),
    ];
    for (const response of responses) {
      for (const item of parseMetadataList(response)) {
        const table = toTableInfo(item);
        if (table) state.tables.set(tableKey(table.database, table.schema, table.name), table);
      }
    }
    state.tableLists.add(key);
  }

  private async warmTables(
    documentUri: string,
    state: DocumentState,
    references: readonly NetezzaTableReference[],
  ): Promise<void> {
    for (const reference of references) {
      const key = tableKey(reference.database ?? state.context.effectiveDatabase, reference.schema ?? state.context.effectiveSchema, reference.name);
      const qualificationKey = tableKey(reference.database, reference.schema, reference.name);
      if (!state.qualificationProposals.has(qualificationKey)
        && !(reference.database && reference.schema)) {
        const qualificationResponse = await this.requestMetadata({
          documentUri,
          kind: "qualifyTable",
          database: reference.database,
          schema: reference.schema,
          table: reference.name,
        });
        state.qualificationProposals.set(
          qualificationKey,
          parseQualificationProposals(qualificationResponse),
        );
      }
      // The object-list cache supplies names only. Keep warming a referenced
      // table until its columns are available for completion and validation.
      if (state.tables.get(key)?.columns.length || state.knownMissingTables.has(key)) continue;
      const response = await this.requestMetadata({
        documentUri,
        kind: "cachedTableInfo",
        database: reference.database ?? state.context.effectiveDatabase,
        schema: reference.schema ?? state.context.effectiveSchema,
        table: reference.name,
      });
      let table = parseMetadataTable(response);
      if (!table || (table.columns ?? []).length === 0) {
        const fetched = await this.requestMetadata({
          documentUri,
          kind: "tableInfo",
          database: reference.database ?? state.context.effectiveDatabase,
          schema: reference.schema ?? state.context.effectiveSchema,
          table: reference.name,
        });
        table = parseMetadataTable(fetched);
      }
      if (table && table.exists !== false) {
        const tableInfo = toTableInfo(table, reference.name);
        if (tableInfo) state.tables.set(key, tableInfo);
      } else {
        state.knownMissingTables.add(key);
      }

    }
  }

  private toCoreDiagnostic(_sql: string, diagnostic: ValidationError): CoreDiagnostic {
    return {
      range: rangeFromPosition(diagnostic.position),
      severity: diagnostic.severity === "error" ? 1 : diagnostic.severity === "warning" ? 2 : diagnostic.severity === "information" ? 3 : 4,
      code: getQualityRuleIdForParserCode(diagnostic.code) ?? diagnostic.code,
      source: "justybase-netezza",
      message: diagnostic.message,
      data: diagnostic.suggestedFix ? { suggestedFix: diagnostic.suggestedFix } : undefined,
    };
  }
}

class ApiSchemaProvider implements SchemaProvider {
  public constructor(private readonly state: DocumentState) {}

  public getTable(database: string | undefined, schema: string | undefined, tableName: string): TableInfo | undefined {
    const direct = this.state.tables.get(tableKey(database, schema, tableName));
    if (direct) return direct;
    const normalizedName = tableName.toUpperCase();
    return Array.from(this.state.tables.values()).find((table) =>
      table.name.toUpperCase() === normalizedName
      && (!database || table.database?.toUpperCase() === database.toUpperCase())
      && (!schema || table.schema?.toUpperCase() === schema.toUpperCase()),
    );
  }

  public tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean {
    const key = tableKey(database, schema, tableName);
    if (this.state.knownMissingTables.has(key)) return false;
    return true;
  }

  public canValidateUnqualifiedTableReferences(): boolean {
    return this.state.tableLists.size > 0 || this.state.tables.size > 0;
  }

  public getTablesInSchema(database: string | undefined, schema: string): TableInfo[] {
    return Array.from(this.state.tables.values()).filter((table) =>
      (!database || table.database?.toUpperCase() === database.toUpperCase())
      && table.schema?.toUpperCase() === schema.toUpperCase(),
    );
  }

  public getDatabases(): string[] {
    return Array.from(new Set(
      Array.from(this.state.tables.values())
        .map((table) => table.database)
        .filter((database): database is string => Boolean(database)),
    ));
  }

  public getKnownFunctions(): ReadonlySet<string> {
    return NETEZZA_SQL_AUTHORING.validation.builtinFunctions;
  }

  public proposeTableQualification(request: { database?: string; schema?: string; name: string }): QualificationProposal[] {
    if (request.database && request.schema) return [];
    const key = tableKey(request.database, request.schema, request.name);
    return this.state.qualificationProposals.get(key) ?? [];
  }
}

interface GenericDelimiterState {
  quoteOpen: boolean;
  parentheses: number;
  unexpectedClosingParenthesisOffsets: number[];
}

interface IdentifierOccurrence {
  text: string;
  normalized: string;
  start: number;
  end: number;
}

function isLargeDocument(sql: string): boolean {
  return sql.length > LARGE_DOCUMENT_CHAR_THRESHOLD || sql.split("\n").length > LARGE_DOCUMENT_LINE_THRESHOLD;
}

function isCompletionSuppressed(sql: string, offset: number): boolean {
  const limit = Math.max(0, Math.min(offset, sql.length));
  let blockComment = 0;
  let lineComment = false;
  let stringLiteral = false;
  for (let index = 0; index < limit; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      continue;
    }
    if (blockComment > 0) {
      if (current === "/" && next === "*") { blockComment += 1; index += 1; }
      else if (current === "*" && next === "/") { blockComment -= 1; index += 1; }
      continue;
    }
    if (stringLiteral) {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") stringLiteral = false;
      continue;
    }
    if (current === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (current === "/" && next === "*") { blockComment = 1; index += 1; continue; }
    if (current === "'") stringLiteral = true;
  }
  return lineComment || blockComment > 0 || stringLiteral;
}

function scanGenericDelimiters(sql: string): GenericDelimiterState {
  let quoteOpen = false;
  let parentheses = 0;
  let lineComment = false;
  let blockComment = 0;
  const unexpectedClosingParenthesisOffsets: number[] = [];
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      continue;
    }
    if (blockComment > 0) {
      if (current === "/" && next === "*") { blockComment += 1; index += 1; }
      else if (current === "*" && next === "/") { blockComment -= 1; index += 1; }
      continue;
    }
    if (quoteOpen) {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") quoteOpen = false;
      continue;
    }
    if (current === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (current === "/" && next === "*") { blockComment = 1; index += 1; continue; }
    if (current === "'") { quoteOpen = true; continue; }
    if (current === "(") parentheses += 1;
    if (current === ")") {
      parentheses -= 1;
      if (parentheses < 0) { unexpectedClosingParenthesisOffsets.push(index); parentheses = 0; }
    }
  }
  return { quoteOpen, parentheses, unexpectedClosingParenthesisOffsets };
}

function identifierAtOffset(sql: string, offset: number): IdentifierOccurrence | undefined {
  return scanIdentifiers(sql).find(item => offset >= item.start && offset <= item.end);
}

function findIdentifierOccurrences(sql: string, normalized: string): IdentifierOccurrence[] {
  return scanIdentifiers(sql).filter(item => item.normalized.toUpperCase() === normalized.toUpperCase());
}

function scanIdentifiers(sql: string): IdentifierOccurrence[] {
  const occurrences: IdentifierOccurrence[] = [];
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index + 1 < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(sql.length, index + 2);
      continue;
    }
    if (sql[index] === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
        else if (sql[index++] === "'") break;
      }
      continue;
    }
    if (sql[index] === '"') {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') index += 2;
        else if (sql[index++] === '"') break;
      }
      const text = sql.slice(start, index);
      occurrences.push({ text, normalized: normalizeIdentifierText(text), start, end: index });
      continue;
    }
    if (/[A-Za-z_]/.test(sql[index] ?? "")) {
      const start = index++;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index] ?? "")) index += 1;
      const text = sql.slice(start, index);
      occurrences.push({ text, normalized: text, start, end: index });
      continue;
    }
    index += 1;
  }
  return occurrences;
}

function normalizeIdentifierText(text: string): string {
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).replace(/""/g, '"') : text;
}

function collectMacroDocumentSymbols(sql: string): CoreDocumentSymbol[] {
  const source = maskSqlCommentsAndStrings(sql);
  const declarations = new Map<string, { name: string; start: number; references: IdentifierOccurrence[] }>();
  const declarationPattern = /(?:%let\s+([A-Za-z_][A-Za-z0-9_]*)|declare\s+&([A-Za-z_][A-Za-z0-9_]*))\s*=/gi;
  for (const match of source.matchAll(declarationPattern)) {
    const name = match[1] ?? match[2];
    if (!name || match.index === undefined) continue;
    const start = match.index + match[0].toUpperCase().indexOf(name.toUpperCase());
    declarations.set(name.toUpperCase(), { name, start, references: [] });
  }
  if (declarations.size === 0) return [];
  const macroReferencePattern = /(?:&|\$\{?)([A-Za-z_][A-Za-z0-9_]*)(?:\})?/g;
  for (const match of source.matchAll(macroReferencePattern)) {
    if (!match[1] || match.index === undefined) continue;
    const declaration = declarations.get(match[1].toUpperCase());
    const start = match.index;
    if (!declaration || start <= declaration.start) continue;
    declaration.references.push({ text: match[0], normalized: match[1], start, end: start + match[0].length });
  }
  return Array.from(declarations.values()).map(declaration => {
    const all = [{ text: declaration.name, normalized: declaration.name, start: declaration.start, end: declaration.start + declaration.name.length }, ...declaration.references];
    const min = Math.min(...all.map(item => item.start));
    const max = Math.max(...all.map(item => item.end));
    return {
      name: declaration.name,
      detail: `macro_variable (${declaration.references.length} references)`,
      kind: LSP_SYMBOL_VARIABLE,
      range: rangeFromOffsets(sql, min, max),
      selectionRange: rangeFromOffsets(sql, declaration.start, declaration.start + declaration.name.length),
      children: declaration.references.map(reference => ({
        name: reference.text,
        detail: "Reference",
        kind: LSP_SYMBOL_FIELD,
        range: rangeFromOffsets(sql, reference.start, reference.end),
        selectionRange: rangeFromOffsets(sql, reference.start, reference.end),
      })),
    } satisfies CoreDocumentSymbol;
  });
}

function maskSqlCommentsAndStrings(sql: string): string {
  const chars = sql.split("");
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") { chars[index] = " "; index += 1; }
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      chars[index] = " ";
      if (index + 1 < sql.length) chars[index + 1] = " ";
      index += 2;
      while (index + 1 < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) { if (sql[index] !== "\n" && sql[index] !== "\r") chars[index] = " "; index += 1; }
      if (index < sql.length) chars[index] = " ";
      if (index + 1 < sql.length) chars[index + 1] = " ";
      index = Math.min(sql.length, index + 2);
      continue;
    }
    if (sql[index] === "'") {
      chars[index] = " ";
      index += 1;
      while (index < sql.length) {
        const current = sql[index];
        if (current === "'" && sql[index + 1] === "'") { chars[index] = " "; if (index + 1 < sql.length) chars[index + 1] = " "; index += 2; }
        else { if (current !== "\n" && current !== "\r") chars[index] = " "; index += 1; if (current === "'") break; }
      }
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

function truncateHoverText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function formatObjectPath(database: string | undefined, schema: string | undefined, table: string): string {
  return [database, schema, table].filter(Boolean).join(".") || table;
}

function genericSemanticTokens(sql: string, authoring: DatabaseSqlAuthoring): CoreSemanticTokenResult {
  const keywords = new Set<string>();
  for (const keyword of [...authoring.completionKeywords, ...authoring.formatter.keywords]) {
    for (const word of keyword.split(/\s+/u)) if (word) keywords.add(word.toUpperCase());
  }
  const functions = new Set([
    ...Array.from(authoring.signatures.keys()),
    ...Array.from(authoring.validation.builtinFunctions),
  ].map(value => value.toUpperCase()));
  const tokens = scanIdentifiers(sql).map(item => {
    const upper = item.normalized.toUpperCase();
    const after = sql.slice(item.end).match(/^\s*\(/u);
    const type: CoreSemanticTokenType = keywords.has(upper) ? "keyword" : after && functions.has(upper) ? "function" : "column";
    const position = positionAt(sql, item.start);
    return { line: position.line, character: position.character, length: item.text.length, type, modifiers: [] };
  });
  return {
    types: ["enumMember", "function", "keyword", "macro", "modifier", "variable", "type", "column", "table", "alias", "schema", "database", "localVariable"],
    modifiers: ["readonly", "defaultLibrary", "italic"],
    tokens,
  };
}

function sameContext(left: WebLspContext, right: WebLspContext): boolean {
  return left.connectionName === right.connectionName
    && left.effectiveDatabase === right.effectiveDatabase
    && left.effectiveSchema === right.effectiveSchema
    && left.databaseKind === right.databaseKind
    && left.netezzaSchemasEnabled === right.netezzaSchemasEnabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseContext(value: unknown): WebLspContext {
  if (!isRecord(value)) return { databaseKind: "netezza" };
  const databaseKind = typeof value.databaseKind === "string" ? value.databaseKind as DatabaseKind : "netezza";
  return {
    connectionName: typeof value.connectionName === "string" ? value.connectionName : undefined,
    effectiveDatabase: typeof value.effectiveDatabase === "string" ? value.effectiveDatabase : undefined,
    effectiveSchema: typeof value.effectiveSchema === "string" ? value.effectiveSchema : undefined,
    databaseKind,
    netezzaSchemasEnabled: value.netezzaSchemasEnabled === true,
  };
}

function parseMetadataList(value: unknown): MetadataTable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    exists: typeof item.exists === "boolean" ? item.exists : undefined,
    table: typeof item.name === "string" ? item.name : typeof item.table === "string" ? item.table : undefined,
    database: typeof item.database === "string" ? item.database : undefined,
    schema: typeof item.schema === "string" ? item.schema : undefined,
    objectType: typeof item.objectType === "string" ? item.objectType.toUpperCase() : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    columns: parseColumns(item.columns),
  }));
}

function parseMetadataTable(value: unknown): MetadataTable | undefined {
  if (!isRecord(value)) return undefined;
  return {
    exists: typeof value.exists === "boolean" ? value.exists : undefined,
    table: typeof value.table === "string" ? value.table : typeof value.name === "string" ? value.name : undefined,
    database: typeof value.database === "string" ? value.database : undefined,
    schema: typeof value.schema === "string" ? value.schema : undefined,
    objectType: typeof value.objectType === "string" ? value.objectType.toUpperCase() : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    columns: parseColumns(value.columns),
  };
}

function parseColumns(value: unknown): MetadataColumn[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((column) => {
    if (typeof column.name !== "string") return [];
    return [{
      name: column.name,
      type: typeof column.type === "string" ? column.type : undefined,
      dataType: typeof column.dataType === "string" ? column.dataType : undefined,
      description: typeof column.description === "string" ? column.description : undefined,
    }];
  });
}

function parseQualificationProposals(value: unknown): QualificationProposal[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    if (typeof item.name !== "string" || typeof item.qualifiedText !== "string") return [];
    return [{
      name: item.name,
      qualifiedText: item.qualifiedText,
      database: typeof item.database === "string" ? item.database : undefined,
      schema: typeof item.schema === "string" ? item.schema : undefined,
      isPreferred: item.isPreferred === true,
    }];
  });
}

function toTableInfo(metadata: MetadataTable, fallbackName?: string): ApiTableInfo | undefined {
  const name = metadata.table ?? fallbackName;
  if (!name) return undefined;
  const columns: ColumnInfo[] = (metadata.columns ?? []).map((column) => ({ name: column.name, dataType: column.type ?? column.dataType, description: column.description }));
  const objectType = metadata.objectType === "VIEW" || metadata.objectType === "PROCEDURE" ? metadata.objectType : "TABLE";
  return { name, database: metadata.database, schema: metadata.schema, isCte: false, isTempTable: false, columns, objectType, description: metadata.description };
}

function tableKey(database: string | undefined, schema: string | undefined, table: string): string {
  return [database, schema, table].filter(Boolean).map((part) => part!.toUpperCase()).join(".");
}

function findCompletionTable(
  qualifier: string,
  tables: ReadonlyMap<string, TableInfo>,
  references: readonly NetezzaTableReference[],
): TableInfo | undefined {
  const normalizedQualifier = qualifier.toUpperCase();
  const direct = Array.from(tables.values()).find((table) =>
    table.name.toUpperCase() === normalizedQualifier
    || table.alias?.toUpperCase() === normalizedQualifier,
  );
  if (direct) return direct;

  for (const reference of references) {
    if (reference.alias?.toUpperCase() !== normalizedQualifier) continue;
    const table = Array.from(tables.values()).find((candidate) =>
      candidate.name.toUpperCase() === reference.name.toUpperCase()
      && (!reference.database || candidate.database?.toUpperCase() === reference.database.toUpperCase())
      && (!reference.schema || candidate.schema?.toUpperCase() === reference.schema.toUpperCase()),
    );
    if (table) return { ...table, alias: reference.alias };
  }
  return undefined;
}

function offsetAt(sql: string, position: CorePosition): number {
  let line = 0;
  let offset = 0;
  while (line < position.line && offset < sql.length) {
    if (sql[offset] === "\n") line += 1;
    offset += 1;
  }
  return Math.max(0, Math.min(sql.length, offset + position.character));
}

function positionAt(sql: string, offset: number): CorePosition {
  const safe = Math.max(0, Math.min(sql.length, offset));
  const before = sql.slice(0, safe);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function rangeFromOffsets(sql: string, startOffset: number, endOffset: number): CoreRange {
  return { start: positionAt(sql, startOffset), end: positionAt(sql, Math.max(startOffset + 1, endOffset)) };
}

function rangeFromPosition(position: ValidationError["position"]): CoreRange {
  return {
    start: { line: Math.max(0, position.startLine - 1), character: Math.max(0, position.startColumn - 1) },
    end: { line: Math.max(0, position.endLine - 1), character: Math.max(0, position.endColumn - 1) },
  };
}

function compareDiagnostics(left: CoreDiagnostic, right: CoreDiagnostic): number {
  if (left.range.start.line !== right.range.start.line) return left.range.start.line - right.range.start.line;
  if (left.range.start.character !== right.range.start.character) return left.range.start.character - right.range.start.character;
  return String(left.code ?? "").localeCompare(String(right.code ?? ""));
}
