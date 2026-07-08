import type { LocalDefinition } from "../providers/types";
import { stripQuotes } from "./completionDialectAdapter";

/**
 * Helpers for merging and resolving parser-derived local definitions.
 */
export function isPersistentDocumentDefinition(
  definition: LocalDefinition,
): boolean {
  const type = definition.type.toUpperCase();
  return type === "TEMP TABLE" || type === "TABLE";
}

export function isCompletableLocalDefinition(
  definition: LocalDefinition,
): boolean {
  const type = definition.type.toUpperCase();
  return type === "CTE" || type === "TABLE" || type === "TEMP TABLE";
}

export function findLocalDefinition(
  localDefs: LocalDefinition[],
  name: string,
): LocalDefinition | undefined {
  const upperName = name.toUpperCase();
  return localDefs.find((def) => def.name.toUpperCase() === upperName);
}

export function mergeLocalDefinitions(
  base: LocalDefinition[],
  currentStatement: LocalDefinition[],
): LocalDefinition[] {
  const merged = new Map<string, LocalDefinition>();
  for (const definition of base) {
    merged.set(definition.name.toUpperCase(), definition);
  }
  for (const definition of currentStatement) {
    merged.set(definition.name.toUpperCase(), definition);
  }
  return mergeDefinitionColumns(Array.from(merged.values()));
}

export function mergeDefinitionColumns(
  localDefs: LocalDefinition[],
): LocalDefinition[] {
  const merged = new Map<string, LocalDefinition>();
  for (const definition of localDefs) {
    const key = definition.name.toUpperCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        name: definition.name,
        type: definition.type,
        columns: [...definition.columns],
      });
      continue;
    }

    const seen = new Set(existing.columns.map((column) => column.toUpperCase()));
    const combinedColumns = [...existing.columns];
    for (const column of definition.columns) {
      const normalized = column.toUpperCase();
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      combinedColumns.push(column);
    }

    merged.set(key, {
      name: existing.name,
      type: existing.type,
      columns: combinedColumns,
    });
  }

  return Array.from(merged.values());
}

export function normalizeColumnNames(columns: string[]): string[] {
  return columns
    .map((column) => stripQuotes(column.trim()))
    .filter((column) => !!column);
}

export function dedupeColumnNames(columns: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const column of columns) {
    const normalized = stripQuotes(column.trim());
    if (!normalized) {
      continue;
    }
    const key = normalized.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}