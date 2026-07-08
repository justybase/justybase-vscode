import type { DatabaseKind } from "../contracts/database";
import { parseTablePathFragment } from "./completionDialectAdapter";
import { stripQuotes } from "./completionDialectAdapter";

export type CatalogObjectKind = "table" | "view" | "procedure";

export interface CatalogObjectRef {
  kind: CatalogObjectKind;
  database?: string;
  schema?: string;
  name: string;
  startOffset: number;
  endOffset: number;
}

const CATALOG_URI_SCHEME = "netezza-catalog";
export const CATALOG_DDL_URI_PATH = "/ddl";

export function buildCatalogDdlQuery(
  object: CatalogObjectRef,
  documentUri: string,
): string {
  const params = new URLSearchParams({
    kind: object.kind,
    name: object.name,
    source: documentUri,
  });
  if (object.database) {
    params.set("database", object.database);
  }
  if (object.schema) {
    params.set("schema", object.schema);
  }
  return params.toString();
}

export function buildCatalogDdlUri(
  object: CatalogObjectRef,
  documentUri: string,
): string {
  return `${CATALOG_URI_SCHEME}:${CATALOG_DDL_URI_PATH}?${buildCatalogDdlQuery(object, documentUri)}`;
}

export function parseCatalogDdlQuery(query: string): {
  kind: CatalogObjectKind;
  database?: string;
  schema?: string;
  name: string;
  sourceDocumentUri?: string;
} | undefined {
  const params = new URLSearchParams(query);
  const kind = params.get("kind");
  const name = params.get("name");
  if (!kind || !name) {
    return undefined;
  }
  if (kind !== "table" && kind !== "view" && kind !== "procedure") {
    return undefined;
  }
  return {
    kind,
    database: params.get("database") ?? undefined,
    schema: params.get("schema") ?? undefined,
    name,
    sourceDocumentUri: params.get("source") ?? undefined,
  };
}

export function parseCatalogDdlUri(uri: string): {
  kind: CatalogObjectKind;
  database?: string;
  schema?: string;
  name: string;
  sourceDocumentUri?: string;
} | undefined {
  if (!uri.startsWith(`${CATALOG_URI_SCHEME}:`)) {
    return undefined;
  }

  const queryStart = uri.indexOf("?");
  if (queryStart < 0) {
    return undefined;
  }

  return parseCatalogDdlQuery(uri.slice(queryStart + 1));
}

/**
 * Resolve a catalog object reference at the given offset.
 * Supports qualified names and unqualified table names in FROM/JOIN context.
 */
export function resolveCatalogObjectAtOffset(
  sql: string,
  offset: number,
  databaseKind?: DatabaseKind,
  effectiveDatabase?: string,
  effectiveSchema?: string,
): CatalogObjectRef | undefined {
  const identifier = extractIdentifierAtOffset(sql, offset);
  if (!identifier) {
    return undefined;
  }

  const parsed = parseTablePathFragment(identifier.text, databaseKind);
  if (!parsed) {
    return undefined;
  }

  if (
    parsed.kind === "db_dot" ||
    parsed.kind === "db_schema_dot" ||
    parsed.kind === "db_double_dot"
  ) {
    const name =
      parsed.partial ||
      (parsed.kind === "db_double_dot"
        ? identifier.text.split("..").pop()
        : identifier.text.split(".").pop()) ||
      "";
    if (!name) {
      return undefined;
    }
    return {
      kind: inferCatalogKindFromContext(sql, identifier.startOffset),
      database: parsed.dbName,
      schema: parsed.kind === "db_schema_dot" ? parsed.schemaName : undefined,
      name: stripQuotes(name),
      startOffset: identifier.startOffset,
      endOffset: identifier.endOffset,
    };
  }

  if (parsed.kind === "from_join_name") {
    const parts = identifier.text.split(".").map((part) => stripQuotes(part));
    const name = parts[parts.length - 1] ?? "";
    if (!name) {
      return undefined;
    }
    const doubleDotDatabase = resolveDatabaseFromDoubleDotPrefix(
      sql,
      identifier.startOffset,
    );
    const schema =
      doubleDotDatabase || parts.length < 2
        ? undefined
        : parts[parts.length - 2];
    return {
      kind: inferCatalogKindFromContext(sql, identifier.startOffset),
      database: doubleDotDatabase ?? effectiveDatabase,
      schema: schema ?? (doubleDotDatabase ? undefined : effectiveSchema),
      name,
      startOffset: identifier.startOffset,
      endOffset: identifier.endOffset,
    };
  }

  return undefined;
}

function inferCatalogKindFromContext(
  sql: string,
  identifierStart: number,
): CatalogObjectKind {
  const prefix = sql.slice(0, identifierStart).toUpperCase();
  if (/\b(CALL|EXEC|EXECUTE)\s+[\w".]*$/i.test(prefix.slice(-80))) {
    return "procedure";
  }
  return "table";
}

function resolveDatabaseFromDoubleDotPrefix(
  sql: string,
  identifierStart: number,
): string | undefined {
  const prefix = sql.slice(0, identifierStart);
  const match = prefix.match(/([\w"]+)\.\.\s*$/i);
  return match ? stripQuotes(match[1]) : undefined;
}

function extractIdentifierAtOffset(
  sql: string,
  offset: number,
): { text: string; startOffset: number; endOffset: number } | undefined {
  // Allow empty segments so DB..TABLE matches (same pattern as documentLinkProvider).
  const qualifiedPattern = /[\w"\u00c0-\u024f]+(\.[\w"\u00c0-\u024f]*)+/g;
  let match: RegExpExecArray | null;
  while ((match = qualifiedPattern.exec(sql)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return { text: match[0], startOffset: start, endOffset: end };
    }
  }

  const singlePattern = /[\w"\u00c0-\u024f]+/g;
  while ((match = singlePattern.exec(sql)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      if (isCatalogObjectContext(sql, start)) {
        return { text: match[0], startOffset: start, endOffset: end };
      }
      return undefined;
    }
  }

  return undefined;
}

function isCatalogObjectContext(sql: string, identifierStart: number): boolean {
  const prefix = sql.slice(0, identifierStart);
  return /\b(FROM|JOIN|INTO|TABLE|VIEW|UPDATE|CALL|EXEC(?:UTE)?)\s+[\w".]*$/i.test(
    prefix.slice(-120),
  );
}

/**
 * Build regex patterns to find catalog object usages across workspace SQL files.
 */
export function buildCatalogUsageSearchPatterns(
  object: CatalogObjectRef,
): RegExp[] {
  const patterns: RegExp[] = [];
  const escapedName = escapeRegExp(object.name);
  const db = object.database ? escapeRegExp(object.database) : undefined;
  const schema = object.schema ? escapeRegExp(object.schema) : undefined;

  if (db && schema) {
    patterns.push(
      new RegExp(`\\b${db}\\.${schema}\\.${escapedName}\\b`, "gi"),
      new RegExp(`\\b${db}\\.\\.${escapedName}\\b`, "gi"),
    );
  } else if (schema) {
    patterns.push(new RegExp(`\\b${schema}\\.${escapedName}\\b`, "gi"));
  } else if (db) {
    patterns.push(
      new RegExp(`\\b${db}\\.\\.${escapedName}\\b`, "gi"),
      new RegExp(`\\b${db}\\.[\\w"]+\\.${escapedName}\\b`, "gi"),
    );
  }

  patterns.push(new RegExp(`\\b${escapedName}\\b`, "gi"));
  return patterns;
}

export function findCatalogUsagesInText(
  text: string,
  patterns: RegExp[],
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return matches;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect CALL/EXEC procedure argument list context for completion.
 */
export function parseCallArgumentContext(
  statementPrefix: string,
  _databaseKind?: DatabaseKind,
): { procedureName: string; argIndex: number; database?: string; schema?: string } | undefined {
  const callMatch = statementPrefix.match(
    /\b(?:CALL|EXEC(?:UTE)?)\s+([\w".]+)\s*\(/i,
  );
  if (!callMatch) {
    return undefined;
  }

  const procPath = callMatch[1] ?? "";
  const openParenIndex = statementPrefix.lastIndexOf("(");
  if (openParenIndex < 0) {
    return undefined;
  }

  const argsSection = statementPrefix.slice(openParenIndex + 1);
  const argIndex = argsSection.split(",").length - 1;

  const procParts = procPath.split(".").map((part) => stripQuotes(part));
  const procedureName = procParts[procParts.length - 1] ?? "";
  if (!procedureName) {
    return undefined;
  }

  let database: string | undefined;
  let schema: string | undefined;
  if (procParts.length === 3) {
    database = procParts[0];
    schema = procParts[1];
  } else if (procParts.length === 2) {
    schema = procParts[0];
  }

  return { procedureName, argIndex, database, schema };
}
