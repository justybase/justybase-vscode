import type { CstNode, IToken } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import { supportsDoubleDotPath, usesDatabaseObjectTwoPartName } from "./completionPathUtils";
import { getChildNodes, getFirstTokenFromCst, getTokens, isIdentifierToken } from "./completionCstUtils";
import type { FromJoinContext, QualifiedTableName } from "./completionTypes";

/**
 * Dialect-aware identifier normalization and qualified-name parsing.
 */
export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    return trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed.slice(1);
  }
  if (trimmed.endsWith("]")) {
    return trimmed.slice(0, -1);
  }
  if (trimmed.startsWith('"')) {
    return trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed.slice(1);
  }
  if (trimmed.endsWith('"')) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function normalizeDialectQuotedIdentifiers(
  sql: string,
  databaseKind?: DatabaseKind,
): string {
  let normalizedSql = sql.replace(/\[([^\]\r\n]*)\]/g, (_match, inner: string) => {
    const safeInner = inner.replace(/"/g, "_");
    return `"${safeInner}"`;
  });

  if (databaseKind === "mysql") {
    normalizedSql = normalizedSql.replace(/`([^`\r\n]*)`/g, (_match, inner: string) => {
      const safeInner = inner.replace(/"/g, "_");
      return `"${safeInner}"`;
    });
  }

  return normalizedSql;
}

export function parseTablePathFragment(
  fragmentRaw: string,
  databaseKind?: DatabaseKind,
): FromJoinContext | undefined {
  const hasTrailingWhitespace = /\s$/.test(fragmentRaw);
  const fragment = fragmentRaw.trim();
  if (fragment.length === 0) {
    return { kind: "from_join_name", partial: "" };
  }

  if (hasTrailingWhitespace) {
    return undefined;
  }

  if (
    fragment.includes(" ") ||
    fragment.includes("\n") ||
    fragment.includes("\r") ||
    fragment.includes("\t")
  ) {
    return undefined;
  }

  const doubleDotIndex = fragment.indexOf("..");
  if (doubleDotIndex > 0) {
    if (!supportsDoubleDotPath(databaseKind)) {
      return undefined;
    }
    const dbName = stripQuotes(fragment.substring(0, doubleDotIndex));
    const partial = stripQuotes(fragment.substring(doubleDotIndex + 2));
    return { kind: "db_double_dot", dbName, partial };
  }

  const dotParts = fragment.split(".");
  if (dotParts.length === 2) {
    const dbName = stripQuotes(dotParts[0]);
    const partial = stripQuotes(dotParts[1] ?? "");
    return { kind: "db_dot", dbName, partial };
  }

  if (dotParts.length >= 3) {
    const dbName = stripQuotes(dotParts[0]);
    const schemaName = stripQuotes(dotParts[1]);
    const partial = stripQuotes(dotParts.slice(2).join("."));
    return { kind: "db_schema_dot", dbName, schemaName, partial };
  }

  return { kind: "from_join_name", partial: stripQuotes(fragment) };
}

export function parseQualifiedTableNameFromTokens(
  tokens: IToken[],
  startIndex: number,
): { tableRef: QualifiedTableName; nextIndex: number } | undefined {
  if (!isIdentifierToken(tokens[startIndex])) {
    return undefined;
  }

  const names: string[] = [stripQuotes(tokens[startIndex].image)];
  let dotCount = 0;
  let index = startIndex + 1;

  while (index < tokens.length && tokens[index].tokenType.name === "Dot") {
    dotCount += 1;
    index += 1;

    if (index < tokens.length && tokens[index].tokenType.name === "Dot") {
      dotCount += 1;
      index += 1;
    }

    if (!isIdentifierToken(tokens[index])) {
      break;
    }

    names.push(stripQuotes(tokens[index].image));
    index += 1;
  }

  if (names.length === 1) {
    return { tableRef: { table: names[0] }, nextIndex: index };
  }

  if (names.length === 2) {
    if (dotCount >= 2) {
      return {
        tableRef: { database: names[0], table: names[1] },
        nextIndex: index,
      };
    }
    return {
      tableRef: { schema: names[0], table: names[1] },
      nextIndex: index,
    };
  }

  return {
    tableRef: {
      database: names[0],
      schema: names[1],
      table: names[names.length - 1],
    },
    nextIndex: index,
  };
}

export function parseQualifiedTableName(
  qualifiedNameNode: CstNode | undefined,
  databaseKind?: DatabaseKind,
): QualifiedTableName | undefined {
  if (!qualifiedNameNode) {
    return undefined;
  }

  const identifierTokens = getChildNodes(qualifiedNameNode, "identifier")
    .map((node) => getFirstTokenFromCst(node))
    .filter((token): token is IToken => !!token);
  if (identifierTokens.length === 0) {
    return undefined;
  }

  const names = identifierTokens.map((token) => stripQuotes(token.image));
  const dotCount = getTokens(qualifiedNameNode, "Dot").length;

  if (names.length === 1) {
    return { table: names[0] };
  }

  if (names.length === 2) {
    if (dotCount === 2) {
      if (!supportsDoubleDotPath(databaseKind)) {
        return undefined;
      }
      return { database: names[0], table: names[1] };
    }
    if (usesDatabaseObjectTwoPartName(databaseKind)) {
      return { database: names[0], table: names[1] };
    }
    return { schema: names[0], table: names[1] };
  }

  return {
    database: names[0],
    schema: names[1],
    table: names[names.length - 1],
  };
}
