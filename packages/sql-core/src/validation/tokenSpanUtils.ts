import type { CstNode, IToken } from "chevrotain";
import { getOrderedCstTokens } from "./referenceTokenCollector";
import type { TokenPosition } from "./types";

export function getTokenSpanPositionFromEndpoints(first: IToken, last: IToken): TokenPosition {
  const startColumn = first.startColumn ?? 1;
  const startOffset = first.startOffset ?? 0;
  const endOffset = (last.startOffset ?? 0) + (last.image?.length ?? 0);
  return {
    startLine: first.startLine ?? 1,
    startColumn,
    endLine: last.endLine ?? last.startLine ?? 1,
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
