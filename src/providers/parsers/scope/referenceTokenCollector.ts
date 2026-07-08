import { CstNode, type IToken } from "chevrotain";

export function isCstNode(value: unknown): value is CstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "children" in value
  );
}

export function isToken(value: unknown): value is IToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "image" in value &&
    "tokenType" in value
  );
}

/**
 * Recursively collects identifier tokens from netezzaRelaxedName CST nodes,
 * skipping Dot separators. Used by columnReference qualified-name walks.
 */
export function collectOrderedReferenceTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
  tokens: IToken[],
  ignoredKeys: ReadonlySet<string> = new Set(["Dot"]),
): void {
  const children =
    "children" in nodeOrChildren && nodeOrChildren.children
      ? nodeOrChildren.children
      : (nodeOrChildren as Record<string, unknown>);

  for (const [key, value] of Object.entries(children)) {
    if (ignoredKeys.has(key) || !Array.isArray(value)) {
      continue;
    }

    for (const child of value) {
      if (isToken(child)) {
        tokens.push(child);
      } else if (isCstNode(child)) {
        collectOrderedReferenceTokens(child, tokens, ignoredKeys);
      }
    }
  }
}

export function getOrderedReferenceTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
  ignoredKeys?: ReadonlySet<string>,
): IToken[] {
  const tokens: IToken[] = [];
  collectOrderedReferenceTokens(nodeOrChildren, tokens, ignoredKeys);
  return tokens.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
}

/** All lexer tokens under a CST node, including Dot separators. */
export function getOrderedCstTokens(
  nodeOrChildren: CstNode | Record<string, unknown>,
): IToken[] {
  return getOrderedReferenceTokens(nodeOrChildren, new Set());
}
