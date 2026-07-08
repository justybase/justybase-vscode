import type { DatabaseKind } from "../contracts/database";
import {
  supportsDoubleDotPath,
  usesDatabaseObjectTwoPartName,
} from "./completionPathUtils";

export interface WildcardTableSource {
  db?: string;
  schema?: string;
  table: string;
}

export function normalizeQualifierPath(rawPath: string): string {
  if (!rawPath) {
    return "";
  }

  const normalizedParts = rawPath
    .split(".")
    .map((part) => (part === "" ? "" : stripQualifierQuotes(part)));

  return normalizedParts.join(".");
}

export function parseQualifierPathToSource(
  qualifier: string,
  databaseKind?: DatabaseKind,
): WildcardTableSource | undefined {
  const normalizedQualifier = normalizeQualifierPath(qualifier);
  if (!normalizedQualifier) {
    return undefined;
  }

  const parts = normalizedQualifier.split(".");
  if (parts.length === 1) {
    return parts[0] ? { table: parts[0] } : undefined;
  }

  if (parts.length === 2) {
    if (!parts[0] || !parts[1]) {
      return undefined;
    }
    if (usesDatabaseObjectTwoPartName(databaseKind)) {
      return { db: parts[0], table: parts[1] };
    }
    return { schema: parts[0], table: parts[1] };
  }

  const table = parts[parts.length - 1];
  const database = parts[0];
  if (!table || !database) {
    return undefined;
  }

  if (parts.length === 3 && parts[1] === "") {
    if (!supportsDoubleDotPath(databaseKind)) {
      return undefined;
    }
    return { db: database, table };
  }

  const schema = parts[1];
  if (!schema) {
    return { db: database, table };
  }

  return { db: database, schema, table };
}

export function dedupeWildcardSources(
  sources: WildcardTableSource[],
): WildcardTableSource[] {
  const seen = new Set<string>();
  const deduped: WildcardTableSource[] = [];
  for (const source of sources) {
    const key = `${(source.db || "").toUpperCase()}|${(source.schema || "").toUpperCase()}|${source.table.toUpperCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

function stripQualifierQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith("[") &&
    trimmed.endsWith("]")
  ) {
    return trimmed.slice(1, -1);
  }
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"')
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}