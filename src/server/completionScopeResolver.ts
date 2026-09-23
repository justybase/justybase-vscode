import {
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import { SqlLexer } from "../sqlParser";
import type { DatabaseKind } from "../contracts/database";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import type { MetadataColumnItem } from "../lsp/protocol";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { createNetezzaUserIdentifier, formatNetezzaIdentifier } from "../dialects/netezza/metadata/identifierUtils";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import {
  parseSemanticScopeWithParser,
  type ParserSemanticScope,
} from "../providers/parsers/parserSqlContext";
import { toDocumentParseRequestFromParts } from "./documentParseRequest";
import type { AliasInfo, LocalDefinition } from "../providers/types";
import {
  buildContextualKeywordItems,
  buildExpressionClauseKeywordItems,
  buildExpressionFunctionItems,
  buildExpressionSpecialValueItems,
  resolveExpressionClauseContext,
} from "./completionExpressionAnalyzer";
import { dedupeCompletionItems } from "./completionRanker";
import {
  isIdentifierToken,
} from "./completionCstUtils";
import {
  parseQualifiedTableNameFromTokens,
  stripQuotes,
} from "./completionDialectAdapter";
import { findLocalDefinition } from "./completionLocalDefinitionUtils";
import {
  toColumnItems,
  toMetadataColumnItem,
  toLocalVariableItems,
  toScopedColumnItems,
} from "./completionRenderer";
import {
  findJoinColumnMatches,
  normalizeJoinColumnName,
} from "./completionJoinConditions";
import { parseQualifierPathToSource } from "./completionQualifierUtils";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { handleVariableCompletion } from "./completionVariableResolver";
import type {
  ScopeSource,
  ScopedColumnCandidate,
  StatementBoundary,
} from "./completionTypes";

interface DirectJoinSource extends ScopeSource {
  kind: "from" | "join";
  qualifierQuoted?: boolean;
}

function formatDirectJoinQualifier(source: DirectJoinSource, databaseKind?: DatabaseKind): string {
  if (databaseKind === "netezza") {
    return formatNetezzaIdentifier(createNetezzaUserIdentifier(source.qualifier, source.qualifierQuoted));
  }
  return formatIdentifierForSql(source.qualifier, databaseKind);
}

function normalizeRelationColumnName(name: string): string {
  return normalizeJoinColumnName(name);
}

export interface QualifierCompletionRequest {
  qualifier: string;
  statement: StatementBoundary | null;
  statementOffset: number;
  documentText: string;
  cursorOffset: number;
  localDefs: LocalDefinition[];
  resolutionLocalDefs: LocalDefinition[];
  documentUri: string;
  documentVersion: number;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  databaseKind?: DatabaseKind;
}

export interface SemanticScopeCompletionRequest {
  statement: StatementBoundary | null;
  statementOffset: number;
  statementPrefix: string;
  linePrefix: string;
  position: Position;
  triggerKind?: CompletionTriggerKind;
  localDefs: LocalDefinition[];
  documentUri: string;
  documentVersion: number;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  databaseKind?: DatabaseKind;
  completionKeywords: readonly string[];
  sqlFunctionNames: readonly string[];
  sqlFunctionSignatures: ReadonlyMap<
    string,
    readonly DatabaseSqlFunctionSignature[]
  >;
  specialBuiltinValues: readonly string[];
}

/**
 * Resolves scope-aware column completions, alias bindings, and expression suggestions.
 */
export class CompletionScopeResolver {
  constructor(
    private readonly contextExtractor: CompletionContextExtractor,
    private readonly metadataResolver: CompletionMetadataResolver,
    private readonly parseSession?: DocumentParseSession,
  ) {}

  public async resolveColumnsForQualifier(
    request: QualifierCompletionRequest,
  ): Promise<CompletionItem[]> {
    const {
      qualifier,
      statement,
      statementOffset,
      documentText,
      cursorOffset,
      localDefs,
      resolutionLocalDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
    } = request;

    const preparedStatement = statement
      ? this.contextExtractor.prepareParserFriendlySql(
          statement.sql,
          statementOffset,
          databaseKind,
        )
      : this.contextExtractor.prepareParserFriendlySql(
          documentText,
          cursorOffset,
          databaseKind,
        );
    const parserFriendlyDocument = this.contextExtractor.prepareParserFriendlySql(
      documentText,
      cursorOffset,
      databaseKind,
    ).sql;
    const aliasBindingsRaw = this.mergeAliasMaps(
      this.getAliasBindings(
        documentUri,
        request.documentVersion,
        preparedStatement.sql,
        preparedStatement.cursorOffset,
        databaseKind,
      ),
      this.extractAdditionalAliasBindings(
        preparedStatement.sql,
        preparedStatement.cursorOffset,
        databaseKind,
      ),
    );

    let aliasBindingsToUse = aliasBindingsRaw;
    if (aliasBindingsRaw.size === 0) {
      const globalAlias = this.mergeAliasMaps(
        this.getAliasBindings(
          documentUri,
          request.documentVersion,
          preparedStatement.sql,
          undefined,
          databaseKind,
        ),
        this.extractAdditionalAliasBindings(preparedStatement.sql, undefined, databaseKind),
      );
      if (globalAlias.size > 0) {
        aliasBindingsToUse = globalAlias;
      }
    }

    const aliasBindings = this.resolveAliasBindingsFully(aliasBindingsToUse);

    const qualifiedSource = parseQualifierPathToSource(qualifier, databaseKind);
    if (qualifiedSource && qualifier.includes(".")) {
      const qualifiedColumns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        qualifiedSource,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        this.buildMetadataColumnOptions(netezzaSchemasEnabled),
      );
      return qualifiedColumns.map((column) => toMetadataColumnItem(column));
    }

    const localDefinition = findLocalDefinition(localDefs, qualifier);
    if (localDefinition) {
      const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
        localDefinition,
        parserFriendlyDocument,
        resolutionLocalDefs,
        documentUri,
        request.documentVersion,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        new Set<string>(),
      );
      if (resolvedColumns.length > 0) {
        return toColumnItems(resolvedColumns);
      }
    }

    const rawAliasBinding = aliasBindingsRaw.get(qualifier.toUpperCase());
    if (rawAliasBinding) {
      const rawLocalAliasTarget = findLocalDefinition(localDefs, rawAliasBinding.table);
      if (rawLocalAliasTarget) {
        const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
          rawLocalAliasTarget,
          parserFriendlyDocument,
          resolutionLocalDefs,
          documentUri,
          request.documentVersion,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          new Set<string>(),
        );
        if (resolvedColumns.length > 0) {
          return toColumnItems(resolvedColumns);
        }
      }
    }

    const aliasBinding = aliasBindings.get(qualifier.toUpperCase());
    if (aliasBinding) {
      const localAliasTarget = findLocalDefinition(localDefs, aliasBinding.table);
      if (localAliasTarget) {
        const resolvedColumns = await this.metadataResolver.resolveLocalDefinitionColumns(
          localAliasTarget,
          parserFriendlyDocument,
          resolutionLocalDefs,
          documentUri,
          request.documentVersion,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          new Set<string>(),
        );
        if (resolvedColumns.length > 0) {
          return toColumnItems(resolvedColumns);
        }
      }

      const columns = await this.metadataResolver.getMetadataColumnsForSource(
        documentUri,
        aliasBinding,
        effectiveDb,
        effectiveSchema,
        databaseKind,
        this.buildMetadataColumnOptions(netezzaSchemasEnabled),
      );
      return columns.map((column) => toMetadataColumnItem(column));
    }

    const directColumns = await this.metadataResolver.getMetadataColumnsForSource(
      documentUri,
      { table: qualifier },
      effectiveDb,
      effectiveSchema,
      databaseKind,
      {
        omitSchemaArgumentWhenUndefined: true,
        netezzaSchemasEnabled,
      },
    );
    return directColumns.map((column) => toMetadataColumnItem(column));
  }

  public async getSemanticScopeCompletions(
    request: SemanticScopeCompletionRequest,
  ): Promise<CompletionItem[] | undefined> {
    const {
      statement,
      statementOffset,
      statementPrefix,
      linePrefix,
      position,
      triggerKind,
      localDefs,
      documentUri,
      documentVersion,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
      completionKeywords,
      sqlFunctionNames,
      sqlFunctionSignatures,
      specialBuiltinValues,
    } = request;

    const clause = resolveExpressionClauseContext(statementPrefix);
    if (!clause) {
      return undefined;
    }

    const typedPrefix = this.contextExtractor.extractCurrentIdentifierPrefix(
      linePrefix,
    );
    // After a completed FROM/JOIN target (with or without alias) only clause
    // keywords can follow; columns are used later via qualifier paths (A.) or
    // in SELECT/WHERE/GROUP BY/HAVING. Do not show anything on a plain
    // whitespace trigger; keywords become available once a letter is typed or
    // the completion is invoked explicitly (Ctrl+Space).
    if (
      clause === "from" &&
      triggerKind === CompletionTriggerKind.TriggerCharacter &&
      typedPrefix === ""
    ) {
      return [];
    }
    if (clause === "from") {
      return buildContextualKeywordItems(
        statementPrefix,
        typedPrefix,
        position,
        completionKeywords,
      );
    }
    if (
      clause === "limit" ||
      clause === "offset" ||
      (clause === "values" && typedPrefix === "")
    ) {
      return [];
    }
    const statementSql = statement ? statement.sql : "";
    const parserFriendlyStatementPrepared = statement
      ? this.contextExtractor.prepareParserFriendlySql(
          statementSql,
          statementOffset,
          databaseKind,
        )
      : this.contextExtractor.prepareParserFriendlySql(
          statementPrefix,
          statementPrefix.length,
          databaseKind,
        );

    const aliasBindingsRaw = this.mergeAliasMaps(
      this.getAliasBindings(
        documentUri,
        documentVersion,
        parserFriendlyStatementPrepared.sql,
        parserFriendlyStatementPrepared.cursorOffset,
        databaseKind,
      ),
      this.extractAdditionalAliasBindings(
        parserFriendlyStatementPrepared.sql,
        parserFriendlyStatementPrepared.cursorOffset,
        databaseKind,
      ),
    );
    const aliasBindings = this.resolveAliasBindingsFully(aliasBindingsRaw);
    const scopeSources = this.getPreferredScopeSources(aliasBindings);
    const scopedColumns = await this.collectScopedColumns(
      scopeSources,
      localDefs,
      documentUri,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
    );

    const columnItems = toScopedColumnItems(scopedColumns, typedPrefix, position);
    const joinConditionItems = clause === "on" && typedPrefix === ""
      ? await this.buildJoinConditionItems(
          statementPrefix,
          localDefs,
          documentUri,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          netezzaSchemasEnabled,
          position,
        )
      : [];
    const variableItems = toLocalVariableItems(localDefs, typedPrefix, position);
    const functionItems = buildExpressionFunctionItems(
      statementPrefix,
      typedPrefix,
      position,
      sqlFunctionNames,
      sqlFunctionSignatures,
      triggerKind === CompletionTriggerKind.Invoked,
    );
    const clauseKeywordItems = buildExpressionClauseKeywordItems(
      statementPrefix,
      typedPrefix,
      position,
      completionKeywords,
    );
    const contextualKeywordItems = buildContextualKeywordItems(
      statementPrefix,
      typedPrefix,
      position,
      completionKeywords,
    );
    const specialValueItems = buildExpressionSpecialValueItems(
      statementPrefix,
      typedPrefix,
      position,
      specialBuiltinValues,
      triggerKind === CompletionTriggerKind.Invoked,
    );
    const items = dedupeCompletionItems([
      ...joinConditionItems,
      ...columnItems,
      ...variableItems,
      ...functionItems,
      ...specialValueItems,
      ...clauseKeywordItems,
      ...contextualKeywordItems,
    ]);
    return items.length > 0 ? items : undefined;
  }

  public handleVariableCompletion = handleVariableCompletion;

  private getAliasBindings(
    documentUri: string,
    documentVersion: number,
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    let bindings = this.getSemanticScope(
      documentUri,
      documentVersion,
      statementSql,
      cursorOffset,
      databaseKind,
    ).preferredAliasBindings;

    if (
      bindings.size === 0 &&
      cursorOffset !== undefined &&
      cursorOffset > 0 &&
      cursorOffset < statementSql.length
    ) {
      const prefixSql = statementSql.substring(0, cursorOffset);
      bindings = this.getSemanticScope(
        documentUri,
        documentVersion,
        prefixSql,
        prefixSql.length,
        databaseKind,
      ).preferredAliasBindings;
    }

    return bindings;
  }

  private getSemanticScope(
    documentUri: string,
    documentVersion: number,
    sql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): ParserSemanticScope {
    if (this.parseSession) {
      try {
        return this.parseSession.getSemanticScope({
          ...toDocumentParseRequestFromParts(
            documentUri,
            documentVersion,
            sql,
            databaseKind,
          ),
          cursorOffset,
        });
      } catch {
        const emptyBindings = new Map<string, AliasInfo>();
        return {
          aliasBindings: emptyBindings,
          globalAliasBindings: emptyBindings,
          preferredAliasBindings: emptyBindings,
          localDefinitions: [],
          visibleLocalDefinitions: [],
          source: "token",
          hasScopedParserContext: false,
        };
      }
    }

    try {
      return parseSemanticScopeWithParser(sql, cursorOffset, databaseKind);
    } catch {
      const emptyBindings = new Map<string, AliasInfo>();
      return {
        aliasBindings: emptyBindings,
        globalAliasBindings: emptyBindings,
        preferredAliasBindings: emptyBindings,
        localDefinitions: [],
        visibleLocalDefinitions: [],
        source: "token",
        hasScopedParserContext: false,
      };
    }
  }

  private resolveAliasBindingsFully(
    aliasBindings: Map<string, AliasInfo>,
  ): Map<string, AliasInfo> {
    const resolved = new Map<string, AliasInfo>();
    const resolve = (key: string, seen: Set<string>): AliasInfo | undefined => {
      if (seen.has(key)) {
        return undefined;
      }
      const binding = aliasBindings.get(key);
      if (!binding) {
        return undefined;
      }
      seen.add(key);
      const targetKey = binding.table.toUpperCase();
      if (targetKey !== key && aliasBindings.has(targetKey)) {
        const deep = resolve(targetKey, seen);
        if (deep) {
          return deep;
        }
      }
      return binding;
    };

    for (const [key, binding] of aliasBindings.entries()) {
      const mapped = resolve(key, new Set<string>());
      resolved.set(key, mapped || binding);
    }
    return resolved;
  }

  private mergeAliasMaps(
    base: Map<string, AliasInfo>,
    extra: Map<string, AliasInfo>,
  ): Map<string, AliasInfo> {
    if (extra.size === 0) {
      return base;
    }

    const merged = new Map<string, AliasInfo>(base);
    for (const [key, value] of extra.entries()) {
      merged.set(key, value);
    }
    return merged;
  }

  private extractAdditionalAliasBindings(
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    return this.parseMergeAliasBindings(statementSql, cursorOffset, databaseKind);
  }

  private parseMergeAliasBindings(
    statementSql: string,
    cursorOffset?: number,
    databaseKind?: DatabaseKind,
  ): Map<string, AliasInfo> {
    const collectBindings = (sql: string): Map<string, AliasInfo> => {
      const bindings = new Map<string, AliasInfo>();
      const lexResult = SqlLexer.tokenize(sql);
      if (lexResult.tokens.length === 0) {
        return bindings;
      }

      const tokens = lexResult.tokens;
      const mergeIndex = tokens.findIndex(
        (token) => token.tokenType.name === "Merge",
      );
      if (mergeIndex < 0) {
        return bindings;
      }

      let scanIndex = mergeIndex + 1;
      if (tokens[scanIndex]?.tokenType.name === "Into") {
        scanIndex += 1;
      }

      const targetRef = parseQualifiedTableNameFromTokens(tokens, scanIndex, databaseKind);
      if (!targetRef) {
        return bindings;
      }
      const targetAliasResult = this.parseAliasAfterTableRef(
        tokens,
        targetRef.nextIndex,
      );
      this.registerAliasBinding(bindings, targetRef.tableRef, targetAliasResult.alias);

      const usingIndex = tokens.findIndex(
        (token, index) =>
          index >= targetAliasResult.nextIndex &&
          token.tokenType.name === "Using",
      );
      if (usingIndex < 0) {
        return bindings;
      }

      const sourceRef = parseQualifiedTableNameFromTokens(tokens, usingIndex + 1, databaseKind);
      if (!sourceRef) {
        return bindings;
      }
      const sourceAliasResult = this.parseAliasAfterTableRef(
        tokens,
        sourceRef.nextIndex,
      );
      this.registerAliasBinding(bindings, sourceRef.tableRef, sourceAliasResult.alias);
      return bindings;
    };

    const primary = collectBindings(statementSql);
    if (
      primary.size > 0 ||
      cursorOffset === undefined ||
      cursorOffset <= 0 ||
      cursorOffset >= statementSql.length
    ) {
      return primary;
    }

    return collectBindings(statementSql.substring(0, cursorOffset));
  }

  private parseAliasAfterTableRef(
    tokens: import("chevrotain").IToken[],
    startIndex: number,
  ): { alias?: string; aliasQuoted?: boolean; nextIndex: number } {
    let index = startIndex;
    if (tokens[index]?.tokenType.name === "As") {
      index += 1;
    }

    const aliasToken = tokens[index];
    if (!isIdentifierToken(aliasToken)) {
      return { nextIndex: index };
    }
    if (this.isMergeAliasBoundaryToken(aliasToken)) {
      return { nextIndex: index };
    }

    return {
      alias: stripQuotes(aliasToken.image),
      aliasQuoted: aliasToken.image.startsWith('"') && aliasToken.image.endsWith('"'),
      nextIndex: index + 1,
    };
  }

  private registerAliasBinding(
    bindings: Map<string, AliasInfo>,
    tableRef: { database?: string; schema?: string; table: string },
    alias?: string,
  ): void {
    const binding: AliasInfo = {
      db: tableRef.database,
      schema: tableRef.schema,
      table: tableRef.table,
    };

    bindings.set(tableRef.table.toUpperCase(), binding);
    if (alias) {
      bindings.set(alias.toUpperCase(), binding);
    }
  }

  private isMergeAliasBoundaryToken(
    token: import("chevrotain").IToken | undefined,
  ): boolean {
    if (!token) {
      return true;
    }

    const boundaryTokenNames = new Set([
      "Using",
      "On",
      "When",
      "Where",
      "Set",
      "Values",
      "Join",
      "Inner",
      "Left",
      "Right",
      "Full",
      "Cross",
      "Natural",
      "Group",
      "Order",
      "Having",
      "Limit",
      "Union",
      "Intersect",
      "Except",
      "Semicolon",
      "Comma",
      "RParen",
    ]);

    return boundaryTokenNames.has(token.tokenType.name);
  }

  private getPreferredScopeSources(
    aliasBindings: Map<string, AliasInfo>,
  ): ScopeSource[] {
    const groups = new Map<
      string,
      { binding: AliasInfo; qualifiers: string[] }
    >();
    aliasBindings.forEach((binding, qualifierName) => {
      const key = `${(binding.db || "").toUpperCase()}|${(binding.schema || "").toUpperCase()}|${binding.table.toUpperCase()}`;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { binding, qualifiers: [qualifierName] });
        return;
      }
      group.qualifiers.push(qualifierName);
    });

    const sources: ScopeSource[] = [];
    groups.forEach((group) => {
      const preferredQualifier =
        group.qualifiers.find(
          (q) => q.toUpperCase() !== group.binding.table.toUpperCase(),
        ) ?? group.qualifiers[0];
      sources.push({
        qualifier: preferredQualifier,
        db: group.binding.db,
        schema: group.binding.schema,
        table: group.binding.table,
      });
    });

    return sources;
  }

  private async buildJoinConditionItems(
    statementPrefix: string,
    localDefs: LocalDefinition[],
    documentUri: string,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind: DatabaseKind | undefined,
    netezzaSchemasEnabled: boolean | undefined,
    position: Position,
  ): Promise<CompletionItem[]> {
    const sources = this.extractDirectJoinSources(statementPrefix, databaseKind);
    const joined = sources[sources.length - 1];
    if (!joined || joined.kind !== "join" || sources.length < 2) {
      return [];
    }

    const qualifierCounts = new Map<string, number>();
    for (const source of sources) {
      const key = source.qualifier.toUpperCase();
      qualifierCounts.set(key, (qualifierCounts.get(key) ?? 0) + 1);
    }
    const uniqueSources = sources.filter((source) => {
      if (qualifierCounts.get(source.qualifier.toUpperCase()) !== 1) return false;
      return !localDefs.some((definition) =>
        definition.name.replace(/^"|"$/g, "").toUpperCase() === source.table.toUpperCase(),
      );
    });
    const currentJoin = uniqueSources[uniqueSources.length - 1];
    if (!currentJoin || currentJoin.kind !== "join") return [];

    const columnsForSource = async (source: DirectJoinSource) => this.metadataResolver.getMetadataColumnsForSource(
      documentUri,
      source,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      this.buildMetadataColumnOptions(netezzaSchemasEnabled),
    );

    const joinedColumns = await columnsForSource(currentJoin);
    if (joinedColumns.length === 0) return [];

    const matches: Array<{
      left: MetadataColumnItem;
      right: MetadataColumnItem;
      leftSource: DirectJoinSource;
      rightSource: DirectJoinSource;
      isKeyMatch: boolean;
    }> = [];
    for (const previousSource of uniqueSources.slice(0, -1)) {
      const previousColumns = await columnsForSource(previousSource);
      const sourceMatches = findJoinColumnMatches(previousColumns, joinedColumns);
      const normalizedCounts = new Map<string, number>();
      for (const column of previousColumns) {
        const normalized = normalizeRelationColumnName(column.name);
        normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
      }
      const joinedCounts = new Map<string, number>();
      for (const column of joinedColumns) {
        const normalized = normalizeRelationColumnName(column.name);
        joinedCounts.set(normalized, (joinedCounts.get(normalized) ?? 0) + 1);
      }
      for (const match of sourceMatches) {
        const normalized = normalizeRelationColumnName(match.left.name);
        if (!match.isKeyMatch && ((normalizedCounts.get(normalized) ?? 0) !== 1
          || (joinedCounts.get(normalized) ?? 0) !== 1)) {
          continue;
        }
        matches.push({ ...match, leftSource: previousSource, rightSource: currentJoin });
      }
    }

    const keyItems: CompletionItem[] = [];
    const heuristicItems: CompletionItem[] = [];
    for (const match of matches) {
      const left = `${formatDirectJoinQualifier(match.leftSource, databaseKind)}.${formatIdentifierForSql(match.left.name, databaseKind)}`;
      const right = `${formatDirectJoinQualifier(match.rightSource, databaseKind)}.${formatIdentifierForSql(match.right.name, databaseKind)}`;
      const text = `${left} = ${right}`;
      const item: CompletionItem = {
        label: text,
        kind: CompletionItemKind.Reference,
        detail: match.isKeyMatch ? "Join condition (key match)" : "Join condition (name match)",
        insertText: text,
        sortText: `${match.isKeyMatch ? "0" : "1"}_${text.toUpperCase()}`,
        textEdit: {
          range: { start: position, end: position },
          newText: text,
        },
      };
      (match.isKeyMatch ? keyItems : heuristicItems).push(item);
    }
    return [...keyItems, ...heuristicItems];
  }

  private extractDirectJoinSources(
    sql: string,
    databaseKind?: DatabaseKind,
  ): DirectJoinSource[] {
    const tokens = SqlLexer.tokenize(sql).tokens;
    const sources: DirectJoinSource[] = [];
    let nesting = 0;
    let foundFrom = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.image === "(") {
        nesting += 1;
        continue;
      }
      if (token.image === ")") {
        nesting = Math.max(0, nesting - 1);
        continue;
      }
      if (nesting !== 0) continue;
      // Comma joins and mixed comma/JOIN source lists are easy to mis-pair;
      // leave the normal column completions available without guessing here.
      if (foundFrom && token.image === ",") return [];

      const isFrom = token.tokenType.name === "From" && !foundFrom;
      const isJoin = token.tokenType.name === "Join";
      if (!isFrom && !isJoin) continue;
      if (isFrom) foundFrom = true;

      const parsed = parseQualifiedTableNameFromTokens(tokens, index + 1, databaseKind);
      if (!parsed) continue;
      const alias = this.parseAliasAfterTableRef(tokens, parsed.nextIndex);
      const qualifier = alias.alias || parsed.tableRef.table;
      sources.push({
        kind: isJoin ? "join" : "from",
        qualifier,
        qualifierQuoted: alias.alias ? alias.aliasQuoted : parsed.tableRef.tableQuoted,
        db: parsed.tableRef.database,
        schema: parsed.tableRef.schema,
        table: parsed.tableRef.table,
      });
      index = Math.max(index, alias.nextIndex - 1);
    }
    return sources;
  }

  private async collectScopedColumns(
    scopeSources: ScopeSource[],
    localDefs: LocalDefinition[],
    documentUri: string,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
    netezzaSchemasEnabled?: boolean,
  ): Promise<ScopedColumnCandidate[]> {
    const columnsByName = new Map<
      string,
      { column: string; qualifiers: Set<string>; description?: string }
    >();

    for (const source of scopeSources) {
      let sourceColumns: { name: string; description?: string }[];
      const localDefinition = findLocalDefinition(localDefs, source.table);
      if (localDefinition && localDefinition.columns.length > 0) {
        sourceColumns = localDefinition.columns.map((c) => ({ name: c }));
      } else {
        const metadataColumns = await this.metadataResolver.getMetadataColumnsForSource(
          documentUri,
          source,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          this.buildMetadataColumnOptions(netezzaSchemasEnabled),
        );
        sourceColumns = metadataColumns
          .filter((column) => !!column.name)
          .map((column) => ({ name: column.name, description: column.description }));
      }

      for (const col of sourceColumns) {
        const cleanColumn = stripQuotes(col.name.trim());
        if (!cleanColumn || cleanColumn === "*" || cleanColumn.endsWith(".*")) {
          continue;
        }

        const key = cleanColumn.toUpperCase();
        const existing = columnsByName.get(key);
        if (!existing) {
          columnsByName.set(key, {
            column: cleanColumn,
            qualifiers: new Set([source.qualifier]),
            description: col.description,
          });
          continue;
        }
        existing.qualifiers.add(source.qualifier);
      }
    }

    return Array.from(columnsByName.values())
      .map((entry) => ({
        column: entry.column,
        qualifiers: Array.from(entry.qualifiers),
        description: entry.description,
      }))
      .sort((a, b) => a.column.localeCompare(b.column));
  }

  private buildMetadataColumnOptions(
    netezzaSchemasEnabled?: boolean,
  ): { netezzaSchemasEnabled?: boolean } {
    return { netezzaSchemasEnabled };
  }

}
