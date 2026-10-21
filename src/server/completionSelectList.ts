import type { IToken } from "chevrotain";
import { GROUPING_AGGREGATE_FUNCTIONS } from "@justybase/sql-core/validation";
import { SqlLexer } from "../sqlParser";
import { isIdentifierToken } from "./completionCstUtils";
import { stripQuotes } from "./completionDialectAdapter";

/**
 * Token-based analysis of the top-level SELECT list. It works on the
 * incomplete statement prefix at the cursor, where a full parse is not
 * available.
 */

interface SelectListItem {
  /** Tokens of the item, including nested parentheses. */
  tokens: IToken[];
  /** Depth-0 tokens of the item. */
  top: IToken[];
  /** The item contains a parenthesized expression (call or subquery). */
  hadParens: boolean;
}

function splitTopLevelSelectItems(statementText: string): SelectListItem[] {
  const tokens = SqlLexer.tokenize(statementText).tokens;
  let selectIndex = -1;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i].tokenType.name;
    if (name === "LParen") {
      depth += 1;
    } else if (name === "RParen") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && name === "Select") {
      selectIndex = i;
      break;
    }
  }
  if (selectIndex < 0) {
    return [];
  }

  let end = tokens.length;
  depth = 0;
  for (let i = selectIndex + 1; i < tokens.length; i++) {
    const name = tokens[i].tokenType.name;
    if (name === "LParen") {
      depth += 1;
    } else if (name === "RParen") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && name === "From") {
      end = i;
      break;
    }
  }

  let itemStart = selectIndex + 1;
  // Skip DISTINCT / ALL.
  if (
    itemStart < end &&
    (tokens[itemStart].tokenType.name === "Distinct" ||
      tokens[itemStart].tokenType.name === "All")
  ) {
    itemStart += 1;
  }
  const ranges: { start: number; end: number }[] = [];
  depth = 0;
  for (let i = itemStart; i < end; i++) {
    const name = tokens[i].tokenType.name;
    if (name === "LParen") {
      depth += 1;
    } else if (name === "RParen") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && name === "Comma") {
      ranges.push({ start: itemStart, end: i });
      itemStart = i + 1;
    }
  }
  if (itemStart < end) {
    ranges.push({ start: itemStart, end });
  }

  return ranges.map((range) => {
    const itemTokens = tokens.slice(range.start, range.end);
    const top: IToken[] = [];
    let hadParens = false;
    let itemDepth = 0;
    for (const token of itemTokens) {
      const name = token.tokenType.name;
      if (name === "LParen") {
        itemDepth += 1;
        hadParens = true;
      } else if (name === "RParen") {
        itemDepth = Math.max(0, itemDepth - 1);
      } else if (itemDepth === 0) {
        top.push(token);
      }
    }
    return { tokens: itemTokens, top, hadParens };
  });
}

function isStarItem(top: readonly IToken[]): boolean {
  return (
    (top.length === 1 && top[0].tokenType.name === "Multiply") ||
    (top.length === 3 && top[1].image === "." && top[2].tokenType.name === "Multiply")
  );
}

/** The output alias token of `expr AS alias` / `expr alias`, if any. */
function getItemAliasToken(item: SelectListItem): IToken | undefined {
  const { top, hadParens } = item;
  if (top.length === 0 || isStarItem(top)) {
    return undefined;
  }
  const last = top[top.length - 1];
  if (!isIdentifierToken(last)) {
    return undefined;
  }
  const prev = top.length >= 2 ? top[top.length - 2] : undefined;
  // `expr AS alias`, bare `expr alias` (`CUSTOMER_ID CID`, `COUNT(*) N`),
  // or `(scalar subquery) alias`.
  if (
    prev?.tokenType.name === "As" ||
    (top.length >= 2 && (isIdentifierToken(prev) || hadParens))
  ) {
    return last;
  }
  return undefined;
}

/**
 * Output aliases of the top-level SELECT list of the current statement.
 * Live Netezza (Release 11.2.2.1, verified 2026-10-11) resolves SELECT
 * aliases in HAVING (`HAVING N > 0` over `COUNT(*) AS N`) and ORDER BY.
 */
export function extractSelectOutputAliases(statementPrefix: string): string[] {
  const aliases: string[] = [];
  for (const item of splitTopLevelSelectItems(statementPrefix)) {
    const aliasToken = getItemAliasToken(item);
    const alias = aliasToken ? stripQuotes(aliasToken.image.trim()) : "";
    if (alias && alias !== "*" && !aliases.some((a) => a.toUpperCase() === alias.toUpperCase())) {
      aliases.push(alias);
    }
  }
  return aliases;
}

/** Item calls a grouping aggregate (`SUM(x)`), or any function with `OVER (...)`. */
function containsAggregateOrWindow(tokens: readonly IToken[]): boolean {
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (tokens[index + 1].tokenType.name !== "LParen") {
      continue;
    }
    if (GROUPING_AGGREGATE_FUNCTIONS.has(tokens[index].image.toUpperCase())) {
      return true;
    }
  }
  return tokens.some((token) => token.tokenType.name === "Over");
}

const LITERAL_TOKENS = new Set(["NumberLiteral", "StringLiteral", "Null", "Minus", "Plus"]);

/**
 * SELECT expressions (without output aliases) that must appear in GROUP BY
 * when the list also contains an aggregate. Returns an empty list when the
 * SELECT list has no grouping aggregate or nothing to group.
 */
export function extractGroupableSelectExpressions(statementText: string): string[] {
  const items = splitTopLevelSelectItems(statementText);
  let hasAggregate = false;
  const expressions: string[] = [];
  for (const item of items) {
    if (item.top.length === 0 || isStarItem(item.top)) {
      continue;
    }
    const aliasToken = getItemAliasToken(item);
    let expressionTokens = item.tokens;
    if (aliasToken) {
      const aliasIndex = item.tokens.indexOf(aliasToken);
      const cut = item.tokens[aliasIndex - 1]?.tokenType.name === "As" ? aliasIndex - 1 : aliasIndex;
      expressionTokens = item.tokens.slice(0, cut);
    }
    if (expressionTokens.length === 0) {
      continue;
    }
    if (containsAggregateOrWindow(expressionTokens)) {
      hasAggregate = hasAggregate || !expressionTokens.some((token) => token.tokenType.name === "Over");
      continue;
    }
    if (expressionTokens.every((token) => LITERAL_TOKENS.has(token.tokenType.name))) {
      continue;
    }
    const first = expressionTokens[0];
    const last = expressionTokens[expressionTokens.length - 1];
    const text = statementText
      .slice(first.startOffset, last.startOffset + last.image.length)
      .replace(/\s+/g, " ")
      .trim();
    if (text && !expressions.some((existing) => existing.toUpperCase() === text.toUpperCase())) {
      expressions.push(text);
    }
  }
  return hasAggregate ? expressions : [];
}
