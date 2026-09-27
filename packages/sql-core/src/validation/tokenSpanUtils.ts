import type { CstNode, IToken } from "chevrotain";
import { getOrderedCstTokens } from "./referenceTokenCollector";
import type { TokenPosition } from "./types";
import { getAvailableTokenLocation, getTokenLocationOr } from "./tokenLocation";

export function getTokenSpanPositionFromEndpoints(first: IToken, last: IToken): TokenPosition {
  const startColumn = getTokenLocationOr(first.startColumn, 1);
  const startOffset = getTokenLocationOr(first.startOffset, 0);
  const endOffset =
    (getAvailableTokenLocation(last.startOffset) ?? startOffset) +
    (last.image?.length ?? 0);
  return {
    startLine: getTokenLocationOr(first.startLine, 1),
    startColumn,
    endLine: getTokenLocationOr(
      last.endLine,
      getTokenLocationOr(last.startLine, getTokenLocationOr(first.startLine, 1)),
    ),
    endColumn: startColumn + (endOffset - startOffset),
    offset: startOffset,
  };
}

export function getCstNodeTokenSpan(node: CstNode): TokenPosition | undefined {
  const tokens = getOrderedCstTokens(node);
  return tokens.length === 0
    ? undefined
    : getTokenSpanPositionFromEndpoints(tokens[0], tokens[tokens.length - 1]);
}
