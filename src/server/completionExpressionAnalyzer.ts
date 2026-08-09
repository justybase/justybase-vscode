import { CompletionItem, Position } from "vscode-languageserver/node";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import { SqlLexer } from "../sqlParser";
import { toFunctionItems, toKeywordItems, toSpecialValueItems } from "./completionRenderer";

/**
 * Expression-clause helpers for function and clause-keyword completions.
 */

export function buildExpressionFunctionItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
  sqlFunctionNames: readonly string[],
  sqlFunctionSignatures?: ReadonlyMap<
    string,
    readonly DatabaseSqlFunctionSignature[]
  >,
  allowOnEmptyPrefix = false,
): CompletionItem[] {
  if (!shouldSuggestFunctions(statementPrefix, typedPrefix, allowOnEmptyPrefix)) {
    return [];
  }
  return toFunctionItems(
    typedPrefix,
    position,
    sqlFunctionNames,
    sqlFunctionSignatures,
  );
}

export function buildExpressionSpecialValueItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
  specialValues: readonly string[],
  allowOnEmptyPrefix = false,
): CompletionItem[] {
  if (!shouldSuggestFunctions(statementPrefix, typedPrefix, allowOnEmptyPrefix)) {
    return [];
  }
  return toSpecialValueItems(typedPrefix, position, specialValues);
}

export function buildExpressionClauseKeywordItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
  completionKeywords: readonly string[],
): CompletionItem[] {
  const clause = resolveExpressionClauseContext(statementPrefix);
  if (
    !clause ||
    (clause !== "where" &&
      clause !== "on" &&
      clause !== "having" &&
      clause !== "set")
  ) {
    return [];
  }

  const allowedKeywords = new Set(["AND", "OR", "NOT"]);
  return toKeywordItems(typedPrefix, position, completionKeywords).filter(
    (item) => allowedKeywords.has(item.label.toUpperCase()),
  );
}

const CLAUSE_KEYWORD_MAP: Record<string, readonly string[]> = {
  select: ["DISTINCT", "ALL", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT"],
  // Verified against a live Netezza instance (see
  // netezzaCompletionKeywordLegality.live.integration.test.ts): standalone
  // OUTER and FETCH FIRST are rejected by NPS, OFFSET (even without LIMIT) and
  // UNION/INTERSECT/EXCEPT are accepted.
  from: ["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "AS"],
  where: ["AND", "OR", "NOT", "GROUP", "ORDER", "HAVING"],
  on: ["AND", "OR"],
  having: ["AND", "OR", "ORDER", "GROUP"],
  group: ["BY", "HAVING", "ORDER"],
  order: ["BY", "ASC", "DESC", "NULLS", "FIRST", "LAST"],
  set: ["AND", "OR", ","],
  union: ["SELECT", "WITH", "EXCEPT", "INTERSECT", "UNION", "ALL"],
  limit: [],
  offset: [],
};

export function buildContextualKeywordItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
  completionKeywords: readonly string[],
): CompletionItem[] {
  const clause = resolveExpressionClauseContext(statementPrefix);
  if (!clause) {
    return [];
  }

  const allowed = CLAUSE_KEYWORD_MAP[clause];
  if (!allowed || allowed.length === 0) {
    return [];
  }

  const allowedSet = new Set(allowed.map((keyword) => keyword.toUpperCase()));
  return toKeywordItems(typedPrefix, position, completionKeywords).filter(
    (item) => allowedSet.has(item.label.toUpperCase()),
  );
}

export function resolveExpressionClauseContext(
  statementPrefix: string,
):
  | "select"
  | "from"
  | "where"
  | "on"
  | "having"
  | "group"
  | "order"
  | "set"
  | "values"
  | "union"
  | "limit"
  | "offset"
  | "plsql"
  | undefined {
  const lexResult = SqlLexer.tokenize(statementPrefix);
  if (lexResult.tokens.length === 0) {
    return undefined;
  }

  let clause:
    | "select"
    | "from"
    | "where"
    | "on"
    | "having"
    | "group"
    | "order"
    | "set"
    | "values"
    | "union"
    | "limit"
    | "offset"
    | "plsql"
    | undefined;
  for (const token of lexResult.tokens) {
    const name = token.tokenType.name;
    if (name === "Select") {
      clause = "select";
      continue;
    }
    if (name === "From" || name === "Join") {
      clause = "from";
      continue;
    }
    if (name === "Where") {
      clause = "where";
      continue;
    }
    if (name === "On") {
      clause = "on";
      continue;
    }
    if (name === "Having") {
      clause = "having";
      continue;
    }
    if (name === "Group" || name === "GroupBy") {
      clause = "group";
      continue;
    }
    if (name === "Order" || name === "OrderBy") {
      clause = "order";
      continue;
    }
    if (name === "Set") {
      clause = "set";
      continue;
    }
    if (name === "Values") {
      clause = "values";
      continue;
    }
    if (name === "Union" || name === "Intersect" || name === "Except") {
      clause = "union";
      continue;
    }
    if (name === "Limit") {
      clause = "limit";
      continue;
    }
    if (name === "Offset") {
      clause = "offset";
      continue;
    }
    if (
      name === "Return" ||
      name === "Assign" ||
      name === "Then" ||
      name === "Else"
    ) {
      clause = "plsql";
      continue;
    }
  }

  if (
    clause === "select" ||
    clause === "from" ||
    clause === "where" ||
    clause === "on" ||
    clause === "having" ||
    clause === "group" ||
    clause === "order" ||
    clause === "set" ||
    clause === "values" ||
    clause === "union" ||
    clause === "limit" ||
    clause === "offset" ||
    clause === "plsql"
  ) {
    return clause;
  }

  return undefined;
}

function shouldSuggestFunctions(
  statementPrefix: string,
  typedPrefix: string,
  allowOnEmptyPrefix = false,
): boolean {
  const lexResult = SqlLexer.tokenize(statementPrefix);
  if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
    return typedPrefix !== "" || allowOnEmptyPrefix;
  }

  const tokens = lexResult.tokens;
  const lastToken = tokens[tokens.length - 1];
  const previousToken = tokens.length > 1 ? tokens[tokens.length - 2] : undefined;
  if (!lastToken) {
    return true;
  }

  const lastTokenName = lastToken.tokenType.name;
  if (!typedPrefix) {
    if (!allowOnEmptyPrefix) {
      return false;
    }
    if (lastTokenName === "As") {
      return false;
    }
    return isExpressionStartToken(lastTokenName);
  }

  if (
    previousToken?.tokenType.name === "As" ||
    lastTokenName === "As"
  ) {
    return false;
  }

  if (
    lastTokenName !== "Identifier" &&
    lastTokenName !== "QuotedIdentifier"
  ) {
    return true;
  }

  if (!previousToken) {
    return true;
  }

  return !isExpressionEndingToken(previousToken.tokenType.name);
}

function isExpressionStartToken(tokenName: string): boolean {
  return (
    tokenName === "Select" ||
    tokenName === "Where" ||
    tokenName === "On" ||
    tokenName === "Having" ||
    tokenName === "Set" ||
    tokenName === "Comma" ||
    tokenName === "LParen" ||
    tokenName === "Plus" ||
    tokenName === "Minus" ||
    tokenName === "Multiply" ||
    tokenName === "Divide" ||
    tokenName === "Modulo" ||
    tokenName === "Caret" ||
    tokenName === "Equals" ||
    tokenName === "NotEquals" ||
    tokenName === "LessThan" ||
    tokenName === "LessThanEquals" ||
    tokenName === "GreaterThan" ||
    tokenName === "GreaterThanEquals" ||
    tokenName === "And" ||
    tokenName === "Or" ||
    tokenName === "When" ||
    tokenName === "Then" ||
    tokenName === "Else"
  );
}

function isExpressionEndingToken(tokenName: string): boolean {
  return (
    tokenName === "Identifier" ||
    tokenName === "QuotedIdentifier" ||
    tokenName === "NumberLiteral" ||
    tokenName === "StringLiteral" ||
    tokenName === "Null" ||
    tokenName === "RParen" ||
    tokenName === "RBracket"
  );
}
