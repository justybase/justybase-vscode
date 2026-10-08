import type { DatabaseForeignKeyColumnReference } from "../contracts/database";
import type { MetadataObjectItem } from "../lsp/protocol";

export interface JoinIndexColumn {
  name: string;
  normalizedName: string;
  isKey: boolean;
  joinReferences?: readonly DatabaseForeignKeyColumnReference[];
}

export interface JoinIndexTable {
  name: string;
  schema: string;
  columns: readonly JoinIndexColumn[];
}

export interface JoinTargetSource {
  schema: string;
  table: string;
}

export type JoinMatch = NonNullable<MetadataObjectItem["joinMatches"]>[number];

export interface JoinTargetCandidate<T extends JoinIndexTable> {
  table: T;
  joinUsesDefaultSchema: boolean;
  matches: JoinMatch[];
}

function same(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toUpperCase() === (right ?? "").toUpperCase();
}

/**
 * Pure relationship matcher behind JOIN target completion. For each visible
 * source table it pairs every other indexed table by declared catalog foreign
 * keys (both directions) and falls back to a same-schema key-name heuristic
 * only when no declared relationship exists. Callers own metadata loading.
 */
export function computeJoinTargetCandidates<T extends JoinIndexTable>(
  database: string,
  defaultSchema: string | undefined,
  sources: readonly JoinTargetSource[],
  tableIndex: readonly T[],
): Array<JoinTargetCandidate<T>> {
  const targets = new Map<string, JoinTargetCandidate<T>>();
  for (const source of sources) {
    const sourceTable = tableIndex.find((entry) =>
      same(entry.name, source.table) && same(entry.schema, source.schema),
    );
    if (!sourceTable?.columns.length) {
      continue;
    }

    for (const candidate of tableIndex) {
      const isSameSchema = same(candidate.schema, source.schema);
      if (isSameSchema && same(candidate.name, sourceTable.name)) {
        continue;
      }

      const matches: JoinMatch[] = [];
      // Exact catalog FK pairs take precedence over the fallback name/key matcher.
      for (const sourceColumn of sourceTable.columns) {
        for (const reference of sourceColumn.joinReferences ?? []) {
          if (
            !same(reference.toTable, candidate.name) ||
            !same(reference.toSchema, candidate.schema) ||
            (reference.toDatabase && !same(reference.toDatabase, database))
          ) continue;
          matches.push({
            sourceTable: sourceTable.name,
            sourceSchema: sourceTable.schema || undefined,
            sourceColumn: sourceColumn.name,
            targetColumn: reference.toColumn,
            relationType: "foreignKey",
            constraintName: reference.constraintName,
            ordinalPosition: reference.ordinalPosition,
          });
        }
      }
      // Keep relationships in both directions. Two tables can have separate
      // foreign keys pointing at each other; the resolver groups each constraint.
      for (const targetColumn of candidate.columns) {
        for (const reference of targetColumn.joinReferences ?? []) {
          if (
            !same(reference.toTable, sourceTable.name) ||
            !same(reference.toSchema, sourceTable.schema) ||
            (reference.toDatabase && !same(reference.toDatabase, database))
          ) continue;
          matches.push({
            sourceTable: sourceTable.name,
            sourceSchema: sourceTable.schema || undefined,
            sourceColumn: reference.toColumn,
            targetColumn: targetColumn.name,
            relationType: "foreignKey",
            constraintName: reference.constraintName,
            ordinalPosition: reference.ordinalPosition,
          });
        }
      }
      if (matches.length === 0 && isSameSchema) {
        for (const sourceColumn of sourceTable.columns) {
          for (const targetColumn of candidate.columns) {
            if (
              sourceColumn.normalizedName !== targetColumn.normalizedName ||
              (!sourceColumn.isKey && !targetColumn.isKey)
            ) {
              continue;
            }
            matches.push({
              sourceTable: sourceTable.name,
              sourceSchema: sourceTable.schema || undefined,
              sourceColumn: sourceColumn.name,
              targetColumn: targetColumn.name,
              relationType: "heuristic",
            });
          }
        }
      }
      if (matches.length === 0) {
        continue;
      }

      const key = `${candidate.schema}.${candidate.name}`.toUpperCase();
      const existing = targets.get(key);
      targets.set(key, {
        table: existing?.table ?? candidate,
        joinUsesDefaultSchema: Boolean(
          defaultSchema && same(candidate.schema, defaultSchema),
        ),
        matches: [...(existing?.matches ?? []), ...matches],
      });
    }
  }
  return [...targets.values()];
}
