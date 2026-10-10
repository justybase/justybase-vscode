import type { CstNode, IToken } from "chevrotain";

function isToken(value: unknown): value is IToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "image" in value &&
    "tokenType" in value
  );
}

function isCstNode(value: unknown): value is CstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "children" in value
  );
}

/** Every token below the given CST nodes, in source order. */
export function collectCstTokens(
  nodes: readonly CstNode[] | undefined,
): IToken[] {
  const tokens: IToken[] = [];
  const visit = (node: CstNode): void => {
    for (const value of Object.values(node.children ?? {})) {
      if (!Array.isArray(value)) continue;
      for (const child of value) {
        if (isToken(child)) tokens.push(child);
        else if (isCstNode(child)) visit(child);
      }
    }
  };
  for (const node of nodes ?? []) visit(node);
  return tokens.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
}

export function unquoteIdentifier(image: string): string {
  return image.length >= 2 && image.startsWith('"') && image.endsWith('"')
    ? image.slice(1, -1).replace(/""/g, '"')
    : image;
}
