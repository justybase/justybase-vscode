import type { CstNode, IToken } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import { isIgnorableTrailingDotParserError } from "../sqlParser/parserErrorUtils";
import { parseSqlStatements } from "../sqlParser/parsingRuntime";
import { normalizeQualifierPath } from "./completionQualifierUtils";

/**
 * Shared CST and token helpers used by completion parsing modules.
 */
export function consumeBalancedParentheses(
  tokens: IToken[],
  startIndex: number,
): number | undefined {
  if (tokens[startIndex]?.tokenType.name !== "LParen") {
    return undefined;
  }

  let depth = 1;
  let index = startIndex + 1;
  while (index < tokens.length && depth > 0) {
    const tokenName = tokens[index].tokenType.name;
    if (tokenName === "LParen") {
      depth += 1;
    } else if (tokenName === "RParen") {
      depth -= 1;
    }
    index += 1;
  }

  if (depth > 0) {
    return undefined;
  }
  return index;
}

export function parseSqlToCst(
  sql: string,
  databaseKind?: DatabaseKind,
): CstNode | undefined {
  try {
    const parseResult = parseSqlStatements({
      sql,
      databaseKind,
      ignoreParserError: isIgnorableTrailingDotParserError,
    });
    if (
      parseResult.lexResult.errors.length > 0 ||
      !parseResult.cst ||
      parseResult.actionableParserErrors.length > 0
    ) {
      return undefined;
    }
    return parseResult.cst;
  } catch {
    return undefined;
  }
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

export function getChildNodes(node: CstNode, key: string): CstNode[] {
  const value = node.children?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((child): child is CstNode => isCstNode(child));
}

export function getTokens(node: CstNode, key: string): IToken[] {
  const value = node.children?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((child): child is IToken => isToken(child));
}

export function getFirstTokenFromCst(
  node: CstNode | undefined,
): IToken | undefined {
  if (!node) {
    return undefined;
  }

  const tokens = getOrderedTokens(node);
  return tokens[0];
}

export function getOrderedTokens(node: CstNode): IToken[] {
  const tokens: IToken[] = [];
  const visit = (current: CstNode): void => {
    const children = current.children ?? {};
    for (const value of Object.values(children)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const child of value) {
        if (isToken(child)) {
          tokens.push(child);
        } else if (isCstNode(child)) {
          visit(child);
        }
      }
    }
  };

  visit(node);
  return tokens.sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
}

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

export function isIdentifierToken(token: IToken | undefined): token is IToken {
  if (!token) {
    return false;
  }
  const tokenName = token.tokenType.name;
  return tokenName === "Identifier" || tokenName === "QuotedIdentifier";
}

export function getAliasTokenFromAliasOptional(
  aliasOptionalNode: CstNode | undefined,
): IToken | undefined {
  if (!aliasOptionalNode) {
    return undefined;
  }
  const aliasNode = getChildNodes(aliasOptionalNode, "alias")[0];
  if (!aliasNode) {
    return undefined;
  }
  return getFirstTokenFromCst(aliasNode);
}

export function getNodeTextRange(
  node: CstNode,
): { start: number; end: number } | undefined {
  const tokens = getOrderedTokens(node);
  if (tokens.length === 0) {
    return undefined;
  }

  const start = tokens[0].startOffset ?? 0;
  const lastToken = tokens[tokens.length - 1];
  const endInclusive = lastToken.endOffset ?? start;
  return { start, end: endInclusive + 1 };
}

export function extractQualifierPathBeforeMultiply(
  tokens: IToken[],
  multiplyTokenIndex: number,
): { qualifier: string; startOffset: number } | undefined {
  if (multiplyTokenIndex <= 0) {
    return undefined;
  }

  let chainStart = multiplyTokenIndex - 1;
  while (chainStart >= 0) {
    const token = tokens[chainStart];
    const tokenName = token.tokenType.name;
    if (tokenName === "Dot" || isIdentifierToken(token)) {
      chainStart -= 1;
      continue;
    }
    break;
  }
  chainStart += 1;

  const qualifierTokens = tokens.slice(chainStart, multiplyTokenIndex);
  if (qualifierTokens.length < 2) {
    return undefined;
  }
  if (qualifierTokens[qualifierTokens.length - 1].tokenType.name !== "Dot") {
    return undefined;
  }

  const coreQualifierTokens = qualifierTokens.slice(
    0,
    qualifierTokens.length - 1,
  );
  if (
    coreQualifierTokens.length === 0 ||
    coreQualifierTokens[0].tokenType.name === "Dot"
  ) {
    return undefined;
  }
  if (!coreQualifierTokens.some((token) => isIdentifierToken(token))) {
    return undefined;
  }
  if (
    coreQualifierTokens[coreQualifierTokens.length - 1].tokenType.name ===
    "Dot"
  ) {
    return undefined;
  }

  const qualifier = normalizeQualifierPath(
    coreQualifierTokens.map((token) => token.image).join(""),
  );
  if (!qualifier) {
    return undefined;
  }

  return {
    qualifier,
    startOffset: coreQualifierTokens[0].startOffset ?? 0,
  };
}