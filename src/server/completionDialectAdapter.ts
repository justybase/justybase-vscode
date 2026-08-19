import type { CstNode, IToken } from "chevrotain";
import type { DatabaseKind } from "../contracts/database";
import {
  supportsDoubleDotPath,
  supportsThreePartPath,
  usesDatabaseObjectTwoPartName,
} from "./completionPathUtils";
import { getChildNodes, getFirstTokenFromCst, getTokens, isIdentifierToken } from "./completionCstUtils";
import type { FromJoinContext, QualifiedTableName } from "./completionTypes";
import {
  createNetezzaUserIdentifier,
  formatNetezzaIdentifier,
} from "../dialects/netezza/metadata/identifierUtils";

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
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).replace(/``/g, "`");
  }
  if (trimmed.endsWith("`")) {
    return trimmed.slice(0, -1);
  }
  if (trimmed.startsWith('"')) {
    const unquoted = trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed.slice(1);
    return unquoted.replace(/""/g, '"');
  }
  if (trimmed.endsWith('"')) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

interface ParsedIdentifierSegment {
  value: string;
  quoted: boolean;
}

function parseIdentifierSegment(raw: string): ParsedIdentifierSegment {
  const trimmed = raw.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.length > 1) ||
    trimmed.startsWith('`') ||
    trimmed.startsWith('[');
  return { value: stripQuotes(trimmed), quoted };
}

function splitQualifiedPath(fragment: string): {
  parts: string[];
  hasUnquotedWhitespace: boolean;
} {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '`' | '[' | undefined;
  let hasUnquotedWhitespace = false;

  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (quote) {
      current += char;
      if ((quote === '"' || quote === '`') && char === quote) {
        const next = fragment[index + 1];
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (quote === '[' && char === ']') {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === '`' || char === '[') {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      hasUnquotedWhitespace = true;
    }
    if (char === '.') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { parts, hasUnquotedWhitespace };
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

export function formatNetezzaUserIdentifierForLookup(
  value: string,
  quoted = false,
): string {
  return formatNetezzaIdentifier(createNetezzaUserIdentifier(value, quoted));
}

export function normalizeNetezzaFromJoinContext(
  context: FromJoinContext,
): FromJoinContext {
  if (context.kind === "from_join_name") {
    return context;
  }
  if (context.kind === "db_schema_dot") {
    return {
      ...context,
      dbName: formatNetezzaUserIdentifierForLookup(context.dbName, context.dbQuoted),
      schemaName: formatNetezzaUserIdentifierForLookup(context.schemaName, context.schemaQuoted),
    };
  }
  return {
    ...context,
    dbName: formatNetezzaUserIdentifierForLookup(context.dbName, context.dbQuoted),
  };
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

  // File SQL workspace views use normalized absolute paths as identifiers,
  // e.g. "/home/user/data.xlsx#sheet=Orders". Dots in a filesystem path
  // must not be interpreted as database/schema separators.
  const unquotedFragment = stripQuotes(fragment);
  const isQuoted =
    fragment.startsWith('"') || fragment.startsWith('`') || fragment.startsWith('[');
  if (
    fragment.includes("/") ||
    fragment.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(unquotedFragment)
  ) {
    return {
      kind: "from_join_name",
      partial: unquotedFragment,
      isFilePath: true,
      isQuoted,
    };
  }

  const { parts, hasUnquotedWhitespace } = splitQualifiedPath(fragment);
  if (hasUnquotedWhitespace) {
    return undefined;
  }

  const hasDoubleDot = parts.length === 3 && parts[1] === '';
  if (hasDoubleDot) {
    if (!supportsDoubleDotPath(databaseKind)) {
      return undefined;
    }
    const database = parseIdentifierSegment(parts[0]);
    const table = parseIdentifierSegment(parts[2] ?? '');
    return {
      kind: "db_double_dot",
      dbName: database.value,
      partial: table.value,
      ...(database.quoted ? { dbQuoted: true } : {}),
      ...(table.quoted ? { partialQuoted: true } : {}),
    };
  }

  if (parts.length === 2) {
    const database = parseIdentifierSegment(parts[0]);
    const table = parseIdentifierSegment(parts[1] ?? '');
    return {
      kind: "db_dot",
      dbName: database.value,
      partial: table.value,
      ...(database.quoted ? { dbQuoted: true } : {}),
      ...(table.quoted ? { partialQuoted: true } : {}),
    };
  }

  if (parts.length >= 3) {
    const database = parseIdentifierSegment(parts[0]);
    const schema = parseIdentifierSegment(parts[1]);
    const table = parseIdentifierSegment(parts.slice(2).join("."));
    return {
      kind: "db_schema_dot",
      dbName: database.value,
      schemaName: schema.value,
      partial: table.value,
      ...(database.quoted ? { dbQuoted: true } : {}),
      ...(schema.quoted ? { schemaQuoted: true } : {}),
      ...(table.quoted ? { partialQuoted: true } : {}),
    };
  }

  const identifier = parseIdentifierSegment(fragment);
  return identifier.quoted
    ? { kind: "from_join_name", partial: identifier.value, isQuoted: true }
    : { kind: "from_join_name", partial: identifier.value };
}

export function parseQualifiedTableNameFromTokens(
  tokens: IToken[],
  startIndex: number,
  databaseKind?: DatabaseKind,
): { tableRef: QualifiedTableName; nextIndex: number } | undefined {
  if (!isIdentifierToken(tokens[startIndex])) {
    return undefined;
  }

  const identifiers: ParsedIdentifierSegment[] = [parseIdentifierSegment(tokens[startIndex].image)];
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

    identifiers.push(parseIdentifierSegment(tokens[index].image));
    index += 1;
  }

  if (identifiers.length === 1) {
    return {
      tableRef: identifiers[0].quoted
        ? { table: identifiers[0].value, tableQuoted: true }
        : { table: identifiers[0].value },
      nextIndex: index,
    };
  }

  if (identifiers.length === 2) {
    if (dotCount >= 2) {
      return {
        tableRef: {
          database: identifiers[0].value,
          table: identifiers[1].value,
          ...(identifiers[0].quoted ? { databaseQuoted: true } : {}),
          ...(identifiers[1].quoted ? { tableQuoted: true } : {}),
        },
        nextIndex: index,
      };
    }
    return {
      tableRef: {
        schema: identifiers[0].value,
        table: identifiers[1].value,
        ...(identifiers[0].quoted ? { schemaQuoted: true } : {}),
        ...(identifiers[1].quoted ? { tableQuoted: true } : {}),
      },
      nextIndex: index,
    };
  }

  if (!supportsThreePartPath(databaseKind)) {
    return undefined;
  }

  return {
    tableRef: {
      database: identifiers[0].value,
      schema: identifiers[1].value,
      table: identifiers[identifiers.length - 1].value,
      ...(identifiers[0].quoted ? { databaseQuoted: true } : {}),
      ...(identifiers[1].quoted ? { schemaQuoted: true } : {}),
      ...(identifiers[identifiers.length - 1].quoted ? { tableQuoted: true } : {}),
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

  const identifiers = identifierTokens.map((token) => parseIdentifierSegment(token.image));
  const dotCount = getTokens(qualifiedNameNode, "Dot").length;

  if (identifiers.length === 1) {
    return { table: identifiers[0].value, tableQuoted: identifiers[0].quoted };
  }

  if (identifiers.length === 2) {
    if (dotCount === 2) {
      if (!supportsDoubleDotPath(databaseKind)) {
        return undefined;
      }
      return {
        database: identifiers[0].value,
        table: identifiers[1].value,
        databaseQuoted: identifiers[0].quoted,
        tableQuoted: identifiers[1].quoted,
      };
    }
    if (usesDatabaseObjectTwoPartName(databaseKind)) {
      return {
        database: identifiers[0].value,
        table: identifiers[1].value,
        databaseQuoted: identifiers[0].quoted,
        tableQuoted: identifiers[1].quoted,
      };
    }
    return {
      schema: identifiers[0].value,
      table: identifiers[1].value,
      schemaQuoted: identifiers[0].quoted,
      tableQuoted: identifiers[1].quoted,
    };
  }

  if (!supportsThreePartPath(databaseKind)) {
    return undefined;
  }

  return {
    database: identifiers[0].value,
    schema: identifiers[1].value,
    table: identifiers[identifiers.length - 1].value,
    databaseQuoted: identifiers[0].quoted,
    schemaQuoted: identifiers[1].quoted,
    tableQuoted: identifiers[identifiers.length - 1].quoted,
  };
}
