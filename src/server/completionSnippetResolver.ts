import * as fs from "fs";
import * as path from "path";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  Position,
} from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import { isStatementStartPosition } from "./completionExpressionAnalyzer";
import { matchesPrefix } from "./completionRanker";
import { applyPrefixRange } from "./completionRenderer";

/**
 * Dialect snippets served by the language server instead of a static
 * `contributes.snippets` entry, so they appear only for the active dialect and
 * only where a new statement can start.
 */

interface SnippetDefinition {
  prefix: string | string[];
  body: string | string[];
  description?: string;
}

interface DialectSnippet {
  name: string;
  prefixes: readonly string[];
  body: string;
  description?: string;
}

const SNIPPET_FILE_BY_KIND: Partial<Record<DatabaseKind, string>> = {
  netezza: "netezza",
  oracle: "oracle",
  db2: "db2",
  mssql: "mssql",
  duckdb: "duckdb",
  file: "duckdb",
  sqlite: "sqlite",
  clickhouse: "clickhouse",
  postgresql: "postgresql",
};

// Both the bundled server (dist/server/main.js) and the TypeScript sources
// (src/server) sit two levels below the extension root.
const DEFAULT_DIALECTS_ROOT = path.resolve(__dirname, "..", "..", "dialects");

const snippetCache = new Map<string, readonly DialectSnippet[]>();

export function loadDialectSnippets(
  databaseKind: DatabaseKind | undefined,
  dialectsRoot = DEFAULT_DIALECTS_ROOT,
): readonly DialectSnippet[] {
  const dialect = SNIPPET_FILE_BY_KIND[databaseKind ?? "netezza"];
  if (!dialect) {
    return [];
  }
  const file = path.join(dialectsRoot, dialect, "snippets", `${dialect}.code-snippets`);
  const cached = snippetCache.get(file);
  if (cached) {
    return cached;
  }
  let snippets: DialectSnippet[] = [];
  try {
    const definitions = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SnippetDefinition>;
    snippets = Object.entries(definitions).map(([name, definition]) => ({
      name,
      prefixes: Array.isArray(definition.prefix) ? definition.prefix : [definition.prefix],
      body: Array.isArray(definition.body) ? definition.body.join("\n") : definition.body,
      description: definition.description,
    }));
  } catch {
    // A missing or malformed snippet file only disables snippet suggestions.
  }
  snippetCache.set(file, snippets);
  return snippets;
}

export function buildSnippetCompletionItems(
  databaseKind: DatabaseKind | undefined,
  statementPrefix: string,
  typedPrefix: string,
  position: Position,
): CompletionItem[] {
  if (!isStatementStartPosition(statementPrefix, typedPrefix)) {
    return [];
  }
  return loadDialectSnippets(databaseKind)
    .filter((snippet) => snippet.prefixes.some((prefix) => matchesPrefix(prefix, typedPrefix)))
    .map((snippet) => {
    const item: CompletionItem = {
      label: snippet.prefixes[0],
      kind: CompletionItemKind.Snippet,
      detail: snippet.description ?? snippet.name,
      // One item per snippet; alternative prefixes (e.g. `DROP TABLE`) stay
      // searchable without listing the snippet once per prefix.
      filterText: snippet.prefixes.join(" "),
      insertText: snippet.body,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: {
        kind: MarkupKind.Markdown,
        value: ["```sql", snippet.body, "```"].join("\n"),
      },
      sortText: `9_${snippet.prefixes[0]}`,
    };
    applyPrefixRange(item, position, typedPrefix);
    return item;
  });
}
