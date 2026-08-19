import type { CompletionItem } from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";

/**
 * Stable matching and deduplication helpers for completion lists.
 */
export function matchesPrefix(label: string, prefix: string): boolean {
  return !prefix || label.toUpperCase().startsWith(prefix.toUpperCase());
}

export function dedupeCompletionItems(
  items: CompletionItem[],
  databaseKind?: DatabaseKind,
): CompletionItem[] {
  const seen = new Set<string>();
  const deduped: CompletionItem[] = [];
  for (const item of items) {
    const label = databaseKind === "netezza"
      ? item.label
      : item.label.toUpperCase();
    const key = `${label}|${item.kind || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
