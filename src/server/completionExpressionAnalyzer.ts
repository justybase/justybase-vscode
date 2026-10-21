import type { IToken } from "chevrotain";
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

  const allowedKeywords = new Set(predicateKeywords(tokensBeforeTypedPrefix(statementPrefix, typedPrefix)));
  return toKeywordItems(typedPrefix, position, completionKeywords).filter(
    (item) => allowedKeywords.has(item.label.toUpperCase()),
  );
}

/**
 * Tokens preceding the identifier being typed. The typed word itself is not
 * an operand yet, so `WHERE C|` must be analysed as `WHERE |`.
 */
function tokensBeforeTypedPrefix(statementPrefix: string, typedPrefix: string): IToken[] {
  const text =
    typedPrefix && statementPrefix.toUpperCase().endsWith(typedPrefix.toUpperCase())
      ? statementPrefix.slice(0, statementPrefix.length - typedPrefix.length)
      : statementPrefix;
  return SqlLexer.tokenize(text).tokens;
}

const COMPARISON_TOKENS = new Set(["Equals", "NotEquals", "LessThan", "LessThanEquals", "GreaterThan", "GreaterThanEquals", "In", "Between", "Like", "Is"]);

/** Keywords following the current predicate operand or completed comparison. */
function predicateKeywords(tokens: readonly IToken[]): readonly string[] {
  let boundary = -1;
  let openBetween = false;
  for (let index = 0; index < tokens.length; index++) {
    const name = tokens[index].tokenType.name;
    if (name === "Between") {
      openBetween = true;
    } else if (name === "And" && openBetween) {
      // `x BETWEEN 1 AND 5` is one predicate; its AND is not a boundary.
      openBetween = false;
    } else if (["Where", "On", "Having", "And", "Or"].includes(name)) {
      boundary = index;
      openBetween = false;
    }
  }
  const expression = tokens.slice(boundary + 1);
  const last = expression[expression.length - 1]?.tokenType.name;
  const comparison = expression.some(token => COMPARISON_TOKENS.has(token.tokenType.name));
  if (last && isExpressionEndingToken(last)) {
    if (!comparison) return ["IN", "BETWEEN", "NOT", "LIKE", "IS", "AND", "OR"];
    return expression.some(token => token.tokenType.name === "Like") ? ["AND", "OR", "ESCAPE"] : ["AND", "OR"];
  }
  return ["AND", "OR", "NOT"];
}

const SET_OPERATION_KEYWORDS = ["UNION", "INTERSECT", "EXCEPT"] as const;

/**
 * Keywords that may follow a completed operand at the top level of a clause.
 * An identifier typed there is a keyword or an alias, never a column/function.
 */
const OPERAND_CONTINUATION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  select: ["FROM", "AS", "OVER", ...SET_OPERATION_KEYWORDS],
  where: ["GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS],
  on: ["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS],
  having: ["ORDER", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS],
  group: ["HAVING", "ORDER", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS],
  order: ["ASC", "DESC", "NULLS", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS],
  // UPDATE ... SET a = 1 [, b = 2] [FROM ...] [WHERE ...]
  set: ["FROM", "WHERE"],
};

/** Keywords legal right after an operand inside parentheses or an open CASE. */
const NESTED_CONTINUATION_KEYWORDS = [
  "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE", "IS", "ESCAPE", "AS", "FROM", "FOR",
  "WHEN", "THEN", "ELSE", "END", "OVER", "ORDER", "PARTITION", "ROWS", "RANGE",
  "ASC", "DESC", "NULLS", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS,
];

const CLAUSE_START_TOKENS: Readonly<Record<string, readonly string[]>> = {
  select: ["Select"],
  where: ["Where"],
  on: ["On"],
  having: ["Having"],
  group: ["Group", "GroupBy"],
  order: ["Order", "OrderBy"],
  set: ["Set"],
};

/** Value-like words that complete an operand even when they are keywords. */
const VALUE_KEYWORDS = new Set(["TRUE", "FALSE", "UNKNOWN"]);

/**
 * Returns the keywords allowed after a completed operand in an expression
 * clause (`WHERE A > 0 |`, `SELECT COL |`, `ORDER BY COL |`), or `undefined`
 * when the cursor still expects an operand and columns/functions apply.
 */
export function resolveOperandContinuationKeywords(
  clause: string,
  statementPrefix: string,
  typedPrefix: string,
  completionKeywords: readonly string[],
  specialValues: readonly string[] = [],
): readonly string[] | undefined {
  const clauseStarts = CLAUSE_START_TOKENS[clause];
  if (!clauseStarts) {
    return undefined;
  }
  const tokens = tokensBeforeTypedPrefix(statementPrefix, typedPrefix);
  let clauseStart = -1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (clauseStarts.includes(tokens[index].tokenType.name)) {
      clauseStart = index;
      break;
    }
  }
  const clauseTokens = tokens.slice(clauseStart + 1);
  const last = clauseTokens[clauseTokens.length - 1];
  if (!last) {
    return undefined;
  }
  if (clause === "order" && last.tokenType.name === "Nulls") {
    return ["FIRST", "LAST"];
  }

  const keywordWords = new Set(completionKeywords.map((keyword) => keyword.toUpperCase()));
  for (const value of specialValues) keywordWords.delete(value.toUpperCase());
  for (const value of VALUE_KEYWORDS) keywordWords.delete(value);
  const previous = clauseTokens[clauseTokens.length - 2];
  if (!completesOperand(last, previous, keywordWords)) {
    if (clause === "order" && (last.tokenType.name === "Asc" || last.tokenType.name === "Desc")) {
      return ["NULLS", "LIMIT", "OFFSET", ...SET_OPERATION_KEYWORDS];
    }
    return undefined;
  }

  let depth = 0;
  let openCase = 0;
  for (const token of clauseTokens) {
    const name = token.tokenType.name;
    if (name === "LParen") depth++;
    else if (name === "RParen") depth = Math.max(0, depth - 1);
    else if (name === "Case") openCase++;
    else if (name === "End") openCase = Math.max(0, openCase - 1);
  }
  if (depth > 0 || openCase > 0) {
    return NESTED_CONTINUATION_KEYWORDS;
  }
  if (clause === "where" || clause === "on" || clause === "having") {
    return [...predicateKeywords(clauseTokens), ...OPERAND_CONTINUATION_KEYWORDS[clause]];
  }
  return OPERAND_CONTINUATION_KEYWORDS[clause];
}

const STATEMENT_START_TOKENS = new Set(["Semicolon", "BeginProc", "Begin", "Loop"]);

/** The cursor starts a new statement (document start, after `;`, or a block opener). */
export function isStatementStartPosition(statementPrefix: string, typedPrefix: string): boolean {
  const tokens = tokensBeforeTypedPrefix(statementPrefix, typedPrefix);
  const last = tokens[tokens.length - 1];
  return !last || STATEMENT_START_TOKENS.has(last.tokenType.name);
}

/** Keywords that can open a top-level statement (intersected with the dialect's keywords). */
export const STATEMENT_START_KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT", "WITH", "VALUES", "INSERT", "INSERT INTO", "UPDATE", "DELETE", "DELETE FROM",
  "MERGE", "MERGE INTO", "UPSERT", "REPLACE", "CREATE", "CREATE TABLE", "ALTER", "ALTER TABLE",
  "DROP", "DROP TABLE", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE", "CALL", "EXEC",
  "EXECUTE", "EXPLAIN", "DESCRIBE", "DESC", "SHOW", "USE", "SET", "RESET", "BEGIN", "START",
  "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ABORT", "LOCK", "DECLARE", "DO", "IF",
  "GROOM", "GENERATE", "ANALYZE", "VACUUM", "REINDEX", "CLUSTER", "COPY", "LOAD", "UNLOAD",
  "PRAGMA", "ATTACH", "DETACH", "INSTALL", "EXPORT", "IMPORT", "OPTIMIZE", "SYSTEM", "PRINT",
  "RAISE", "RETURN", "GO",
]);

/** No SQL token precedes the word being typed in the current statement. */
export function isBareStatementStart(statementPrefix: string, typedPrefix: string): boolean {
  return tokensBeforeTypedPrefix(statementPrefix, typedPrefix).length === 0;
}

/** `SELECT X AS |` / `FROM T AS |`: the user is naming an alias. */
export function isAliasNamePosition(statementPrefix: string, typedPrefix: string): boolean {
  const tokens = tokensBeforeTypedPrefix(statementPrefix, typedPrefix);
  return tokens[tokens.length - 1]?.tokenType.name === "As";
}

function completesOperand(
  token: IToken,
  previous: IToken | undefined,
  keywordWords: ReadonlySet<string>,
): boolean {
  const name = token.tokenType.name;
  if (name === "Identifier") {
    // Dialect keywords the Netezza lexer does not know (ILIKE, TOP, ...)
    // still expect an operand after them.
    return !keywordWords.has(token.image.toUpperCase());
  }
  if (name === "NumberLiteral") {
    // MSSQL `SELECT TOP 10 |` still expects the first select item.
    return previous?.image.toUpperCase() !== "TOP";
  }
  if (name === "Multiply") {
    // `SELECT * |` / `A.* |` versus the arithmetic `A * |`.
    const previousName = previous?.tokenType.name;
    return previousName === undefined || previousName === "Comma" || previousName === "Dot" || previousName === "Distinct";
  }
  return name === "End" || isExpressionEndingToken(name);
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

  const allowed = clause === "where" || clause === "on" || clause === "having"
    ? [...predicateKeywords(tokensBeforeTypedPrefix(statementPrefix, typedPrefix)), ...CLAUSE_KEYWORD_MAP[clause].filter(keyword => keyword !== "AND" && keyword !== "OR" && keyword !== "NOT")]
    : CLAUSE_KEYWORD_MAP[clause];
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
