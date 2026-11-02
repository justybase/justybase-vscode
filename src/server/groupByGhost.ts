import type { IToken } from "chevrotain";
import { extractGroupableSelectExpressions } from "./completionSelectList";
import { cursorStatementTokens } from "./ghostStatementTokens";

/**
 * Ghost text after `GROUP BY `: every non-aggregated expression of the
 * SELECT at the same parenthesis level, in SELECT order. Nothing is offered
 * before other text on the line, without an aggregate in that SELECT, or when the list cannot be
 * derived; the text is the same as the `GROUP BY` completion item.
 */
export function detectGroupByGhost(textBefore: string, textAfter: string): string | undefined {
  // Only auto-closed parentheses or a semicolon may follow on the line.
  if (!/\s$/u.test(textBefore) || !/^[\s);]*$/u.test(textAfter.split(/\r?\n/u, 1)[0])) {
    return undefined;
  }
  const statement = cursorStatementTokens(textBefore);
  if (!statement) {
    return undefined;
  }
  const { tokens, text } = statement;
  const groupIndex = groupByStart(tokens);
  if (groupIndex < 0) {
    return undefined;
  }
  const select = selectAtCursorLevel(tokens, groupIndex);
  if (!select) {
    return undefined;
  }
  const expressions = extractGroupableSelectExpressions(
    text.slice(select.startOffset, tokens[groupIndex].startOffset),
  );
  return expressions.length > 0 ? expressions.join(", ") : undefined;
}

/** Index of `GROUP` (or `GROUP BY`) when the statement ends with it, else -1. */
function groupByStart(tokens: readonly IToken[]): number {
  const last = tokens.length - 1;
  if (tokens[last]?.tokenType.name === "GroupBy") {
    return last;
  }
  return tokens[last]?.tokenType.name === "By" && tokens[last - 1]?.tokenType.name === "Group" ? last - 1 : -1;
}

/** The last SELECT before `end` at the nesting level of `end`. */
function selectAtCursorLevel(tokens: readonly IToken[], end: number): IToken | undefined {
  const openParens: number[] = [];
  for (let index = 0; index < end; index += 1) {
    const name = tokens[index].tokenType.name;
    if (name === "LParen") openParens.push(index);
    else if (name === "RParen") openParens.pop();
  }
  const scopeStart = openParens.length > 0 ? openParens[openParens.length - 1] + 1 : 0;
  let depth = 0;
  let found: IToken | undefined;
  for (let index = scopeStart; index < end; index += 1) {
    const name = tokens[index].tokenType.name;
    if (name === "LParen") depth += 1;
    else if (name === "RParen") depth -= 1;
    else if (depth === 0 && name === "Select") found = tokens[index];
  }
  return found;
}
