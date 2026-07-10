import { CstNode, type IToken } from "chevrotain";
import type { DatabaseKind } from "../../../contracts/database";
import { resolveSqlParsingRuntime } from "../../../sqlParser/parsingRuntime";
import { formatQualifiedObjectName } from "../../../utils/identifierUtils";
import type { AliasInfo, LocalDefinition } from "../../types";
import { getOrderedReferenceTokens } from "./referenceTokenCollector";
import {
  findFirstNodeByName,
  getChildNodesByKey,
  getFirstTokenFromCstNode,
  getIdentifierTokenByKey,
  getNodeRange,
  getTokensByKey,
  isCstNode,
  normalizeTokenText,
  type NodeRangeCache,
} from "./cstNodeUtils";

interface QualifiedTableName {
  database?: string;
  schema?: string;
  table: string;
}

interface AliasScope {
  start: number;
  end: number;
  bindings: Map<string, AliasInfo>;
}

const PARSER_COLLECTOR_CACHE = new WeakMap<CstNode, ParserSqlContextCollector>();

export class ParserSqlContextCollector {

  private readonly _databaseKind?: DatabaseKind;
  private readonly _localDefinitions = new Map<string, LocalDefinition>();
  private readonly _scopes: AliasScope[] = [];
  private readonly _activeScopes: AliasScope[] = [];
  private _currentScopeBindings: Map<string, AliasInfo> | null = null;
  private readonly _rangeCache: NodeRangeCache = new WeakMap();

  public constructor(databaseKind?: DatabaseKind) {
    this._databaseKind = databaseKind;
  }

  public collect(root: CstNode): void {
    this.visitNode(root);
  }

  public getLocalDefinitions(): LocalDefinition[] {
    return Array.from(this._localDefinitions.values());
  }

  public getAliasBindings(cursorOffset?: number): Map<string, AliasInfo> {
    if (cursorOffset === undefined) {
      // Fallback for global context (merge all, though technically incorrect for leakage)
      const allBindings = new Map<string, AliasInfo>();
      for (const scope of this._scopes) {
        scope.bindings.forEach((val, key) => allBindings.set(key, val));
      }
      return allBindings;
    }

    // Find the most specific scope containing the cursor offset
    let bestScope: AliasScope | null = null;
    for (const scope of this._scopes) {
      if (cursorOffset >= scope.start && cursorOffset <= scope.end) {
        if (
          !bestScope ||
          scope.end - scope.start < bestScope.end - bestScope.start
        ) {
          bestScope = scope;
        }
      }
    }

    // Merge bindings from all scopes containing the cursor (parent scope inheritance)
    const mergedBindings = new Map<string, AliasInfo>();
    for (const scope of this._scopes) {
      if (cursorOffset >= scope.start && cursorOffset <= scope.end) {
        scope.bindings.forEach((val, key) => {
          if (!mergedBindings.has(key)) {
            mergedBindings.set(key, val);
          }
        });
      }
    }
    return mergedBindings;
  }

  private visitNode(node: CstNode): void {
    const isScopeNode = this.isScopeDefiningNode(node);
    let previousScopeBindings: Map<string, AliasInfo> | null = null;
    let enteredScope = false;

    if (isScopeNode) {
      const range = getNodeRange(node, this._rangeCache);
      if (range) {
        previousScopeBindings = this._currentScopeBindings;
        const scope: AliasScope = {
          start: range.start,
          end: range.end,
          bindings: new Map<string, AliasInfo>(),
        };
        this._currentScopeBindings = scope.bindings;
        this._scopes.push(scope);
        this._activeScopes.push(scope);
        enteredScope = true;
      }
    }

    switch (node.name) {
      case "cteDefinition":
        this.visitCteDefinition(node);
        break;
      case "insertCteDefinition":
        this.visitInsertCteDefinition(node);
        break;
      case "createTableStatement":
        this.visitCreateTableStatement(node);
        break;
      case "selectStatement":
      case "updateStatement":
      case "deleteStatement":
      case "insertStatement":
        this.visitChildren(node);
        break;
      case "tableSource":
        this.visitTableSource(node);
        break;
      default:
        this.visitChildren(node);
        break;
    }

    if (enteredScope) {
      this._activeScopes.pop();
      this._currentScopeBindings = previousScopeBindings;
    }
  }

  private isScopeDefiningNode(node: CstNode): boolean {
    return (
      node.name === "selectStatement" ||
      node.name === "updateStatement" ||
      node.name === "deleteStatement" ||
      node.name === "insertStatement" ||
      node.name === "cteDefinition" ||
      node.name === "insertCteDefinition" ||
      node.name === "withStatement" ||
      node.name === "withAnyStatement" ||
      node.name === "insertWithClause"
    );
  }

  private visitChildren(node: CstNode): void {
    const children = node.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) {
        continue;
      }
      value.forEach((child) => {
        if (isCstNode(child)) {
          this.visitNode(child);
        }
      });
    }
  }

  private getIdentifierToken(node: CstNode): IToken | undefined {
    return getIdentifierTokenByKey(node);
  }

  private visitCteDefinition(node: CstNode): void {
    const cteNameToken = this.getIdentifierToken(node);
    if (!cteNameToken) {
      this.visitChildren(node);
      return;
    }

    const explicitColumns = this.extractColumnsFromCteColumnList(
      getChildNodesByKey(node, "cteColumnList")[0],
    );
    const nestedQuery =
      getChildNodesByKey(node, "withStatement")[0] ??
      getChildNodesByKey(node, "selectStatement")[0] ??
      this.findNestedSelectInCte(node);

    // If the CTE is just SELECT * FROM TABLE, map the CTE name to that base table's bindings
    // so autocomplete suggests base metadata for the CTE.
    const inferredTableRef =
      this.inferSimpleStarQueryTableRefFromCst(nestedQuery);
    if (inferredTableRef && explicitColumns.length === 0) {
      const cteName = normalizeTokenText(cteNameToken).toUpperCase();
      const binding = {
        db: inferredTableRef.database,
        schema: inferredTableRef.schema,
        table: inferredTableRef.table,
      };
      // Note: CTE definition creates its own scope (isScopeDefiningNode includes 'cteDefinition')
      // The _currentScopeBindings is the CTE's internal scope
      // We need to add CTE name → base table mapping to the PARENT scope (WITH statement)
      // so it's accessible from sibling CTEs and the main query.
      // Use active scope stack (not historical scope list), otherwise sibling CTEs can bind into stale scopes.
      const parentScope =
        this._activeScopes.length >= 2
          ? this._activeScopes[this._activeScopes.length - 2]
          : this._activeScopes[0];
      if (parentScope) {
        parentScope.bindings.set(cteName, binding);
      }
    }

    const inferredColumns = this.extractColumnsFromQueryNode(nestedQuery);
    const columns =
      explicitColumns.length > 0 ? explicitColumns : inferredColumns;

    this.setLocalDefinition(
      normalizeTokenText(cteNameToken),
      "CTE",
      columns,
    );
    this.visitChildren(node);
  }

  private visitInsertCteDefinition(node: CstNode): void {
    const cteNameToken = this.getIdentifierToken(node);
    if (!cteNameToken) {
      this.visitChildren(node);
      return;
    }

    const queryNode =
      getChildNodesByKey(node, "withStatement")[0] ??
      getChildNodesByKey(node, "selectStatement")[0];
    const columns = this.extractColumnsFromQueryNode(queryNode);
    this.setLocalDefinition(
      normalizeTokenText(cteNameToken),
      "CTE",
      columns,
    );
    this.visitChildren(node);
  }

  private visitCreateTableStatement(node: CstNode): void {
    const qualifiedNameNode = getChildNodesByKey(node, "qualifiedName")[0];
    const tableRef = this.parseQualifiedTableName(qualifiedNameNode);
    if (!tableRef) {
      this.visitChildren(node);
      return;
    }

    const tableTypeClause = getChildNodesByKey(node, "tableTypeClause")[0];
    const queryNode =
      getChildNodesByKey(node, "withStatement")[0] ??
      getChildNodesByKey(node, "selectStatement")[0];
    if (!queryNode && !tableTypeClause) {
      this.visitChildren(node);
      return;
    }

    let type = "Table";
    if (tableTypeClause) {
      const isGlobal = getTokensByKey(tableTypeClause, "Global").length > 0;
      type = isGlobal ? "Global Temp Table" : "Temp Table";
    }

    const columnsFromDefinition = this.extractColumnsFromColumnDefinitionList(
      getChildNodesByKey(node, "columnDefinitionList")[0],
    );
    const columnsFromQuery = this.extractColumnsFromQueryNode(queryNode);
    const columns =
      columnsFromDefinition.length > 0
        ? columnsFromDefinition
        : columnsFromQuery;

    const displayName = this.formatQualifiedTableDisplayName(tableRef);
    this.setLocalDefinition(displayName, type, columns);
    this.visitChildren(node);
  }

  private formatQualifiedTableDisplayName(ref: QualifiedTableName): string {
    return formatQualifiedObjectName(
      ref.database,
      ref.schema,
      ref.table,
      this._databaseKind,
    );
  }

  private visitTableSource(node: CstNode): void {
    const tableNameNode = getChildNodesByKey(node, "tableName")[0];
    const tableWithFinalQualifiedNameNode = getChildNodesByKey(
      node,
      "qualifiedName",
    )[0];
    const isTableWithFinalSource = getTokensByKey(node, "Final").length > 0;
    const aliasToken = this.getAliasToken(
      getChildNodesByKey(node, "aliasOptional")[0],
    );
  
    if (tableNameNode) {
      const qualifiedNameNode = getChildNodesByKey(
        tableNameNode,
        "qualifiedName",
      )[0];
      const tableRef = this.parseQualifiedTableName(qualifiedNameNode);
      if (tableRef) {
        this.registerAliasBindingForTableRef(tableRef, aliasToken);
      }
    } else if (isTableWithFinalSource && tableWithFinalQualifiedNameNode) {
      const tableRef = this.parseQualifiedTableName(
        tableWithFinalQualifiedNameNode,
      );
      if (tableRef) {
        this.registerAliasBindingForTableRef(tableRef, aliasToken);
      }
    } else {
      const subqueryNode = getChildNodesByKey(node, "subquery")[0];
      if (subqueryNode && aliasToken) {
        const aliasName = normalizeTokenText(aliasToken);
        const subqueryColumns = this.extractColumnsFromQueryNode(subqueryNode);
        this.setLocalDefinition(aliasName, "Subquery", subqueryColumns);
  
        // For simple SELECT * FROM table subqueries, also register an alias binding
        // so that metadata lookup can find the base table columns.
        // The subquery node contains a nested selectStatement or withStatement.
        const nestedQuery =
          getChildNodesByKey(subqueryNode, "selectStatement")[0] ??
          getChildNodesByKey(subqueryNode, "withStatement")[0];
        const inferredTableRef = nestedQuery
          ? this.inferSimpleStarQueryTableRefFromCst(nestedQuery)
          : undefined;
        if (inferredTableRef && this._currentScopeBindings) {
          // Register the alias with the inferred table reference
          this._currentScopeBindings.set(aliasName.toUpperCase(), {
            db: inferredTableRef.database,
            schema: inferredTableRef.schema,
            table: inferredTableRef.table,
          });
        }
      }
    }
  
    this.visitChildren(node);
  }

  // `updateStatement` and `deleteStatement` now go through `visitChildren`
  // to pick up their nested tableSources within the scope.

  private setLocalDefinition(
    name: string,
    type: string,
    columns: string[],
  ): void {
    const key = name.toUpperCase();
    const existing = this._localDefinitions.get(key);
    const dedupedColumns = this.dedupeColumns(columns);

    if (!existing) {
      this._localDefinitions.set(key, { name, type, columns: dedupedColumns });
      return;
    }

    const mergedColumns =
      existing.columns.length > 0 ? existing.columns : dedupedColumns;
    this._localDefinitions.set(key, {
      name: existing.name,
      type: existing.type,
      columns: mergedColumns,
    });
  }

  private dedupeColumns(columns: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const column of columns) {
      const trimmed = column.trim();
      if (!trimmed) {
        continue;
      }
      const key = trimmed.toUpperCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(trimmed);
    }
    return result;
  }

  private extractColumnsFromCteColumnList(
    cteColumnListNode: CstNode | undefined,
  ): string[] {
    if (!cteColumnListNode) {
      return [];
    }

    const identifiers = getChildNodesByKey(cteColumnListNode, "identifier")
      .map((node) => getFirstTokenFromCstNode(node))
      .filter((token): token is IToken => !!token);
    return identifiers.map((token) => normalizeTokenText(token));
  }

  private extractColumnsFromColumnDefinitionList(
    columnDefinitionListNode: CstNode | undefined,
  ): string[] {
    if (!columnDefinitionListNode) {
      return [];
    }

    const result: string[] = [];
    getChildNodesByKey(columnDefinitionListNode, "columnDefinition").forEach(
      (columnDefinitionNode) => {
        const columnNameNode = getChildNodesByKey(
          columnDefinitionNode,
          "columnName",
        )[0];
        const token = getFirstTokenFromCstNode(columnNameNode);
        if (token) {
          result.push(normalizeTokenText(token));
        }
      },
    );
    return result;
  }

  private extractColumnsFromQueryNode(node: CstNode | undefined): string[] {
    if (!node) {
      return [];
    }

    if (node.name === "subquery") {
      const nestedWith =
        getChildNodesByKey(node, "withStatement")[0] ??
        getChildNodesByKey(node, "selectStatement")[0];
      return this.extractColumnsFromQueryNode(nestedWith);
    }

    if (
      node.name === "withStatement" ||
      node.name === "withAnyStatement" ||
      node.name === "insertWithClause"
    ) {
      const selectNode = getChildNodesByKey(node, "selectStatement")[0];
      return this.extractColumnsFromQueryNode(selectNode);
    }

    if (node.name !== "selectStatement") {
      const selectNode = findFirstNodeByName(node, "selectStatement");
      return selectNode ? this.extractColumnsFromQueryNode(selectNode) : [];
    }

    const selectClause = getChildNodesByKey(node, "selectClause")[0];
    if (!selectClause) {
      return [];
    }

    const selectList = getChildNodesByKey(selectClause, "selectList")[0];
    if (!selectList) {
      return [];
    }

    const columns: string[] = [];
    getChildNodesByKey(selectList, "selectItem").forEach((selectItemNode) => {
      const aliasToken = this.getAliasToken(
        getChildNodesByKey(selectItemNode, "aliasOptional")[0],
      );
      if (aliasToken) {
        columns.push(normalizeTokenText(aliasToken));
        return;
      }

      const starExpression = getChildNodesByKey(
        selectItemNode,
        "starExpression",
      )[0];
      if (starExpression) {
        return;
      }

      const expressionNode = getChildNodesByKey(
        selectItemNode,
        "expression",
      )[0];
      const expressionColumn = this.extractColumnFromExpression(expressionNode);
      if (expressionColumn) {
        columns.push(expressionColumn);
      }
    });

    return columns;
  }

  private extractColumnFromExpression(
    expressionNode: CstNode | undefined,
  ): string | undefined {
    if (!expressionNode) {
      return undefined;
    }

    const columnReferenceNode = findFirstNodeByName(
      expressionNode,
      "columnReference",
    );
    if (columnReferenceNode) {
      const sortedTokens = getOrderedReferenceTokens(columnReferenceNode);
      const lastToken = sortedTokens[sortedTokens.length - 1];
      if (lastToken) {
        return normalizeTokenText(lastToken);
      }
    }

    const fallbackToken = getFirstTokenFromCstNode(expressionNode);
    return fallbackToken ? normalizeTokenText(fallbackToken) : undefined;
  }

  private parseQualifiedTableName(
    qualifiedNameNode: CstNode | undefined,
  ): QualifiedTableName | undefined {
    if (!qualifiedNameNode) {
      return undefined;
    }

    const identifierTokens = getChildNodesByKey(qualifiedNameNode, "identifier")
      .map((node) => getFirstTokenFromCstNode(node))
      .filter((token): token is IToken => !!token);
    if (identifierTokens.length === 0) {
      return undefined;
    }

    const names = identifierTokens.map((token) =>
      normalizeTokenText(token),
    );
    const dotCount = getTokensByKey(qualifiedNameNode, "Dot").length;

    if (names.length === 1) {
      return { table: names[0] };
    }

    if (names.length === 2) {
      if (dotCount === 2) {
        return { database: names[0], table: names[1] };
      }
      return { schema: names[0], table: names[1] };
    }

    return { database: names[0], schema: names[1], table: names[2] };
  }

  private getAliasToken(
    aliasOptionalNode: CstNode | undefined,
  ): IToken | undefined {
    if (!aliasOptionalNode) {
      return undefined;
    }
    const aliasNode = getChildNodesByKey(aliasOptionalNode, "alias")[0];
    if (!aliasNode) {
      return undefined;
    }
    return getFirstTokenFromCstNode(aliasNode);
  }

  private registerAliasBindingForTableRef(
    tableRef: QualifiedTableName,
    aliasToken: IToken | undefined,
  ): void {
    if (!this._currentScopeBindings) {
      return;
    }

    if (aliasToken) {
      this._currentScopeBindings.set(
        normalizeTokenText(aliasToken).toUpperCase(),
        {
          db: tableRef.database,
          schema: tableRef.schema,
          table: tableRef.table,
        },
      );
    }
    this._currentScopeBindings.set(tableRef.table.toUpperCase(), {
      db: tableRef.database,
      schema: tableRef.schema,
      table: tableRef.table,
    });
  }

  private findNestedSelectInCte(node: CstNode): CstNode | undefined {
    // Deep search for selectStatement or withStatement within CTE
    const searchQueue: CstNode[] = [node];
    while (searchQueue.length > 0) {
      const current = searchQueue.shift()!;
      if (
        current.name === "selectStatement" ||
        current.name === "withStatement"
      ) {
        return current;
      }
      // Iterate over all children
      const children = current.children ?? {};
      for (const value of Object.values(children)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const child of value) {
          if (isCstNode(child)) {
            searchQueue.push(child);
          }
        }
      }
    }
    return undefined;
  }




  private inferSimpleStarQueryTableRefFromCst(
    queryNode: CstNode | undefined,
  ): QualifiedTableName | undefined {
    if (!queryNode || queryNode.name !== "selectStatement") {
      return undefined;
    }

    const selectClause = getChildNodesByKey(queryNode, "selectClause")[0];
    if (!selectClause) return undefined;

    const selectList = getChildNodesByKey(selectClause, "selectList")[0];
    if (!selectList) return undefined;

    const selectItems = getChildNodesByKey(selectList, "selectItem");
    // Must be exactly one item: "SELECT *" or "SELECT alias.*"
    if (selectItems.length !== 1) return undefined;

    const selectItem = selectItems[0];
    // Check for star expression (unqualified * or qualified alias.*)
    // Direct starExpression child (SELECT *)
    let starExpression: CstNode | undefined = getChildNodesByKey(
      selectItem,
      "starExpression",
    )[0];
    // Or inside expression (SELECT alias.*)
    if (!starExpression) {
      const expressionNode = getChildNodesByKey(selectItem, "expression")[0];
      if (expressionNode) {
        starExpression = findFirstNodeByName(
          expressionNode,
          "starExpression",
        );
      }
    }
    if (!starExpression) return undefined;

    // Must have exactly one table source (no JOINs)
    const fromClause = getChildNodesByKey(queryNode, "fromClause")[0];
    if (!fromClause) return undefined;

    // tableSource might be nested inside fromClause, use findFirstNodeByName
    let tableSource: CstNode | undefined = getChildNodesByKey(
      fromClause,
      "tableSource",
    )[0];
    if (!tableSource) {
      tableSource = findFirstNodeByName(fromClause, "tableSource");
    }
    if (!tableSource) return undefined;

    const tableNameNode = getChildNodesByKey(tableSource, "tableName")[0];
    if (tableNameNode) {
      const qualifiedNameNode = getChildNodesByKey(
        tableNameNode,
        "qualifiedName",
      )[0];
      return this.parseQualifiedTableName(qualifiedNameNode);
    }

    if (getTokensByKey(tableSource, "Final").length > 0) {
      const qualifiedNameNode = getChildNodesByKey(
        tableSource,
        "qualifiedName",
      )[0];
      return this.parseQualifiedTableName(qualifiedNameNode);
    }

    return undefined;
  }
}

export function getOrCreateParserSqlContextCollector(
  cst: CstNode,
  databaseKind?: DatabaseKind,
): ParserSqlContextCollector {
  let collector = PARSER_COLLECTOR_CACHE.get(cst);
  if (!collector) {
    collector = new ParserSqlContextCollector(databaseKind);
    collector.collect(cst);
    PARSER_COLLECTOR_CACHE.set(cst, collector);
  }
  return collector;
}


interface AliasBindingCandidate {
  value: AliasInfo;
  depth: number;
  order: number;
}

export function parseAliasBindingsFromTokens(
  sql: string,
  cursorOffset?: number,
  databaseKind?: DatabaseKind,
): Map<string, AliasInfo> {
  const aliasCandidates = new Map<string, AliasBindingCandidate[]>();
  const cteBindings = new Map<string, QualifiedTableName>();
  const lexResult = resolveSqlParsingRuntime({
    databaseKind,
  }).SqlLexer.tokenize(sql);
  if (lexResult.tokens.length === 0) {
    return new Map<string, AliasInfo>();
  }

  const tokens = lexResult.tokens;
  const cursorDepth =
    cursorOffset !== undefined
      ? resolveParenthesisDepthAtOffset(tokens, cursorOffset)
      : undefined;
  let depth = 0;
  let order = 0;

  const resolveRef = (ref: QualifiedTableName): QualifiedTableName => {
    if (!ref.database && !ref.schema) {
      const upper = ref.table.toUpperCase();
      if (cteBindings.has(upper)) {
        return cteBindings.get(upper)!;
      }
    }
    return ref;
  };

  for (let index = 0; index < tokens.length; index++) {
    const tokenName = tokens[index].tokenType.name;
    if (tokenName === "RParen") {
      depth = Math.max(0, depth - 1);
    }

    if (tokenName === "From" || tokenName === "Join") {
      const parsed = parseTableReferenceAndAlias(tokens, index + 1);
      if (parsed) {
        const resolvedRef = resolveRef(parsed.tableRef);
        registerAliasBinding(
          aliasCandidates,
          resolvedRef,
          parsed.alias,
          depth,
          () => order++,
        );
        index = parsed.nextIndex - 1;
      }
    } else if (tokenName === "Update") {
      const parsed = parseTableReferenceAndAlias(tokens, index + 1);
      if (parsed) {
        registerAliasBinding(
          aliasCandidates,
          resolveRef(parsed.tableRef),
          parsed.alias,
          depth,
          () => order++,
        );
        index = parsed.nextIndex - 1;
      }
    } else if (tokenName === "Delete") {
      let startIndex = index + 1;
      if (tokens[startIndex]?.tokenType.name === "From") {
        startIndex += 1;
      }
      const parsed = parseTableReferenceAndAlias(tokens, startIndex);
      if (parsed) {
        registerAliasBinding(
          aliasCandidates,
          resolveRef(parsed.tableRef),
          parsed.alias,
          depth,
          () => order++,
        );
        index = parsed.nextIndex - 1;
      }
    } else if (tokenName === "With") {
      let scanIndex = index + 1;
      if (tokens[scanIndex]?.tokenType.name === "Recursive") {
        scanIndex += 1;
      }
      while (scanIndex < tokens.length) {
        if (!isIdentifierToken(tokens[scanIndex])) {
          break;
        }
        const cteName = normalizeTokenText(tokens[scanIndex]);
        scanIndex += 1;

        if (tokens[scanIndex]?.tokenType.name === "LParen") {
          const columnList = consumeBalancedParentheses(tokens, scanIndex);
          if (!columnList) break;
          scanIndex = columnList.nextIndex;
        }

        while (
          scanIndex < tokens.length &&
          tokens[scanIndex].tokenType.name !== "As"
        ) {
          scanIndex += 1;
        }
        if (scanIndex >= tokens.length) break;
        scanIndex += 1; // consume As

        if (tokens[scanIndex]?.tokenType.name === "All") {
          scanIndex += 1;
        }

        if (tokens[scanIndex]?.tokenType.name === "LParen") {
          const cteBodyEnd = consumeBalancedParentheses(tokens, scanIndex);
          if (cteBodyEnd) {
            const inferredTableRef = inferSimpleStarSubqueryTableRef(
              tokens,
              scanIndex,
              cteBodyEnd.nextIndex,
            );
            if (inferredTableRef) {
              cteBindings.set(cteName.toUpperCase(), inferredTableRef);
              registerAliasBinding(
                aliasCandidates,
                inferredTableRef,
                cteName,
                depth,
                () => order++,
              );
            }
            scanIndex = cteBodyEnd.nextIndex;
          } else {
            break;
          }
        } else {
          break;
        }

        if (tokens[scanIndex]?.tokenType.name === "Comma") {
          scanIndex += 1;
          continue;
        }
        break;
      }
    }

    if (tokenName === "LParen") {
      depth += 1;
    }
  }

  const result = resolveAliasBindingCandidates(aliasCandidates, cursorDepth);
  return result;
}

function resolveParenthesisDepthAtOffset(
  tokens: IToken[],
  cursorOffset: number,
): number {
  let depth = 0;
  const boundedOffset = Math.max(0, cursorOffset);
  for (const token of tokens) {
    const tokenStart = token.startOffset ?? 0;
    if (tokenStart >= boundedOffset) {
      break;
    }

    const tokenName = token.tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
    } else if (tokenName === "RParen") {
      depth = Math.max(0, depth - 1);
    }
  }
  return depth;
}

function resolveAliasBindingCandidates(
  aliasCandidates: Map<string, AliasBindingCandidate[]>,
  cursorDepth?: number,
): Map<string, AliasInfo> {
  const resolved = new Map<string, AliasInfo>();

  aliasCandidates.forEach((candidates, key) => {
    const filtered =
      cursorDepth !== undefined
        ? candidates.filter((candidate) => candidate.depth <= cursorDepth)
        : candidates;
    if (filtered.length === 0) {
      return;
    }

    const best = filtered.reduce((current, candidate) => {
      if (candidate.depth > current.depth) {
        return candidate;
      }
      if (
        candidate.depth === current.depth &&
        candidate.order > current.order
      ) {
        return candidate;
      }
      return current;
    }, filtered[0]);

    resolved.set(key, best.value);
  });

  return resolved;
}


export function consumeBalancedParentheses(
  tokens: IToken[],
  startIndex: number,
): { nextIndex: number } | undefined {
  if (tokens[startIndex]?.tokenType.name !== "LParen") {
    return undefined;
  }

  let depth = 1;
  let index = startIndex + 1;
  while (index < tokens.length && depth > 0) {
    const tokenName = tokens[index].tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
    } else if (tokenName === "RParen") {
      depth -= 1;
    }
    index += 1;
  }

  if (depth > 0) {
    return undefined;
  }
  return { nextIndex: index };
}

function parseTableReferenceAndAlias(
  tokens: IToken[],
  startIndex: number,
):
  | { tableRef: QualifiedTableName; alias?: string; nextIndex: number }
  | undefined {
  if (startIndex >= tokens.length) {
    return undefined;
  }

  if (tokens[startIndex].tokenType.name === "LParen") {
    const subqueryEnd = consumeBalancedParentheses(tokens, startIndex);
    if (!subqueryEnd) {
      return undefined;
    }

    let nextIndex = subqueryEnd.nextIndex;
    if (tokens[nextIndex]?.tokenType.name === "As") {
      nextIndex += 1;
    }

    if (
      !isIdentifierToken(tokens[nextIndex]) ||
      isAliasBoundaryToken(tokens[nextIndex])
    ) {
      return undefined;
    }

    const alias = normalizeTokenText(tokens[nextIndex]);
    nextIndex += 1;
    const inferredTableRef = inferSimpleStarSubqueryTableRef(
      tokens,
      startIndex,
      subqueryEnd.nextIndex,
    );

    return {
      tableRef: inferredTableRef ?? { table: alias },
      alias,
      nextIndex,
    };
  }

  const tableRefResult =
    parseTableWithFinalReferenceFromTokens(tokens, startIndex) ??
    parseQualifiedTableNameFromTokens(tokens, startIndex);
  if (!tableRefResult) {
    return undefined;
  }

  let nextIndex = tableRefResult.nextIndex;
  let alias: string | undefined;

  if (tokens[nextIndex]?.tokenType.name === "As") {
    nextIndex += 1;
  }

  if (isIdentifierToken(tokens[nextIndex])) {
    const candidate = normalizeTokenText(tokens[nextIndex]);
    if (!isAliasBoundaryToken(tokens[nextIndex])) {
      alias = candidate;
      nextIndex += 1;
    }
  }

  return { tableRef: tableRefResult.tableRef, alias, nextIndex };
}

function parseTableWithFinalReferenceFromTokens(
  tokens: IToken[],
  startIndex: number,
): { tableRef: QualifiedTableName; nextIndex: number } | undefined {
  if (
    tokens[startIndex]?.tokenType.name !== "Table" ||
    tokens[startIndex + 1]?.tokenType.name !== "With" ||
    tokens[startIndex + 2]?.tokenType.name !== "Final" ||
    tokens[startIndex + 3]?.tokenType.name !== "LParen"
  ) {
    return undefined;
  }

  const functionName = parseQualifiedTableNameFromTokens(
    tokens,
    startIndex + 4,
  );
  if (
    !functionName ||
    tokens[functionName.nextIndex]?.tokenType.name !== "LParen"
  ) {
    return undefined;
  }

  const functionArgsEnd = consumeBalancedParentheses(
    tokens,
    functionName.nextIndex,
  );
  if (
    !functionArgsEnd ||
    tokens[functionArgsEnd.nextIndex]?.tokenType.name !== "RParen"
  ) {
    return undefined;
  }

  return {
    tableRef: functionName.tableRef,
    nextIndex: functionArgsEnd.nextIndex + 1,
  };
}

function inferSimpleStarSubqueryTableRef(
  tokens: IToken[],
  subqueryStartIndex: number,
  subqueryEndIndex: number,
): QualifiedTableName | undefined {
  let depth = 0;
  let selectIndex: number | undefined;
  let fromIndex: number | undefined;

  for (
    let index = subqueryStartIndex + 1;
    index < subqueryEndIndex - 1;
    index++
  ) {
    const tokenName = tokens[index].tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
      continue;
    }
    if (tokenName === "RParen") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }

    if (selectIndex === undefined) {
      if (tokenName === "Select") {
        selectIndex = index;
        continue;
      }
      if (tokenName !== "Semicolon") {
        return undefined;
      }
      continue;
    }

    if (
      tokenName === "Union" ||
      tokenName === "Intersect" ||
      tokenName === "Except"
    ) {
      return undefined;
    }

    if (tokenName === "From") {
      fromIndex = index;
      break;
    }
  }

  if (selectIndex === undefined || fromIndex === undefined) {
    return undefined;
  }

  if (!isSimpleStarProjection(tokens, selectIndex + 1, fromIndex)) {
    return undefined;
  }

  const tableRefResult = parseQualifiedTableNameFromTokens(
    tokens,
    fromIndex + 1,
  );
  if (!tableRefResult) {
    return undefined;
  }

  const singleSrc = hasSingleTableSource(
    tokens,
    tableRefResult.nextIndex,
    subqueryEndIndex - 1,
  );
  if (!singleSrc) {
    return undefined;
  }

  return tableRefResult.tableRef;
}

function isSimpleStarProjection(
  tokens: IToken[],
  startIndex: number,
  fromIndex: number,
): boolean {
  let index = startIndex;
  while (index < fromIndex && tokens[index].tokenType.name === "Semicolon") {
    index += 1;
  }

  if (
    tokens[index]?.tokenType.name === "Distinct" ||
    tokens[index]?.tokenType.name === "All"
  ) {
    index += 1;
  }

  if (index >= fromIndex) {
    return false;
  }

  if (tokens[index].tokenType.name === "Multiply") {
    return index + 1 === fromIndex;
  }

  return (
    isIdentifierToken(tokens[index]) &&
    tokens[index + 1]?.tokenType.name === "Dot" &&
    tokens[index + 2]?.tokenType.name === "Multiply" &&
    index + 3 === fromIndex
  );
}

function hasSingleTableSource(
  tokens: IToken[],
  startIndex: number,
  endIndex: number,
): boolean {
  let index = startIndex;
  if (tokens[index]?.tokenType.name === "As") {
    index += 1;
  }
  if (
    isIdentifierToken(tokens[index]) &&
    !isAliasBoundaryToken(tokens[index])
  ) {
    index += 1;
  }

  let depth = 0;
  for (; index < endIndex; index++) {
    const tokenName = tokens[index].tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
      continue;
    }
    if (tokenName === "RParen") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      tokenName === "Join" ||
      tokenName === "Inner" ||
      tokenName === "Left" ||
      tokenName === "Right" ||
      tokenName === "Full" ||
      tokenName === "Cross" ||
      tokenName === "Natural" ||
      tokenName === "Comma"
    ) {
      return false;
    }
  }

  return true;
}

function parseQualifiedTableNameFromTokens(
  tokens: IToken[],
  startIndex: number,
): { tableRef: QualifiedTableName; nextIndex: number } | undefined {
  if (!isIdentifierToken(tokens[startIndex])) {
    return undefined;
  }

  const names: string[] = [normalizeTokenText(tokens[startIndex])];
  let dotCount = 0;
  let index = startIndex + 1;

  while (index < tokens.length && tokens[index].tokenType.name === "Dot") {
    dotCount += 1;
    index += 1;

    if (index < tokens.length && tokens[index].tokenType.name === "Dot") {
      dotCount += 1;
      index += 1;
    }

    if (!isIdentifierToken(tokens[index])) {
      break;
    }

    names.push(normalizeTokenText(tokens[index]));
    index += 1;
  }

  if (names.length === 1) {
    return { tableRef: { table: names[0] }, nextIndex: index };
  }

  if (names.length === 2) {
    if (dotCount >= 2) {
      return {
        tableRef: { database: names[0], table: names[1] },
        nextIndex: index,
      };
    }
    return {
      tableRef: { schema: names[0], table: names[1] },
      nextIndex: index,
    };
  }

  return {
    tableRef: { database: names[0], schema: names[1], table: names[2] },
    nextIndex: index,
  };
}

function registerAliasBinding(
  aliasCandidates: Map<string, AliasBindingCandidate[]>,
  tableRef: QualifiedTableName,
  alias: string | undefined,
  depth: number,
  nextOrder: () => number,
): void {
  const value: AliasInfo = {
    db: tableRef.database,
    schema: tableRef.schema,
    table: tableRef.table,
  };

  const addCandidate = (key: string): void => {
    const upperKey = key.toUpperCase();
    const candidates = aliasCandidates.get(upperKey) || [];
    candidates.push({ value, depth, order: nextOrder() });
    aliasCandidates.set(upperKey, candidates);
  };

  if (alias) {
    addCandidate(alias);
  }
  addCandidate(tableRef.table);
}

export function isIdentifierToken(token: IToken | undefined): token is IToken {
  if (!token) {
    return false;
  }
  const tokenName = token.tokenType.name;
  if (tokenName === "Identifier" || tokenName === "QuotedIdentifier") {
    return true;
  }
  const identifierLikeKeywords = new Set([
    "Public",
    "Admin",
    "Schema",
    "Database",
    "Table",
    "View",
    "Index",
    "User",
    "Role",
    "Group",
    "Order",
    "Select",
    "Insert",
    "Update",
    "Delete",
    "From",
    "Where",
    "Having",
    "Limit",
    "Offset",
    "Owner",
    "Start",
    "Hash",
    "Final",
    "Next",
    "Of",
    "Value",
    "Escape",
    "Key",
    "Union",
    "Except",
    "Intersect",
    "Type",
  ]);
  return identifierLikeKeywords.has(tokenName);
}


function isAliasBoundaryToken(token: IToken | undefined): boolean {
  if (!token) {
    return true;
  }

  const boundaryTokenNames = new Set([
    "Where",
    "Join",
    "Inner",
    "Left",
    "Right",
    "Full",
    "Cross",
    "Natural",
    "On",
    "Group",
    "Order",
    "Having",
    "Limit",
    "Union",
    "Intersect",
    "Except",
    "Set",
    "Values",
    "Semicolon",
    "Comma",
    "RParen",
    "Using",
  ]);

  return boundaryTokenNames.has(token.tokenType.name);
}


