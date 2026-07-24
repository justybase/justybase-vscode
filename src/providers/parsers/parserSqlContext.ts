import { CstNode } from "chevrotain";
import type { DatabaseKind } from "../../contracts/database";
import { isIgnorableTrailingDotParserError } from "../../sqlParser/parserErrorUtils";
import {
  parseSqlStatements,
  resolveSqlParsingRuntime,
  type SqlStatementsParseResult,
} from "../../sqlParser/parsingRuntime";
import type { AliasInfo, LocalDefinition } from "../types";
import {
  consumeBalancedParentheses,
  getOrCreateParserSqlContextCollector,
  isIdentifierToken,
  parseAliasBindingsFromTokens,
} from "./scope/aliasScope";
import {
  getChildNodesByKey,
  getChildNodesFlat,
  getIdentifierTokenByKey,
  getNodeRange,
  normalizeTokenText,
  type NodeRangeCache,
} from "./scope/cstNodeUtils";
import { parseLocalDefinitions as parseLocalDefinitionsLegacy } from "./sqlParser";

const CTE_VISIBILITY_CACHE = new WeakMap<
  CstNode,
  Map<number, Set<string> | undefined>
>();

function parseCst(
  sql: string,
  databaseKind?: DatabaseKind,
): CstNode | undefined {
  const parseResult = parseSqlStatements({
    sql,
    databaseKind,
    ignoreParserError: isIgnorableTrailingDotParserError,
  });
  if (
    parseResult.lexResult.errors.length > 0 ||
    !parseResult.cst ||
    parseResult.actionableParserErrors.length > 0
  ) {
    return undefined;
  }

  return parseResult.cst;
}

export interface ParserSemanticScope {
  aliasBindings: Map<string, AliasInfo>;
  globalAliasBindings: Map<string, AliasInfo>;
  preferredAliasBindings: Map<string, AliasInfo>;
  localDefinitions: LocalDefinition[];
  visibleLocalDefinitions: LocalDefinition[];
  source: "cst" | "token";
  hasScopedParserContext: boolean;
  cst?: CstNode;
}

export function parseValidatedSqlCst(
  sql: string,
  databaseKind?: DatabaseKind,
): CstNode | undefined {
  return parseCst(sql, databaseKind);
}

function filterVisibleLocalDefinitions(
  localDefinitions: LocalDefinition[],
  sql: string,
  offset?: number,
  databaseKind?: DatabaseKind,
  cst?: CstNode,
  allowCstParse = true,
): LocalDefinition[] {
  if (offset === undefined) {
    return localDefinitions;
  }

  const visibleCtes = resolveVisibleCteNamesAtOffset(
    sql,
    offset,
    databaseKind,
    cst,
    allowCstParse,
  );
  if (!visibleCtes) {
    return localDefinitions;
  }

  return localDefinitions.filter(
    (def) => {
      if (
        def.scopeStart !== undefined &&
        def.scopeEnd !== undefined &&
        (offset < def.scopeStart || offset > def.scopeEnd)
      ) {
        return false;
      }
      return def.type !== "CTE" || visibleCtes.has(def.name.toUpperCase());
    },
  );
}

export function buildSemanticScopeFromParseResult(
  parseResult: SqlStatementsParseResult,
  sql: string,
  cursorOffset?: number,
  databaseKind?: DatabaseKind,
): ParserSemanticScope {
  const cst =
    parseResult.lexResult.errors.length === 0 &&
    parseResult.cst &&
    parseResult.actionableParserErrors.length === 0
      ? parseResult.cst
      : undefined;

  if (cst) {
    const collector = getOrCreateParserSqlContextCollector(cst, databaseKind);

    const localDefinitions = collector.getLocalDefinitions();
    const visibleLocalDefinitions = filterVisibleLocalDefinitions(
      localDefinitions,
      sql,
      cursorOffset,
      databaseKind,
      cst,
    );
    const aliasBindings = collector.getAliasBindings(cursorOffset);
    const globalAliasBindings = collector.getAliasBindings(undefined);
    const hasScopedParserContext = Boolean(
      cst.children?.["selectStatement"] || cst.children?.["withStatement"],
    );

    let preferredAliasBindings = aliasBindings;
    if (preferredAliasBindings.size === 0) {
      if (globalAliasBindings.size > 0) {
        preferredAliasBindings = globalAliasBindings;
      } else if (!hasScopedParserContext) {
        preferredAliasBindings = parseAliasBindingsFromTokens(
          sql,
          cursorOffset,
          databaseKind,
        );
      }
    }

    return {
      aliasBindings,
      globalAliasBindings,
      preferredAliasBindings,
      localDefinitions,
      visibleLocalDefinitions,
      source: "cst",
      hasScopedParserContext,
      cst,
    };
  }

  const preferredAliasBindings = parseAliasBindingsFromTokens(
    sql,
    cursorOffset,
    databaseKind,
  );
  const localDefinitions = parseLocalDefinitionsLegacy(sql);
  const visibleLocalDefinitions = filterVisibleLocalDefinitions(
    localDefinitions,
    sql,
    cursorOffset,
    databaseKind,
    undefined,
    false,
  );

  return {
    aliasBindings: preferredAliasBindings,
    globalAliasBindings: preferredAliasBindings,
    preferredAliasBindings,
    localDefinitions,
    visibleLocalDefinitions,
    source: "token",
    hasScopedParserContext: false,
  };
}

export function parseSemanticScopeWithParser(
  sql: string,
  cursorOffset?: number,
  databaseKind?: DatabaseKind,
): ParserSemanticScope {
  const parseResult = parseSqlStatements({
    sql,
    databaseKind,
    ignoreParserError: isIgnorableTrailingDotParserError,
  });
  return buildSemanticScopeFromParseResult(
    parseResult,
    sql,
    cursorOffset,
    databaseKind,
  );
}

export function parseLocalDefinitionsWithParser(
  sql: string,
  databaseKind?: DatabaseKind,
): LocalDefinition[] {
  return parseSemanticScopeWithParser(sql, undefined, databaseKind)
    .localDefinitions;
}

export function parseAliasBindingsWithParser(
  statementSql: string,
  cursorOffset?: number,
  databaseKind?: DatabaseKind,
): Map<string, AliasInfo> {
  return parseSemanticScopeWithParser(
    statementSql,
    cursorOffset,
    databaseKind,
  ).preferredAliasBindings;
}

export function parseVisibleLocalDefinitionsWithParser(
  sql: string,
  offset: number,
  databaseKind?: DatabaseKind,
): LocalDefinition[] {
  return parseSemanticScopeWithParser(sql, offset, databaseKind)
    .visibleLocalDefinitions;
}

function resolveVisibleCteNamesAtOffset(
  sql: string,
  offset: number,
  databaseKind?: DatabaseKind,
  cst?: CstNode,
  allowCstParse = true,
): Set<string> | undefined {
  const resolvedCst = cst ?? (allowCstParse ? parseCst(sql, databaseKind) : undefined);
  if (resolvedCst) {
    const resolvedFromCst = resolveVisibleCteNamesFromCst(resolvedCst, offset);
    if (resolvedFromCst) {
      return resolvedFromCst;
    }
  }

  return resolveTopLevelCteNamesFromTokens(sql, offset, databaseKind);
}

function resolveVisibleCteNamesFromCst(
  root: CstNode,
  offset: number,
): Set<string> | undefined {
  let perNodeCache = CTE_VISIBILITY_CACHE.get(root);
  if (perNodeCache?.has(offset)) {
    return perNodeCache.get(offset);
  }

  const rangeCache: NodeRangeCache = new WeakMap();
  let result: Set<string> | undefined;

  const visit = (node: CstNode, visibleCtes: Set<string>): boolean => {
    const nodeRange = getNodeRange(node, rangeCache);
    if (!nodeRange || offset < nodeRange.start || offset > nodeRange.end) {
      return false;
    }

    if (
      node.name === "withStatement" ||
      node.name === "withAnyStatement" ||
      node.name === "insertWithClause"
    ) {
      return visitWithNode(node, visibleCtes);
    }

    const children = getChildNodesFlat(node);
    for (const child of children) {
      if (visit(child, visibleCtes)) {
        return true;
      }
    }

    result = new Set(visibleCtes);
    return true;
  };

  const visitWithNode = (
    node: CstNode,
    inheritedVisibleCtes: Set<string>,
  ): boolean => {
    const cteNodes =
      node.name === "insertWithClause"
        ? getChildNodesByKey(node, "insertCteDefinition")
        : getChildNodesByKey(node, "cteDefinition");

    const visibleInWith = new Set(inheritedVisibleCtes);
    for (const cteNode of cteNodes) {
      const cteNameToken = getIdentifierTokenByKey(cteNode);
      if (cteNameToken) {
        visibleInWith.add(normalizeTokenText(cteNameToken).toUpperCase());
      }

      const nestedQuery =
        getChildNodesByKey(cteNode, "withStatement")[0] ??
        getChildNodesByKey(cteNode, "selectStatement")[0];
      if (nestedQuery) {
        const nestedRange = getNodeRange(nestedQuery, rangeCache);
        if (
          nestedRange &&
          offset >= nestedRange.start &&
          offset <= nestedRange.end
        ) {
          return visit(nestedQuery, new Set(visibleInWith));
        }
      }
    }

    const mainStatement =
      getChildNodesByKey(node, "selectStatement")[0] ??
      getChildNodesByKey(node, "insertStatement")[0] ??
      getChildNodesByKey(node, "updateStatement")[0] ??
      getChildNodesByKey(node, "deleteStatement")[0];

    if (mainStatement) {
      const mainRange = getNodeRange(mainStatement, rangeCache);
      if (mainRange && offset >= mainRange.start && offset <= mainRange.end) {
        return visit(mainStatement, new Set(visibleInWith));
      }
    }

    result = new Set(visibleInWith);
    return true;
  };

  visit(root, new Set());

  if (!perNodeCache) {
    perNodeCache = new Map();
    CTE_VISIBILITY_CACHE.set(root, perNodeCache);
  }
  perNodeCache.set(offset, result);
  return result;
}

function resolveTopLevelCteNamesFromTokens(
  sql: string,
  offset: number,
  databaseKind?: DatabaseKind,
): Set<string> {
  const visible = new Set<string>();
  const boundedOffset = Math.max(0, Math.min(offset, sql.length));
  const prefix = sql.substring(0, boundedOffset);
  const lexResult = resolveSqlParsingRuntime({
    databaseKind,
  }).SqlLexer.tokenize(prefix);
  if (lexResult.tokens.length === 0) {
    return visible;
  }

  const tokens = lexResult.tokens;
  let index = 0;

  while (
    index < tokens.length &&
    tokens[index].tokenType.name === "Semicolon"
  ) {
    index += 1;
  }
  if (tokens[index]?.tokenType.name !== "With") {
    return visible;
  }

  index += 1;
  if (tokens[index]?.tokenType.name === "Recursive") {
    index += 1;
  }

  while (index < tokens.length) {
    if (!isIdentifierToken(tokens[index])) {
      break;
    }
    visible.add(normalizeTokenText(tokens[index]).toUpperCase());
    index += 1;

    if (tokens[index]?.tokenType.name === "LParen") {
      const columnList = consumeBalancedParentheses(tokens, index);
      if (!columnList) {
        return visible;
      }
      index = columnList.nextIndex;
    }

    while (index < tokens.length && tokens[index].tokenType.name !== "As") {
      index += 1;
    }
    if (index >= tokens.length) {
      return visible;
    }
    index += 1;

    if (tokens[index]?.tokenType.name === "All") {
      index += 1;
    }

    if (tokens[index]?.tokenType.name !== "LParen") {
      return visible;
    }

    const cteBody = consumeBalancedParentheses(tokens, index);
    if (!cteBody) {
      return visible;
    }
    index = cteBody.nextIndex;

    if (tokens[index]?.tokenType.name === "Comma") {
      index += 1;
      continue;
    }
    break;
  }

  return visible;
}
