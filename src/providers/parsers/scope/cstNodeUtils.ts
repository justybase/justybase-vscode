import { CstNode, type IToken } from "chevrotain";
import { isCstNode, isToken } from "./referenceTokenCollector";

export { isCstNode, isToken };

type NodeRangeCacheEntry =
  | { start: number; end: number }
  | typeof NODE_RANGE_CACHE_MISS;

const NODE_RANGE_CACHE_MISS = Symbol("node-range-cache-miss");

export type NodeRangeCache = WeakMap<CstNode, NodeRangeCacheEntry>;

export function getChildNodesByKey(node: CstNode, key: string): CstNode[] {
  const value = node.children?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((child): child is CstNode => isCstNode(child));
}

export function getChildNodesFlat(node: CstNode): CstNode[] {
  const children: CstNode[] = [];
  const values = node.children ?? {};
  for (const value of Object.values(values)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isCstNode(child)) {
        children.push(child);
      }
    }
  }
  return children;
}

export function getTokensByKey(node: CstNode, key: string): IToken[] {
  const value = node.children?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((child): child is IToken => isToken(child));
}

export function getFirstTokenFromCstNode(
  node: CstNode | undefined,
): IToken | undefined {
  if (!node) {
    return undefined;
  }

  const children = node.children ?? {};
  for (const value of Object.values(children)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isToken(child)) {
        return child;
      }
      if (isCstNode(child)) {
        const nested = getFirstTokenFromCstNode(child);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return undefined;
}

export function getIdentifierTokenByKey(node: CstNode): IToken | undefined {
  const identifierNode = getChildNodesByKey(node, "identifier")[0];
  if (identifierNode) {
    return getFirstTokenFromCstNode(identifierNode);
  }

  return (
    getTokensByKey(node, "Identifier")[0] ??
    getTokensByKey(node, "QuotedIdentifier")[0]
  );
}

export function normalizeTokenText(token: IToken): string {
  if (
    token.image.length >= 2 &&
    token.image.startsWith('"') &&
    token.image.endsWith('"')
  ) {
    return token.image.slice(1, -1);
  }
  return token.image;
}

export function getTokenEndOffset(token: IToken): number {
  const start = token.startOffset ?? 0;
  if (token.endOffset !== undefined) {
    return token.endOffset + 1;
  }
  return start + token.image.length;
}

export function getNodeRange(
  node: CstNode,
  cache: NodeRangeCache,
): { start: number; end: number } | undefined {
  if (cache.has(node)) {
    const cached = cache.get(node)!;
    return cached === NODE_RANGE_CACHE_MISS ? undefined : cached;
  }

  let minStart: number | undefined;
  let maxEnd: number | undefined;
  const children = node.children ?? {};

  for (const value of Object.values(children)) {
    if (!Array.isArray(value)) {
      continue;
    }

    for (const child of value) {
      if (isToken(child)) {
        const start = child.startOffset ?? 0;
        const end = child.endOffset ?? start;
        minStart = minStart === undefined ? start : Math.min(minStart, start);
        maxEnd = maxEnd === undefined ? end : Math.max(maxEnd, end);
        continue;
      }

      if (isCstNode(child)) {
        const nestedRange = getNodeRange(child, cache);
        if (nestedRange) {
          minStart =
            minStart === undefined
              ? nestedRange.start
              : Math.min(minStart, nestedRange.start);
          maxEnd =
            maxEnd === undefined
              ? nestedRange.end
              : Math.max(maxEnd, nestedRange.end);
        }
      }
    }
  }

  const range =
    minStart !== undefined && maxEnd !== undefined
      ? { start: minStart, end: maxEnd }
      : undefined;
  cache.set(node, range ?? NODE_RANGE_CACHE_MISS);
  return range;
}

export function findFirstNodeByName(
  node: CstNode,
  name: string,
): CstNode | undefined {
  if (node.name === name) {
    return node;
  }
  const children = node.children ?? {};
  for (const value of Object.values(children)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isCstNode(child)) {
        const nested = findFirstNodeByName(child, name);
        if (nested) {
          return nested;
        }
      }
    }
  }
  return undefined;
}
