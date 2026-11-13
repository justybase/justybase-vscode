import { CstNode, type IToken } from "chevrotain";
import { hasUnavailableTokenLocation } from "./tokenLocation";

export function isCstNode(value: unknown): value is CstNode {
  return typeof value === "object" && value !== null && "name" in value && "children" in value;
}

export function isToken(value: unknown): value is IToken {
  return typeof value === "object" && value !== null && "image" in value && "tokenType" in value;
}

const DEFAULT_IGNORED_KEYS: ReadonlySet<string> = new Set(["Dot"]);
const EMPTY_IGNORED_KEYS: ReadonlySet<string> = new Set();

export function collectOrderedReferenceTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
  tokens: IToken[],
  ignoredKeys: ReadonlySet<string> = DEFAULT_IGNORED_KEYS,
): void {
  const children = "children" in nodeOrChildren && nodeOrChildren.children
    ? nodeOrChildren.children
    : nodeOrChildren;
  for (const key in children) {
    if (ignoredKeys.has(key)) continue;
    const value = (children as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (isToken(child) && !hasUnavailableTokenLocation(child.startOffset)) {
        tokens.push(child);
      }
      else if (isCstNode(child)) collectOrderedReferenceTokens(child, tokens, ignoredKeys);
    }
  }
}

export function getOrderedReferenceTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
  ignoredKeys?: ReadonlySet<string>,
): IToken[] {
  const tokens: IToken[] = [];
  collectOrderedReferenceTokens(nodeOrChildren, tokens, ignoredKeys);
  return tokens.length > 1
    ? tokens.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0))
    : tokens;
}

export function getOrderedCstTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
): IToken[] {
  return getOrderedReferenceTokens(nodeOrChildren, EMPTY_IGNORED_KEYS);
}
