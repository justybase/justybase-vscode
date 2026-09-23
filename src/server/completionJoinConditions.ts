import type { MetadataColumnItem } from "../lsp/protocol";
import { getRelatedColumnRole, normalizeRelatedColumnName } from "../utils/relatedColumnNames";

export interface JoinColumnMatch {
  left: MetadataColumnItem;
  right: MetadataColumnItem;
  isKeyMatch: boolean;
}

/** Normalize common catalog naming prefixes while preserving exact name matching. */
export function normalizeJoinColumnName(name: string): string {
  return normalizeRelatedColumnName(name);
}

function hasKeyMarker(column: MetadataColumnItem): boolean {
  return getRelatedColumnRole(column) !== "unknown";
}

/**
 * Match column names exactly after known key/catalog prefix normalization.
 * Ambiguous heuristic matches are intentionally left for the caller to reject.
 */
export function findJoinColumnMatches(
  leftColumns: MetadataColumnItem[],
  rightColumns: MetadataColumnItem[],
): JoinColumnMatch[] {
  const rightByName = new Map<string, MetadataColumnItem[]>();
  for (const column of rightColumns) {
    const key = normalizeJoinColumnName(column.name);
    if (!key) continue;
    const matches = rightByName.get(key) ?? [];
    matches.push(column);
    rightByName.set(key, matches);
  }

  const matches: JoinColumnMatch[] = [];
  for (const left of leftColumns) {
    const key = normalizeJoinColumnName(left.name);
    const candidates = key ? rightByName.get(key) : undefined;
    if (!candidates) continue;
    for (const right of candidates) {
      matches.push({ left, right, isKeyMatch: hasKeyMarker(left) || hasKeyMarker(right) });
    }
  }
  return matches;
}
