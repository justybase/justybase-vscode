import {
  CompletionItem,
  Position,
} from "vscode-languageserver/node";
import { SqlLexer } from "../sqlParser";
import type { DatabaseKind } from "../contracts/database";
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
  isExpressionClauseContext,
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
  toScopedColumnItems,
} from "./completionRenderer";
import { parseQualifierPathToSource } from "./completionQualifierUtils";
import { CompletionContextExtractor } from "./completionContextExtractor";
import { CompletionMetadataResolver } from "./completionMetadataResolver";
import { handleVariableCompletion } from "./completionVariableResolver";
import type {
  ScopeSource,
  ScopedColumnCandidate,
  StatementBoundary,
} from "./completionTypes";

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
  localDefs: LocalDefinition[];
  documentUri: string;
  documentVersion: number;
  effectiveDb?: string;
  effectiveSchema?: string;
  netezzaSchemasEnabled?: boolean;
  databaseKind?: DatabaseKind;
  completionKeywords: readonly string[];
  sqlFunctionNames: readonly string[];
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
        this.extractAdditionalAliasBindings(preparedStatement.sql, undefined),
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
      localDefs,
      documentUri,
      documentVersion,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      netezzaSchemasEnabled,
      completionKeywords,
      sqlFunctionNames,
      specialBuiltinValues,
    } = request;

    if (!isExpressionClauseContext(statementPrefix)) {
      return undefined;
    }

    const typedPrefix = this.contextExtractor.extractCurrentIdentifierPrefix(
      linePrefix,
    );
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
    const functionItems = buildExpressionFunctionItems(
      statementPrefix,
      typedPrefix,
      position,
      sqlFunctionNames,
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
    );
    const items = dedupeCompletionItems([
      ...columnItems,
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
  ): Map<string, AliasInfo> {
    return this.parseMergeAliasBindings(statementSql, cursorOffset);
  }

  private parseMergeAliasBindings(
    statementSql: string,
    cursorOffset?: number,
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

      const targetRef = parseQualifiedTableNameFromTokens(tokens, scanIndex);
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

      const sourceRef = parseQualifiedTableNameFromTokens(tokens, usingIndex + 1);
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
  ): { alias?: string; nextIndex: number } {
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