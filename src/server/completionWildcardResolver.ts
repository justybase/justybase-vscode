import type { CstNode, IToken } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import { simpleHash } from "../providers/parsers/hashUtils";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { parseSemanticScopeWithParser } from "../providers/parsers/parserSqlContext";
import { toDocumentParseRequestFromParts } from "./documentParseRequest";
import type { AliasInfo } from "../providers/types";
import { resolveSqlParsingRuntime } from "../sqlParser/parsingRuntime";
import {
  consumeBalancedParentheses,
  extractQualifierPathBeforeMultiply,
  findFirstNodeByName,
  getAliasTokenFromAliasOptional,
  getChildNodes,
  getNodeTextRange,
  getOrderedTokens,
  getTokens,
  isCstNode,
  isIdentifierToken,
  parseSqlToCst,
} from "./completionCstUtils";
import {
  parseQualifiedTableName,
  parseQualifiedTableNameFromTokens,
  stripQuotes,
} from "./completionDialectAdapter";
import {
  dedupeWildcardSources,
  parseQualifierPathToSource,
  type WildcardTableSource,
} from "./completionQualifierUtils";
import type {
  TableSourceBinding,
} from "./completionTypes";

/**
 * Resolves wildcard-derived columns and source bindings from CST fragments.
 */
export class CompletionWildcardResolver {
  private readonly wildcardSourceCache = new Map<string, WildcardTableSource[]>();
  private readonly MAX_WILDCARD_CACHE_SIZE = 200;

  constructor(private readonly parseSession?: DocumentParseSession) {}

  public definitionHasExplicitColumnList(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): boolean {
    const fromDocument = this.lookupDefinitionInDocument(
      fullSql,
      definitionName,
      databaseKind,
      documentUri,
      documentVersion,
    );
    if (fromDocument) {
      return fromDocument.hasExplicitColumnList;
    }

    return (
      this.lookupDefinitionMetadataFromTokens(
        fullSql,
        definitionName,
        databaseKind,
      )?.hasExplicitColumnList ?? false
    );
  }

  public findDefinitionScopeOffset(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): number | undefined {
    const fromDocument = this.lookupDefinitionInDocument(
      fullSql,
      definitionName,
      databaseKind,
      documentUri,
      documentVersion,
    );
    if (fromDocument) {
      return fromDocument.scopeOffset;
    }

    return this.lookupDefinitionMetadataFromTokens(
      fullSql,
      definitionName,
      databaseKind,
    )?.scopeOffset;
  }

  public extractWildcardTableSources(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): WildcardTableSource[] {
    const cacheKey = simpleHash(
      `${fullSql}|${definitionName.toUpperCase()}|${documentUri ?? ""}|${documentVersion ?? ""}`,
    );
    const cached = this.wildcardSourceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const collected = this.collectWildcardSourcesForDefinition(
      fullSql,
      definitionName,
      databaseKind,
      documentUri,
      documentVersion,
    );
    if (this.wildcardSourceCache.size >= this.MAX_WILDCARD_CACHE_SIZE) {
      const firstKey = this.wildcardSourceCache.keys().next().value;
      if (firstKey !== undefined) {
        this.wildcardSourceCache.delete(firstKey);
      }
    }
    this.wildcardSourceCache.set(cacheKey, collected);
    return collected;
  }

  private collectWildcardSourcesForDefinition(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): WildcardTableSource[] {
    const definitionQueryNode = this.findDefinitionQueryNode(
      fullSql,
      definitionName,
      databaseKind,
      documentUri,
      documentVersion,
    );
    if (definitionQueryNode) {
      return this.collectWildcardSourcesFromQueryNode(
        definitionQueryNode,
        fullSql,
        new Set<string>(),
        databaseKind,
        documentUri,
        documentVersion,
      );
    }

    const definitionQuerySql = this.extractDefinitionQuerySqlFromTokens(
      fullSql,
      definitionName,
      databaseKind,
    );
    if (!definitionQuerySql) {
      return [];
    }

    const queryCst = parseSqlToCst(definitionQuerySql, databaseKind);
    if (!queryCst) {
      return [];
    }

    const rootQueryNode =
      findFirstNodeByName(queryCst, "withAnyStatement") ??
      findFirstNodeByName(queryCst, "withStatement") ??
      findFirstNodeByName(queryCst, "insertWithClause") ??
      findFirstNodeByName(queryCst, "selectStatement");
    if (!rootQueryNode) {
      return [];
    }
    return this.collectWildcardSourcesFromQueryNode(
      rootQueryNode,
      definitionQuerySql,
      new Set<string>(),
      databaseKind,
      documentUri,
      documentVersion,
    );
  }

  private collectWildcardSourcesFromQueryNode(
    queryNode: CstNode,
    fullSql: string,
    seenQueries: Set<string>,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): WildcardTableSource[] {
    const queryRange = getNodeTextRange(queryNode);
    if (!queryRange) {
      return [];
    }

    const queryKey = `${queryRange.start}:${queryRange.end}`;
    if (seenQueries.has(queryKey)) {
      return [];
    }

    const nextSeen = new Set(seenQueries);
    nextSeen.add(queryKey);

    const selectStatements = this.collectProjectionSelectStatements(queryNode);
    const sources: WildcardTableSource[] = [];
    for (const selectNode of selectStatements) {
      sources.push(
        ...this.collectWildcardSourcesFromSelectNode(
          selectNode,
          fullSql,
          nextSeen,
          databaseKind,
          documentUri,
          documentVersion,
        ),
      );
    }
    return dedupeWildcardSources(sources);
  }

  private collectWildcardSourcesFromSelectNode(
    selectNode: CstNode,
    fullSql: string,
    seenQueries: Set<string>,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): WildcardTableSource[] {
    const qualifiers = this.extractWildcardQualifiersFromSelectNode(selectNode);
    if (qualifiers.length === 0) {
      return [];
    }

    const sourceBindings = this.collectSelectSourceBindings(
      selectNode,
      databaseKind,
    );
    const selectRange = getNodeTextRange(selectNode);
    const aliasBindings = selectRange
      ? this.resolveAliasBindingsFully(
          this.getAliasBindings(
            fullSql.substring(selectRange.start, selectRange.end),
            databaseKind,
            documentUri,
            documentVersion,
          ),
        )
      : new Map<string, AliasInfo>();

    const sources: WildcardTableSource[] = [];

    for (const qualifier of qualifiers) {
      if (qualifier === "*") {
        sourceBindings.forEach((binding) => {
          sources.push(
            ...this.expandBindingToWildcardSources(
              binding,
              fullSql,
              seenQueries,
              databaseKind,
              documentUri,
              documentVersion,
            ),
          );
        });
        if (sourceBindings.size === 0) {
          aliasBindings.forEach((binding) => {
            sources.push({
              db: binding.db,
              schema: binding.schema,
              table: binding.table,
            });
          });
        }
        continue;
      }

      const qualifierPathSource = parseQualifierPathToSource(
        qualifier,
        databaseKind,
      );
      if (qualifier.includes(".") && qualifierPathSource) {
        sources.push(qualifierPathSource);
        continue;
      }

      const sourceBinding = sourceBindings.get(qualifier.toUpperCase());
      if (sourceBinding) {
        sources.push(
          ...this.expandBindingToWildcardSources(
            sourceBinding,
            fullSql,
            seenQueries,
            databaseKind,
            documentUri,
            documentVersion,
          ),
        );
        continue;
      }

      const aliasBinding = aliasBindings.get(qualifier.toUpperCase());
      if (aliasBinding) {
        sources.push({
          db: aliasBinding.db,
          schema: aliasBinding.schema,
          table: aliasBinding.table,
        });
      } else if (qualifierPathSource) {
        sources.push(qualifierPathSource);
      }
    }

    return dedupeWildcardSources(sources);
  }

  private collectSelectSourceBindings(
    selectNode: CstNode,
    databaseKind?: DatabaseKind,
  ): Map<string, TableSourceBinding> {
    const bindings = new Map<string, TableSourceBinding>();
    const fromClause = getChildNodes(selectNode, "fromClause")[0];
    if (!fromClause) {
      return bindings;
    }

    const register = (
      entry: { keys: string[]; binding: TableSourceBinding } | undefined,
    ): void => {
      if (!entry) {
        return;
      }
      for (const key of entry.keys) {
        bindings.set(key.toUpperCase(), entry.binding);
      }
    };

    const tableReferences = getChildNodes(fromClause, "tableReference");
    for (const tableReference of tableReferences) {
      const primarySource = getChildNodes(tableReference, "tableSource")[0];
      register(this.resolveTableSourceBinding(primarySource, databaseKind));

      const joinClauses = getChildNodes(tableReference, "joinClause");
      for (const joinClause of joinClauses) {
        const joinSource = getChildNodes(joinClause, "tableSource")[0];
        register(this.resolveTableSourceBinding(joinSource, databaseKind));
      }
    }

    return bindings;
  }

  private resolveTableSourceBinding(
    tableSourceNode: CstNode | undefined,
    databaseKind?: DatabaseKind,
  ): { keys: string[]; binding: TableSourceBinding } | undefined {
    if (!tableSourceNode) {
      return undefined;
    }

    const aliasToken = getAliasTokenFromAliasOptional(
      getChildNodes(tableSourceNode, "aliasOptional")[0],
    );
    const tableNameNode = getChildNodes(tableSourceNode, "tableName")[0];
    if (tableNameNode) {
      const qualifiedNameNode = getChildNodes(tableNameNode, "qualifiedName")[0];
      const tableRef = parseQualifiedTableName(qualifiedNameNode, databaseKind);
      if (!tableRef) {
        return undefined;
      }

      const keys = new Set<string>([tableRef.table]);
      if (aliasToken) {
        keys.add(stripQuotes(aliasToken.image));
      }
      return {
        keys: Array.from(keys),
        binding: { tableRef },
      };
    }

    const subqueryNode = getChildNodes(tableSourceNode, "subquery")[0];
    if (!subqueryNode || !aliasToken) {
      return undefined;
    }

    const nestedQuery =
      getChildNodes(subqueryNode, "withStatement")[0] ??
      getChildNodes(subqueryNode, "selectStatement")[0];
    if (!nestedQuery) {
      return undefined;
    }

    return {
      keys: [stripQuotes(aliasToken.image)],
      binding: { subquery: nestedQuery },
    };
  }

  private expandBindingToWildcardSources(
    binding: TableSourceBinding,
    fullSql: string,
    seenQueries: Set<string>,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): WildcardTableSource[] {
    if (binding.tableRef) {
      return [
        {
          db: binding.tableRef.database,
          schema: binding.tableRef.schema,
          table: binding.tableRef.table,
        },
      ];
    }
    if (binding.subquery) {
      return this.collectWildcardSourcesFromQueryNode(
        binding.subquery,
        fullSql,
        seenQueries,
        databaseKind,
        documentUri,
        documentVersion,
      );
    }
    return [];
  }

  private extractWildcardQualifiersFromSelectNode(selectNode: CstNode): string[] {
    const selectClause = getChildNodes(selectNode, "selectClause")[0];
    if (!selectClause) {
      return [];
    }

    const selectList = getChildNodes(selectClause, "selectList")[0];
    if (!selectList) {
      return [];
    }

    const qualifiers: string[] = [];
    const selectItems = getChildNodes(selectList, "selectItem");
    for (const selectItem of selectItems) {
      qualifiers.push(...this.extractWildcardQualifiersFromSelectItem(selectItem));
    }
    return qualifiers;
  }

  private extractWildcardQualifiersFromSelectItem(
    selectItemNode: CstNode,
  ): string[] {
    const starExpression = getChildNodes(selectItemNode, "starExpression")[0];
    if (starExpression) {
      const qualifier = this.extractQualifierFromStarExpressionNode(starExpression);
      return qualifier ? [qualifier] : [];
    }

    const expressionNode = getChildNodes(selectItemNode, "expression")[0];
    if (!expressionNode) {
      return [];
    }

    const expressionTokens = getOrderedTokens(expressionNode);
    if (expressionTokens.length === 0) {
      return [];
    }

    let depth = 0;
    for (let index = 0; index < expressionTokens.length; index++) {
      const tokenName = expressionTokens[index].tokenType.name;
      if (tokenName === "LParen") {
        depth += 1;
        continue;
      }
      if (tokenName === "RParen") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (tokenName !== "Multiply" || depth !== 0) {
        continue;
      }

      const qualifier = extractQualifierPathBeforeMultiply(
        expressionTokens,
        index,
      );
      if (qualifier) {
        return [qualifier.qualifier];
      }
    }

    return [];
  }

  private extractQualifierFromStarExpressionNode(
    starExpressionNode: CstNode,
  ): string | undefined {
    const tokens = getOrderedTokens(starExpressionNode);
    const multiplyIndex = tokens.findIndex(
      (token) => token.tokenType.name === "Multiply",
    );
    if (multiplyIndex < 0) {
      return undefined;
    }

    const dottedQualifier = extractQualifierPathBeforeMultiply(tokens, multiplyIndex);
    return dottedQualifier ? dottedQualifier.qualifier : "*";
  }

  private collectProjectionSelectStatements(queryNode: CstNode): CstNode[] {
    if (
      queryNode.name === "withStatement" ||
      queryNode.name === "withAnyStatement" ||
      queryNode.name === "insertWithClause"
    ) {
      const mainSelect = getChildNodes(queryNode, "selectStatement")[0];
      return mainSelect
        ? this.collectProjectionSelectStatements(mainSelect)
        : [];
    }

    if (queryNode.name === "subquery") {
      const nestedQuery =
        getChildNodes(queryNode, "withStatement")[0] ??
        getChildNodes(queryNode, "selectStatement")[0];
      return nestedQuery
        ? this.collectProjectionSelectStatements(nestedQuery)
        : [];
    }

    if (queryNode.name !== "selectStatement") {
      const nestedSelect = findFirstNodeByName(queryNode, "selectStatement");
      return nestedSelect
        ? this.collectProjectionSelectStatements(nestedSelect)
        : [];
    }

    const result: CstNode[] = [queryNode];
    const chainedSelects = getChildNodes(queryNode, "selectStatement");
    for (const chainedSelect of chainedSelects) {
      result.push(...this.collectProjectionSelectStatements(chainedSelect));
    }
    return result;
  }

  private lookupDefinitionInDocument(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ):
    | {
        queryNode: CstNode;
        hasExplicitColumnList: boolean;
        scopeOffset: number;
      }
    | undefined {
    const cst = this.resolveDocumentCst(
      fullSql,
      databaseKind,
      documentUri,
      documentVersion,
    );
    if (!cst) {
      return undefined;
    }

    const targetName = definitionName.toUpperCase();
    const queue: CstNode[] = [cst];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      if (current.name === "cteDefinition") {
        const cteNameToken = getTokens(current, "Identifier")[0];
        if (
          cteNameToken &&
          stripQuotes(cteNameToken.image).toUpperCase() === targetName
        ) {
          const queryNode =
            getChildNodes(current, "withStatement")[0] ??
            getChildNodes(current, "selectStatement")[0];
          if (!queryNode) {
            return undefined;
          }
          const queryRange = getNodeTextRange(queryNode);
          const cteNameOffset =
            cteNameToken.startOffset ?? queryRange?.start ?? 0;
          return {
            queryNode,
            hasExplicitColumnList: getChildNodes(current, "cteColumnList").length > 0,
            scopeOffset: queryRange?.start ?? cteNameOffset,
          };
        }
      }

      if (current.name === "createTableStatement") {
        const qualifiedNameNode = getChildNodes(current, "qualifiedName")[0];
        const tableRef = parseQualifiedTableName(qualifiedNameNode, databaseKind);
        if (tableRef && tableRef.table.toUpperCase() === targetName) {
          const queryNode =
            getChildNodes(current, "withStatement")[0] ??
            getChildNodes(current, "selectStatement")[0];
          if (!queryNode) {
            return undefined;
          }
          const queryRange = getNodeTextRange(queryNode);
          const identifiers = getTokens(qualifiedNameNode, "Identifier");
          const tableNameToken = identifiers[identifiers.length - 1];
          const tableNameOffset =
            tableNameToken?.startOffset ?? queryRange?.start ?? 0;
          return {
            queryNode,
            hasExplicitColumnList:
              getChildNodes(current, "columnDefinitionList").length > 0,
            scopeOffset: queryRange?.start ?? tableNameOffset,
          };
        }
      }

      const children = current.children ?? {};
      for (const value of Object.values(children)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const child of value) {
          if (isCstNode(child)) {
            queue.push(child);
          }
        }
      }
    }

    return undefined;
  }

  private findDefinitionQueryNode(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): CstNode | undefined {
    return this.lookupDefinitionInDocument(
      fullSql,
      definitionName,
      databaseKind,
      documentUri,
      documentVersion,
    )?.queryNode;
  }

  private resolveDocumentCst(
    fullSql: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): CstNode | undefined {
    if (
      this.parseSession
      && documentUri !== undefined
      && documentVersion !== undefined
    ) {
      try {
        const parseResult = this.parseSession.getParseResult({
          documentUri,
          documentVersion,
          sql: fullSql,
          databaseKind,
        });
        if (
          parseResult.lexResult.errors.length === 0
          && parseResult.cst
          && parseResult.actionableParserErrors.length === 0
        ) {
          return parseResult.cst;
        }
      } catch {
        // Fall through to direct parse.
      }
    }

    return parseSqlToCst(fullSql, databaseKind);
  }

  private extractDefinitionQuerySqlFromTokens(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
  ): string | undefined {
    const lexResult = resolveSqlParsingRuntime({
      databaseKind,
    }).SqlLexer.tokenize(fullSql);
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
      return undefined;
    }

    return (
      this.extractCteDefinitionQuerySqlFromTokens(
        lexResult.tokens,
        fullSql,
        definitionName,
      ) ??
      this.extractCreateTableDefinitionQuerySqlFromTokens(
        lexResult.tokens,
        fullSql,
        definitionName,
      )
    );
  }

  private lookupDefinitionMetadataFromTokens(
    fullSql: string,
    definitionName: string,
    databaseKind?: DatabaseKind,
  ):
    | {
        hasExplicitColumnList: boolean;
        scopeOffset: number;
      }
    | undefined {
    const lexResult = resolveSqlParsingRuntime({
      databaseKind,
    }).SqlLexer.tokenize(fullSql);
    if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
      return undefined;
    }

    return (
      this.lookupCteDefinitionMetadataFromTokens(
        lexResult.tokens,
        fullSql,
        definitionName,
      ) ??
      this.lookupCreateTableDefinitionMetadataFromTokens(
        lexResult.tokens,
        fullSql,
        definitionName,
      )
    );
  }

  private lookupCteDefinitionMetadataFromTokens(
    tokens: IToken[],
    _fullSql: string,
    definitionName: string,
  ):
    | {
        hasExplicitColumnList: boolean;
        scopeOffset: number;
        queryEndOffset: number;
      }
    | undefined {
    const targetName = definitionName.toUpperCase();

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!isIdentifierToken(token)) {
        continue;
      }
      if (stripQuotes(token.image).toUpperCase() !== targetName) {
        continue;
      }

      let scanIndex = index + 1;
      let hasExplicitColumnList = false;
      if (tokens[scanIndex]?.tokenType.name === "LParen") {
        const columnListEnd = consumeBalancedParentheses(tokens, scanIndex);
        if (!columnListEnd) {
          continue;
        }
        hasExplicitColumnList = true;
        scanIndex = columnListEnd;
      }

      while (
        scanIndex < tokens.length &&
        tokens[scanIndex].tokenType.name !== "As"
      ) {
        if (tokens[scanIndex].tokenType.name === "Semicolon") {
          break;
        }
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "As") {
        continue;
      }

      scanIndex += 1;
      if (tokens[scanIndex]?.tokenType.name === "All") {
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "LParen") {
        continue;
      }

      const queryEnd = consumeBalancedParentheses(tokens, scanIndex);
      if (!queryEnd) {
        continue;
      }

      const openParenToken = tokens[scanIndex];
      const closeParenToken = tokens[queryEnd - 1];
      const scopeOffset =
        (openParenToken.endOffset ?? openParenToken.startOffset ?? 0) + 1;
      const queryEndOffset = closeParenToken.startOffset ?? scopeOffset;
      if (queryEndOffset <= scopeOffset) {
        continue;
      }

      return {
        hasExplicitColumnList,
        scopeOffset,
        queryEndOffset,
      };
    }

    return undefined;
  }

  private lookupCreateTableDefinitionMetadataFromTokens(
    tokens: IToken[],
    _fullSql: string,
    definitionName: string,
  ):
    | {
        hasExplicitColumnList: boolean;
        scopeOffset: number;
      }
    | undefined {
    const targetName = definitionName.toUpperCase();

    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].tokenType.name !== "Create") {
        continue;
      }

      let scanIndex = index + 1;
      if (
        tokens[scanIndex]?.tokenType.name === "Or" &&
        tokens[scanIndex + 1]?.tokenType.name === "Replace"
      ) {
        scanIndex += 2;
      }
      if (
        tokens[scanIndex]?.tokenType.name === "Temp" ||
        tokens[scanIndex]?.tokenType.name === "Temporary"
      ) {
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "Table") {
        continue;
      }

      const tableRef = parseQualifiedTableNameFromTokens(tokens, scanIndex + 1);
      if (!tableRef) {
        continue;
      }
      if (tableRef.tableRef.table.toUpperCase() !== targetName) {
        continue;
      }

      scanIndex = tableRef.nextIndex;
      let hasExplicitColumnList = false;
      if (tokens[scanIndex]?.tokenType.name === "LParen") {
        const columnListEnd = consumeBalancedParentheses(tokens, scanIndex);
        if (!columnListEnd) {
          continue;
        }
        hasExplicitColumnList = true;
        scanIndex = columnListEnd;
      }

      while (
        scanIndex < tokens.length &&
        tokens[scanIndex].tokenType.name !== "As"
      ) {
        if (tokens[scanIndex].tokenType.name === "Semicolon") {
          break;
        }
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "As") {
        continue;
      }

      const queryStart = scanIndex + 1;
      if (tokens[queryStart]?.tokenType.name === "LParen") {
        const queryEnd = consumeBalancedParentheses(tokens, queryStart);
        if (!queryEnd) {
          continue;
        }
        const openParenToken = tokens[queryStart];
        const scopeOffset =
          (openParenToken.endOffset ?? openParenToken.startOffset ?? 0) + 1;
        return {
          hasExplicitColumnList,
          scopeOffset,
        };
      }

      const queryStartOffset = tokens[queryStart]?.startOffset;
      if (queryStartOffset === undefined) {
        continue;
      }

      return {
        hasExplicitColumnList,
        scopeOffset: queryStartOffset,
      };
    }

    return undefined;
  }

  private extractCteDefinitionQuerySqlFromTokens(
    tokens: IToken[],
    fullSql: string,
    definitionName: string,
  ): string | undefined {
    const metadata = this.lookupCteDefinitionMetadataFromTokens(
      tokens,
      fullSql,
      definitionName,
    );
    if (!metadata) {
      return undefined;
    }

    return fullSql.substring(metadata.scopeOffset, metadata.queryEndOffset);
  }

  private extractCreateTableDefinitionQuerySqlFromTokens(
    tokens: IToken[],
    fullSql: string,
    definitionName: string,
  ): string | undefined {
    const targetName = definitionName.toUpperCase();

    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].tokenType.name !== "Create") {
        continue;
      }

      let scanIndex = index + 1;
      if (
        tokens[scanIndex]?.tokenType.name === "Or" &&
        tokens[scanIndex + 1]?.tokenType.name === "Replace"
      ) {
        scanIndex += 2;
      }
      if (
        tokens[scanIndex]?.tokenType.name === "Temp" ||
        tokens[scanIndex]?.tokenType.name === "Temporary"
      ) {
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "Table") {
        continue;
      }

      const tableRef = parseQualifiedTableNameFromTokens(tokens, scanIndex + 1);
      if (!tableRef) {
        continue;
      }
      if (tableRef.tableRef.table.toUpperCase() !== targetName) {
        continue;
      }

      scanIndex = tableRef.nextIndex;
      if (tokens[scanIndex]?.tokenType.name === "LParen") {
        const columnListEnd = consumeBalancedParentheses(tokens, scanIndex);
        if (!columnListEnd) {
          continue;
        }
        scanIndex = columnListEnd;
      }

      while (
        scanIndex < tokens.length &&
        tokens[scanIndex].tokenType.name !== "As"
      ) {
        if (tokens[scanIndex].tokenType.name === "Semicolon") {
          break;
        }
        scanIndex += 1;
      }
      if (tokens[scanIndex]?.tokenType.name !== "As") {
        continue;
      }

      const queryStart = scanIndex + 1;
      if (tokens[queryStart]?.tokenType.name === "LParen") {
        const queryEnd = consumeBalancedParentheses(tokens, queryStart);
        if (!queryEnd) {
          continue;
        }
        const openParenToken = tokens[queryStart];
        const closeParenToken = tokens[queryEnd - 1];
        const startOffset =
          (openParenToken.endOffset ?? openParenToken.startOffset ?? 0) + 1;
        const endOffset = closeParenToken.startOffset ?? startOffset;
        if (endOffset <= startOffset) {
          continue;
        }
        return fullSql.substring(startOffset, endOffset);
      }

      const queryStartOffset = tokens[queryStart]?.startOffset;
      if (queryStartOffset === undefined) {
        continue;
      }

      let queryEndOffset = fullSql.length;
      for (let endIndex = queryStart; endIndex < tokens.length; endIndex++) {
        if (tokens[endIndex].tokenType.name === "Semicolon") {
          queryEndOffset = tokens[endIndex].startOffset ?? queryEndOffset;
          break;
        }
      }

      if (queryEndOffset <= queryStartOffset) {
        continue;
      }
      return fullSql.substring(queryStartOffset, queryEndOffset);
    }

    return undefined;
  }

  private getAliasBindings(
    statementSql: string,
    databaseKind?: DatabaseKind,
    documentUri?: string,
    documentVersion?: number,
  ): Map<string, AliasInfo> {
    try {
      if (
        this.parseSession &&
        documentUri !== undefined &&
        documentVersion !== undefined
      ) {
        return this.parseSession.getSemanticScope(
          toDocumentParseRequestFromParts(
            documentUri,
            documentVersion,
            statementSql,
            databaseKind,
          ),
        ).preferredAliasBindings;
      }
      return parseSemanticScopeWithParser(
        statementSql,
        undefined,
        databaseKind,
      ).preferredAliasBindings;
    } catch {
      return new Map<string, AliasInfo>();
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
}