import type { CompletionItem } from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";

/**
 * Stable matching and deduplication helpers for completion lists.
 */
export function matchesPrefix(label: string, prefix: string): boolean {
  return getCompletionMatchRank(label, prefix) !== undefined;
}

/** IDE-style identifier matching: direct prefixes, compact names, acronyms, then fragments. */
export function getCompletionMatchRank(
  label: string,
  query: string,
): number | undefined {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return 0;
  const upperLabel = label.toLocaleUpperCase();
  const upperQuery = normalizedQuery.toLocaleUpperCase();
  if (upperLabel.startsWith(upperQuery)) return 0;

  const compactLabel = upperLabel.replace(/[^\p{L}\p{N}]/gu, "");
  const compactQuery = upperQuery.replace(/[^\p{L}\p{N}]/gu, "");
  if (!compactQuery) return undefined;
  if (compactLabel.startsWith(compactQuery)) return 1;

  const words = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const queryWords = normalizedQuery
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (queryWords.length > 1) {
    let lastWordIndex = -1;
    const matchesSeparatedQuery = queryWords.every((queryWord) => {
      const nextIndex = words.findIndex((word, index) =>
        index > lastWordIndex
        && word.toLocaleUpperCase().startsWith(queryWord.toLocaleUpperCase()),
      );
      if (nextIndex < 0) return false;
      lastWordIndex = nextIndex;
      return true;
    });
    if (matchesSeparatedQuery) return 1;
  }
  const initials = words.map((word) => word[0]).join("").toLocaleUpperCase();
  const queryInitials = queryWords.map((word) => word[0]).join("").toLocaleUpperCase();
  const queryIsDelimited = queryWords.length > 1;
  const queryIsAcronym = compactQuery.length > 1;
  if (
    (queryIsDelimited && initials.startsWith(queryInitials))
    || (queryIsAcronym && initials.startsWith(compactQuery))
  ) return 2;

  const wordPrefix = words.some((word) => word.toLocaleUpperCase().startsWith(upperQuery));
  if (wordPrefix) return 3;
  if (compactQuery.length > 1 && compactLabel.includes(compactQuery)) return 4;
  return undefined;
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
