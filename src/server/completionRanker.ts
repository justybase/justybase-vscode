import type { CompletionItem } from "vscode-languageserver/node";

/**
 * Stable matching and deduplication helpers for completion lists.
 */
export function matchesPrefix(label: string, prefix: string): boolean {
  return !prefix || label.toUpperCase().startsWith(prefix.toUpperCase());
}

export function dedupeCompletionItems(
  items: CompletionItem[],
): CompletionItem[] {
  const seen = new Set<string>();
  const deduped: CompletionItem[] = [];
  for (const item of items) {
    const key = `${item.label.toUpperCase()}|${item.kind || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}