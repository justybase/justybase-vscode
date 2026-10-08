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

export type SemanticScopeRelationKind =
  | "table"
  | "cte"
  | "derived_table"
  | "script_local_table";

export interface SemanticScopeRelation {
  name: string;
  alias: string;
  kind: SemanticScopeRelationKind;
}

export interface SemanticScopeAtCursor {
  visibleRelations: SemanticScopeRelation[];
  visibleCtes: string[];
  visibleAliases: string[];
}

/**
 * Direct semantic scope primitive for editor contracts: the relations,
 * CTEs and reference names visible at one cursor offset. This is the
 * production source of truth for scope-aware completion; it deliberately
 * exposes no scope ids, parents, depths, AST nodes or shadowing data.
 */
export function resolveSemanticScopeAtCursor(
  sql: string,
  cursorOffset: number,
  databaseKind?: DatabaseKind,
): SemanticScopeAtCursor {
  const statements = splitTopLevelStatements(sql, databaseKind);
  if (statements.length > 1) {
    const target =
      statements.find(
        (statement) =>
          cursorOffset >= statement.start && cursorOffset <= statement.contentEnd,
      ) ??
      [...statements].reverse().find((statement) => statement.start <= cursorOffset) ??
      statements[statements.length - 1];
    const scriptLocalNames = collectScriptLocalTableNames(
      sql,
      statements,
      cursorOffset,
      databaseKind,
    );
    const inner = resolveSingleStatementScope(
      sql.slice(target.start, target.contentEnd),
      cursorOffset - target.start,
      databaseKind,
    );
    return applyScriptLocalRelations(inner, scriptLocalNames);
  }
  const scriptLocalNames = collectScriptLocalTableNames(
    sql,
    statements,
    cursorOffset,
    databaseKind,
  );
  return applyScriptLocalRelations(
    resolveSingleStatementScope(sql, cursorOffset, databaseKind),
    scriptLocalNames,
  );
}

interface TopLevelStatement {
  start: number;
  contentEnd: number;
  terminatedAt: number;
}

function splitTopLevelStatements(
  sql: string,
  databaseKind?: DatabaseKind,
): TopLevelStatement[] {
  const lexResult = resolveSqlParsingRuntime({ databaseKind }).SqlLexer.tokenize(sql);
  const statements: TopLevelStatement[] = [];
  let start = 0;
  let depth = 0;
  for (const token of lexResult.tokens) {
    const tokenName = token.tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
    } else if (tokenName === "RParen") {
      depth = Math.max(0, depth - 1);
    } else if (tokenName === "Semicolon" && depth === 0) {
      statements.push({
        start,
        contentEnd: token.startOffset,
        terminatedAt: token.startOffset + token.image.length,
      });
      start = token.startOffset + token.image.length;
    }
  }
  if (start < sql.length || statements.length === 0) {
    statements.push({ start, contentEnd: sql.length, terminatedAt: sql.length });
  }
  return statements;
}

function isIdentifierTokenName(tokenName: string): boolean {
  return tokenName === "Identifier" || tokenName === "QuotedIdentifier";
}

function collectScriptLocalTableNames(
  sql: string,
  statements: TopLevelStatement[],
  cursorOffset: number,
  databaseKind?: DatabaseKind,
): Set<string> {
  const names = new Set<string>();
  if (statements.length === 0) {
    return names;
  }
  const lexResult = resolveSqlParsingRuntime({ databaseKind }).SqlLexer.tokenize(sql);
  const tokens = lexResult.tokens;
  const statementEndFor = (offset: number): number =>
    statements.find(
      (statement) => offset >= statement.start && offset < statement.terminatedAt,
    )?.terminatedAt ?? sql.length;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startOffset > cursorOffset) {
      break;
    }
    const tokenName = token.tokenType.name;
    if (tokenName === "Create") {
      let next = index + 1;
      let isTemp = false;
      if (
        tokens[next]?.tokenType.name === "Global" ||
        tokens[next]?.image.toUpperCase() === "LOCAL"
      ) {
        next += 1;
      }
      if (
        tokens[next]?.tokenType.name === "Temp" ||
        tokens[next]?.tokenType.name === "Temporary"
      ) {
        isTemp = true;
        next += 1;
      }
      if (tokens[next]?.tokenType.name !== "Table") {
        continue;
      }
      next += 1;
      if (tokens[next]?.tokenType.name === "If") {
        next += 1;
        if (tokens[next]?.tokenType.name === "Not") {
          next += 1;
        }
        if (tokens[next]?.tokenType.name === "Exists") {
          next += 1;
        }
      }
      const target = tokens[next];
      if (!target || !isIdentifierTokenName(target.tokenType.name)) {
        continue;
      }
      if (statementEndFor(token.startOffset) > cursorOffset) {
        continue;
      }
      const tableName = stripIdentifierQuotes(target.image).toUpperCase();
      if (isTemp) {
        names.add(tableName);
        continue;
      }
      for (let scan = next + 1; scan < tokens.length; scan++) {
        const scanName = tokens[scan].tokenType.name;
        if (scanName === "As") {
          const after = tokens[scan + 1];
          if (after && (after.tokenType.name === "Select" || after.tokenType.name === "With")) {
            names.add(tableName);
          }
          break;
        }
        if (scanName === "Semicolon" || scanName === "Select" || scanName === "With") {
          break;
        }
      }
    } else if (tokenName === "Drop") {
      let next = index + 1;
      if (tokens[next]?.tokenType.name !== "Table") {
        continue;
      }
      next += 1;
      if (tokens[next]?.tokenType.name === "If") {
        next += 1;
        if (tokens[next]?.tokenType.name === "Exists") {
          next += 1;
        }
      }
      const target = tokens[next];
      if (!target || !isIdentifierTokenName(target.tokenType.name)) {
        continue;
      }
      if (statementEndFor(token.startOffset) > cursorOffset) {
        continue;
      }
      names.delete(stripIdentifierQuotes(target.image).toUpperCase());
    }
  }
  return names;
}

function applyScriptLocalRelations(
  result: SemanticScopeAtCursor,
  scriptLocalNames: Set<string>,
): SemanticScopeAtCursor {
  if (scriptLocalNames.size === 0) {
    return result;
  }
  const relations: SemanticScopeRelation[] = [];
  const seen = new Set<string>();
  for (const relation of result.visibleRelations) {
    const normalized = stripIdentifierQuotes(relation.name).toUpperCase();
    const kind: SemanticScopeRelationKind = scriptLocalNames.has(normalized)
      ? "script_local_table"
      : relation.kind;
    const key = `${relation.alias.toUpperCase()}|${normalized}|${kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    relations.push({ name: relation.name, alias: relation.alias, kind });
  }
  return {
    visibleRelations: relations,
    visibleCtes: result.visibleCtes,
    visibleAliases: relations.map((relation) => relation.alias),
  };
}

function stripIdentifierQuotes(identifier: string): string {
  if (identifier.length >= 2 && identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  if (identifier.length >= 2 && identifier.startsWith("[") && identifier.endsWith("]")) {
    return identifier.slice(1, -1).replace(/\]\]/g, "]");
  }
  return identifier;
}

function resolveSingleStatementScope(
  sql: string,
  cursorOffset: number,
  databaseKind?: DatabaseKind,
): SemanticScopeAtCursor {
  const scope = parseSemanticScopeWithParser(sql, cursorOffset, databaseKind);
  const visibleCtes = scope.visibleLocalDefinitions
    .filter((definition) => definition.type === "CTE")
    .map((definition) => definition.name);
  const visibleCteNames = new Set(visibleCtes.map((name) => name.toUpperCase()));
  const visibleRelations: SemanticScopeRelation[] = [];
  const seen = new Set<string>();
  const pushRelation = (relation: SemanticScopeRelation): void => {
    const key = `${relation.alias.toUpperCase()}|${relation.name.toUpperCase()}|${relation.kind}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    visibleRelations.push(relation);
  };
  const aliasEntries = [...scope.preferredAliasBindings.entries()];
  const explicitTableRefs = new Set(
    aliasEntries
      .filter(
        ([alias, binding]) =>
          alias.toUpperCase() !== (binding.table ?? "").toUpperCase(),
      )
      .map(
        ([, binding]) =>
          `${binding.db ?? ""}|${binding.schema ?? ""}|${binding.table ?? ""}`,
      ),
  );
  const derivedAliasNames = new Set(
    scope.visibleLocalDefinitions
      .filter((definition) => definition.type === "Subquery")
      .map((definition) => definition.name.toUpperCase()),
  );
  for (const [alias, binding] of aliasEntries) {
    const table = binding.table ?? "";
    if (derivedAliasNames.has(alias.toUpperCase())) {
      continue;
    }
    if (
      table &&
      alias.toUpperCase() === table.toUpperCase() &&
      explicitTableRefs.has(
        `${binding.db ?? ""}|${binding.schema ?? ""}|${binding.table ?? ""}`,
      )
    ) {
      continue;
    }
    const kind: SemanticScopeRelationKind = visibleCteNames.has(table.toUpperCase())
      ? "cte"
      : table
        ? "table"
        : "derived_table";
    pushRelation({ name: table || alias, alias, kind });
  }
  const hasRelationNamed = (name: string): boolean =>
    visibleRelations.some(
      (relation) => relation.name.toUpperCase() === name.toUpperCase(),
    );
  for (const definition of scope.visibleLocalDefinitions) {
    if (definition.type === "CTE") {
      if (hasRelationNamed(definition.name)) {
        continue;
      }
      pushRelation({ name: definition.name, alias: definition.name, kind: "cte" });
    } else if (definition.type === "Temp Table") {
      if (hasRelationNamed(definition.name)) {
        continue;
      }
      pushRelation({
        name: definition.name,
        alias: definition.name,
        kind: "script_local_table",
      });
    } else if (definition.type === "Subquery") {
      pushRelation({
        name: definition.name,
        alias: definition.name,
        kind: "derived_table",
      });
    }
  }
  return {
    visibleRelations,
    visibleCtes,
    visibleAliases: visibleRelations.map((relation) => relation.alias),
  };
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
