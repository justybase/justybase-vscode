import { CompletionItem, Position } from "vscode-languageserver/node";
import type { DatabaseSqlFunctionSignature } from "../sql/authoring/types";
import { SqlLexer } from "../sqlParser";
import { toFunctionItems, toKeywordItems, toSpecialValueItems } from "./completionRenderer";

/**
 * Expression-clause helpers for function and clause-keyword completions.
 */
export function isExpressionClauseContext(statementPrefix: string): boolean {
  return !!resolveExpressionClauseContext(statementPrefix);
}

export function buildExpressionFunctionItems(
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
  sqlFunctionNames: readonly string[],
  sqlFunctionSignatures?: ReadonlyMap<
    string,
    readonly DatabaseSqlFunctionSignature[]
  >,
): CompletionItem[] {
  if (!shouldSuggestFunctions(statementPrefix, typedPrefix)) {
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
): CompletionItem[] {
  if (!shouldSuggestFunctions(statementPrefix, typedPrefix)) {
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
  from: ["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "WHERE", "GROUP", "ORDER"],
  where: ["AND", "OR", "NOT", "GROUP", "ORDER", "HAVING"],
  on: ["AND", "OR"],
  having: ["AND", "OR", "ORDER", "GROUP"],
  group: ["BY", "HAVING", "ORDER"],
  order: ["BY", "ASC", "DESC", "NULLS", "FIRST", "LAST"],
  set: ["AND", "OR", ","],
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
    if (name === "Group") {
      clause = "group";
      continue;
    }
    if (name === "Order") {
      clause = "order";
      continue;
    }
    if (name === "Set") {
      clause = "set";
      continue;
    }
  }

  if (
    clause === "select" ||
    clause === "where" ||
    clause === "on" ||
    clause === "having" ||
    clause === "group" ||
    clause === "order" ||
    clause === "set"
  ) {
    return clause;
  }

  return undefined;
}

function shouldSuggestFunctions(
  statementPrefix: string,
  typedPrefix: string,
): boolean {
  const lexResult = SqlLexer.tokenize(statementPrefix);
  if (lexResult.errors.length > 0 || lexResult.tokens.length === 0) {
    return !!typedPrefix;
  }

  const tokens = lexResult.tokens;
  const lastToken = tokens[tokens.length - 1];
  const previousToken = tokens.length > 1 ? tokens[tokens.length - 2] : undefined;
  if (!lastToken) {
    return !!typedPrefix;
  }

  const lastTokenName = lastToken.tokenType.name;
  if (!typedPrefix) {
    if (lastTokenName === "As") {
      return false;
    }
    return isExpressionStartToken(lastTokenName);
  }

  if (previousToken?.tokenType.name === "As") {
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