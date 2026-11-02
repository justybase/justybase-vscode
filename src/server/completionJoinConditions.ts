import type { MetadataColumnItem } from "../lsp/protocol";
import {
  getRelatedColumnRole,
  isSelfNamedKeyColumn,
  normalizeRelatedColumnName,
} from "../utils/relatedColumnNames";

export interface JoinColumnMatch {
  left: MetadataColumnItem;
  right: MetadataColumnItem;
  isKeyMatch: boolean;
  /** Role-playing key (`ORDERDATEKEY = DATEKEY`) rather than equal names. */
  rolePlaying?: boolean;
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
 *
 * With table names, a column named after its own table (`DIMDATE.DATEKEY`)
 * also counts as a key, and a column ending with such a key on the other side
 * (`FACTINTERNETSALES.ORDERDATEKEY`) is offered as a role-playing key match.
 */
export function findJoinColumnMatches(
  leftColumns: MetadataColumnItem[],
  rightColumns: MetadataColumnItem[],
  tables?: { left: string; right: string },
): JoinColumnMatch[] {
  // Two aliases of one table joined on its own key are an identity join, so
  // self-named keys only count between different tables.
  const distinctTables = tables !== undefined && tables.left.toUpperCase() !== tables.right.toUpperCase();
  const selfKey = (column: MetadataColumnItem, table: string | undefined): boolean =>
    distinctTables && table !== undefined && isSelfNamedKeyColumn(column.name, table);
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
    for (const right of candidates ?? []) {
      matches.push({
        left,
        right,
        isKeyMatch: hasKeyMarker(left) || hasKeyMarker(right)
          || selfKey(left, tables?.left) || selfKey(right, tables?.right),
      });
    }
  }
  if (!tables) {
    return matches;
  }
  const compact = (name: string): string => normalizeJoinColumnName(name).replace(/_/g, "");
  const rolePlaying = (referencing: MetadataColumnItem, referencingTable: string, key: MetadataColumnItem, keyTable: string): boolean => {
    if (!selfKey(key, keyTable) || selfKey(referencing, referencingTable)) return false;
    const referencingName = compact(referencing.name);
    const keyName = compact(key.name);
    return referencingName !== keyName && referencingName.endsWith(keyName);
  };
  for (const left of leftColumns) {
    for (const right of rightColumns) {
      if (
        rolePlaying(left, tables.left, right, tables.right)
        || rolePlaying(right, tables.right, left, tables.left)
      ) {
        matches.push({ left, right, isKeyMatch: true, rolePlaying: true });
      }
    }
  }
  return matches;
}
