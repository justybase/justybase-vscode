/**
 * JOIN Knowledge import/export (Stage 4, `docs/join-knowledge/05-stage-4-portability.md`).
 *
 * Only active manual decisions travel: relation confirm/block/favorite, the
 * within-tier score adjustments, and FROM-object pin/boost/demote/exclude.
 * Observed evidence (workspace, executed, accepted), salts, fingerprints,
 * execution keys, record ids and decision histories are local and never leave
 * the install. Import is a whole-file transaction: validate everything first,
 * diff against local decisions, apply with an explicit conflict strategy.
 * The module performs no I/O.
 */

import {
  canonicalizeRelation,
  normalizeObjectRef,
  objectRefKey,
  type ObjectRef,
  type RelationColumn,
  type TableRef,
} from "./identity";
import { isBoostBand } from "./model";
import type { JoinKnowledgeStore } from "./store";
import type { ObjectPreferenceKind } from "./types";

export const JOIN_KNOWLEDGE_EXPORT_FORMAT = "justybase-sql-knowledge";
export const JOIN_KNOWLEDGE_EXPORT_VERSION = 1;

export interface ExportedRelation {
  left: TableRef;
  right: TableRef;
  columns: RelationColumn[];
}

export interface ExportedRelationDecision {
  kind: "confirm" | "block" | "favorite";
  databaseKind?: string;
  relation: ExportedRelation;
}

export interface ExportedRelationScore {
  databaseKind?: string;
  relation: ExportedRelation;
  /** Integer `-5..+5`. */
  adjustment: number;
}

export interface ExportedObjectPreference {
  kind: ObjectPreferenceKind;
  databaseKind?: string;
  object: ObjectRef;
  band?: number;
  pinOrder?: number;
}

export interface JoinKnowledgeExportDocument {
  format: typeof JOIN_KNOWLEDGE_EXPORT_FORMAT;
  version: typeof JOIN_KNOWLEDGE_EXPORT_VERSION;
  exportedAt: string;
  relations: ExportedRelationDecision[];
  scores: ExportedRelationScore[];
  objects: ExportedObjectPreference[];
}

function sortTableRef(ref: TableRef): TableRef {
  return {
    ...(ref.database ? { database: ref.database } : {}),
    ...(ref.schema ? { schema: ref.schema } : {}),
    table: ref.table,
  };
}

function exportRelation(relation: { display: ExportedRelation }): ExportedRelation {
  return {
    left: sortTableRef(relation.display.left),
    right: sortTableRef(relation.display.right),
    columns: relation.display.columns.map((pair) => ({ left: pair.left, right: pair.right })),
  };
}

/**
 * Build the export document from active manual decisions only. The output is
 * deterministic for a given state (sorted by identity) so exports diff cleanly.
 */
export function buildJoinKnowledgeExport(
  store: JoinKnowledgeStore,
  exportedAt: string,
): JoinKnowledgeExportDocument {
  const relations = store.getRelationOverrides()
    .filter((entry) => !entry.revertedAt)
    .map((entry) => ({
      key: `${entry.relationKey}\u0000${entry.kind}`,
      value: {
        kind: entry.kind,
        ...(entry.databaseKind ? { databaseKind: entry.databaseKind } : {}),
        relation: exportRelation(entry.relation),
      } satisfies ExportedRelationDecision,
    }));
  const scores = store.getRelationScoreOverrides()
    .filter((entry) => !entry.revertedAt && entry.adjustment !== 0)
    .map((entry) => ({
      key: entry.relationKey,
      value: {
        ...(entry.databaseKind ? { databaseKind: entry.databaseKind } : {}),
        relation: exportRelation(entry.relation),
        adjustment: entry.adjustment,
      } satisfies ExportedRelationScore,
    }));
  const objects = store.getActiveObjectPreferences().map((entry) => ({
    key: entry.objectKey,
    value: {
      kind: entry.kind,
      ...(entry.databaseKind ? { databaseKind: entry.databaseKind } : {}),
      object: {
        ...(entry.object.database ? { database: entry.object.database } : {}),
        ...(entry.object.schema ? { schema: entry.object.schema } : {}),
        name: entry.object.name,
      },
      ...(entry.band !== undefined ? { band: entry.band } : {}),
      ...(entry.pinOrder !== undefined ? { pinOrder: entry.pinOrder } : {}),
    } satisfies ExportedObjectPreference,
  }));
  const byKey = <T>(items: Array<{ key: string; value: T }>): T[] =>
    items.sort((left, right) => left.key.localeCompare(right.key, "en")).map((item) => item.value);
  return {
    format: JOIN_KNOWLEDGE_EXPORT_FORMAT,
    version: JOIN_KNOWLEDGE_EXPORT_VERSION,
    exportedAt,
    relations: byKey(relations),
    scores: byKey(scores),
    objects: byKey(objects),
  };
}

export function serializeJoinKnowledgeExport(document: JoinKnowledgeExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export type JoinKnowledgeImportParseResult =
  | { ok: true; document: JoinKnowledgeExportDocument }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function readTableRef(value: unknown): TableRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const table = readString(value.table);
  if (!table) {
    return undefined;
  }
  const database = value.database === undefined ? undefined : readString(value.database);
  const schema = value.schema === undefined ? undefined : readString(value.schema);
  if ((value.database !== undefined && !database) || (value.schema !== undefined && !schema)) {
    return undefined;
  }
  return {
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    table,
  };
}

function readRelation(value: unknown, databaseKind: string | undefined): ExportedRelation | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns) || value.columns.length === 0) {
    return undefined;
  }
  const left = readTableRef(value.left);
  const right = readTableRef(value.right);
  const columns: RelationColumn[] = [];
  for (const pair of value.columns) {
    const leftColumn = isRecord(pair) ? readString(pair.left) : undefined;
    const rightColumn = isRecord(pair) ? readString(pair.right) : undefined;
    if (!leftColumn || !rightColumn) {
      return undefined;
    }
    columns.push({ left: leftColumn, right: rightColumn });
  }
  if (!left || !right || !canonicalizeRelation({ left, right, columns }, databaseKind)) {
    return undefined;
  }
  return { left, right, columns };
}

function readDatabaseKind(value: unknown): { ok: boolean; value?: string } {
  if (value === undefined) {
    return { ok: true };
  }
  const parsed = readString(value);
  return parsed && /^[a-z0-9_-]{1,32}$/u.test(parsed) ? { ok: true, value: parsed } : { ok: false };
}

const RELATION_KINDS = new Set(["confirm", "block", "favorite"]);
const OBJECT_KINDS = new Set(["pin", "boost", "demote", "exclude"]);

/**
 * Validate a whole import file. Any malformed item rejects the file, so a
 * partially valid file never produces a partial write.
 */
export function parseJoinKnowledgeImport(text: string): JoinKnowledgeImportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  if (!isRecord(value) || value.format !== JOIN_KNOWLEDGE_EXPORT_FORMAT) {
    return { ok: false, error: `The file is not a ${JOIN_KNOWLEDGE_EXPORT_FORMAT} export.` };
  }
  if (value.version !== JOIN_KNOWLEDGE_EXPORT_VERSION) {
    return { ok: false, error: `Unsupported export version ${String(value.version)}; expected ${JOIN_KNOWLEDGE_EXPORT_VERSION}.` };
  }
  const exportedAt = readString(value.exportedAt);
  if (!exportedAt || Number.isNaN(Date.parse(exportedAt))) {
    return { ok: false, error: "The export timestamp is missing or invalid." };
  }
  if (!Array.isArray(value.relations) || !Array.isArray(value.scores) || !Array.isArray(value.objects)) {
    return { ok: false, error: "The export must contain relations, scores and objects arrays." };
  }

  const relations: ExportedRelationDecision[] = [];
  for (const [index, entry] of value.relations.entries()) {
    const kind = isRecord(entry) ? entry.kind : undefined;
    const databaseKind = readDatabaseKind(isRecord(entry) ? entry.databaseKind : undefined);
    const relation = isRecord(entry) && databaseKind.ok ? readRelation(entry.relation, databaseKind.value) : undefined;
    if (typeof kind !== "string" || !RELATION_KINDS.has(kind) || !relation) {
      return { ok: false, error: `Relation decision #${index + 1} is invalid.` };
    }
    relations.push({
      kind: kind as ExportedRelationDecision["kind"],
      ...(databaseKind.value ? { databaseKind: databaseKind.value } : {}),
      relation,
    });
  }

  const scores: ExportedRelationScore[] = [];
  for (const [index, entry] of value.scores.entries()) {
    const adjustment = isRecord(entry) ? entry.adjustment : undefined;
    const databaseKind = readDatabaseKind(isRecord(entry) ? entry.databaseKind : undefined);
    const relation = isRecord(entry) && databaseKind.ok ? readRelation(entry.relation, databaseKind.value) : undefined;
    if (
      typeof adjustment !== "number"
      || !Number.isInteger(adjustment)
      || adjustment < -5
      || adjustment > 5
      || adjustment === 0
      || !relation
    ) {
      return { ok: false, error: `Score adjustment #${index + 1} is invalid.` };
    }
    scores.push({
      ...(databaseKind.value ? { databaseKind: databaseKind.value } : {}),
      relation,
      adjustment,
    });
  }

  const objects: ExportedObjectPreference[] = [];
  for (const [index, entry] of value.objects.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, error: `Object preference #${index + 1} is invalid.` };
    }
    const kind = entry.kind;
    const databaseKind = readDatabaseKind(entry.databaseKind);
    const objectValue = isRecord(entry.object) ? entry.object : undefined;
    const name = objectValue ? readString(objectValue.name) : undefined;
    const object = objectValue && name
      ? normalizeObjectRef({
          name,
          ...(readString(objectValue.database) ? { database: readString(objectValue.database)! } : {}),
          ...(readString(objectValue.schema) ? { schema: readString(objectValue.schema)! } : {}),
        }, databaseKind.value)
      : undefined;
    const band = entry.band;
    const pinOrder = entry.pinOrder;
    const bandValid = kind === "boost"
      ? typeof band === "number" && Number.isInteger(band) && isBoostBand(band)
      : band === undefined;
    const pinValid = kind === "pin"
      ? typeof pinOrder === "number" && Number.isFinite(pinOrder) && pinOrder >= 0 && pinOrder <= 99
      : pinOrder === undefined;
    if (typeof kind !== "string" || !OBJECT_KINDS.has(kind) || !object || !databaseKind.ok || !bandValid || !pinValid) {
      return { ok: false, error: `Object preference #${index + 1} is invalid.` };
    }
    objects.push({
      kind: kind as ObjectPreferenceKind,
      ...(databaseKind.value ? { databaseKind: databaseKind.value } : {}),
      object,
      ...(typeof band === "number" ? { band } : {}),
      ...(typeof pinOrder === "number" ? { pinOrder } : {}),
    });
  }

  return {
    ok: true,
    document: {
      format: JOIN_KNOWLEDGE_EXPORT_FORMAT,
      version: JOIN_KNOWLEDGE_EXPORT_VERSION,
      exportedAt,
      relations,
      scores,
      objects,
    },
  };
}

export type JoinKnowledgeImportItemStatus = "added" | "unchanged" | "conflict";

export interface JoinKnowledgeImportItem {
  /** Stable identity inside one diff; used for per-item selection. */
  id: string;
  domain: "relation-decision" | "relation-favorite" | "relation-score" | "object";
  /** Human-readable identifiers only (tables, columns, object path). */
  label: string;
  status: JoinKnowledgeImportItemStatus;
  /** Local active value for a conflict, e.g. `block` or `+2`. */
  local?: string;
  imported: string;
}

export interface JoinKnowledgeImportDiff {
  items: JoinKnowledgeImportItem[];
  added: number;
  unchanged: number;
  conflicts: number;
}

function describeRelation(relation: ExportedRelation): string {
  const table = (ref: TableRef): string =>
    [ref.database, ref.schema, ref.table].filter((part) => !!part).join(".");
  const columns = relation.columns.map((pair) => `${pair.left} = ${pair.right}`).join(" AND ");
  return `${table(relation.left)} ↔ ${table(relation.right)} (${columns})`;
}

function describeObjectValue(entry: { kind: string; band?: number; pinOrder?: number }): string {
  if (entry.kind === "boost" && entry.band !== undefined) {
    return `boost ${entry.band}`;
  }
  if (entry.kind === "pin" && entry.pinOrder !== undefined) {
    return `pin ${entry.pinOrder}`;
  }
  return entry.kind;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

interface PlannedImportItem {
  item: JoinKnowledgeImportItem;
  apply: (store: JoinKnowledgeStore, now: string, nextId: () => string) => void;
}

function planImport(
  store: JoinKnowledgeStore,
  document: JoinKnowledgeExportDocument,
): PlannedImportItem[] {
  const planned: PlannedImportItem[] = [];
  for (const entry of document.relations) {
    const canonical = canonicalizeRelation(entry.relation, entry.databaseKind);
    if (!canonical) {
      continue;
    }
    const favorite = entry.kind === "favorite";
    const active = store.getRelationOverrides().filter(
      (override) => override.relationKey === canonical.key
        && !override.revertedAt
        && (favorite ? override.kind === "favorite" : override.kind !== "favorite"),
    );
    const local = active[active.length - 1];
    const status: JoinKnowledgeImportItemStatus = !local
      ? "added"
      : local.kind === entry.kind ? "unchanged" : "conflict";
    planned.push({
      item: {
        id: `relation:${favorite ? "favorite" : "decision"}:${canonical.key}`,
        domain: favorite ? "relation-favorite" : "relation-decision",
        label: describeRelation(entry.relation),
        status,
        ...(local && status === "conflict" ? { local: local.kind } : {}),
        imported: entry.kind,
      },
      apply: (target, now, nextId) => {
        target.appendRelationOverride({
          kind: entry.kind,
          relation: entry.relation,
          databaseKind: entry.databaseKind,
          now,
          id: nextId(),
        });
      },
    });
  }
  for (const entry of document.scores) {
    const canonical = canonicalizeRelation(entry.relation, entry.databaseKind);
    if (!canonical) {
      continue;
    }
    const local = store.getActiveRelationScoreOverride(canonical.key);
    const localAdjustment = local?.adjustment ?? 0;
    const status: JoinKnowledgeImportItemStatus = localAdjustment === 0
      ? "added"
      : localAdjustment === entry.adjustment ? "unchanged" : "conflict";
    planned.push({
      item: {
        id: `score:${canonical.key}`,
        domain: "relation-score",
        label: describeRelation(entry.relation),
        status,
        ...(status === "conflict" ? { local: signed(localAdjustment) } : {}),
        imported: signed(entry.adjustment),
      },
      apply: (target, now, nextId) => {
        target.appendRelationScoreOverride({
          relation: entry.relation,
          databaseKind: entry.databaseKind,
          adjustment: entry.adjustment,
          now,
          id: nextId(),
        });
      },
    });
  }
  for (const entry of document.objects) {
    const key = objectRefKey(entry.object);
    const local = store.getActiveObjectPreference(key);
    const same = local
      && local.kind === entry.kind
      && local.band === entry.band
      && local.pinOrder === entry.pinOrder;
    const status: JoinKnowledgeImportItemStatus = !local ? "added" : same ? "unchanged" : "conflict";
    planned.push({
      item: {
        id: `object:${key}`,
        domain: "object",
        label: [entry.object.database, entry.object.schema, entry.object.name].filter((part) => !!part).join("."),
        status,
        ...(local && status === "conflict" ? { local: describeObjectValue(local) } : {}),
        imported: describeObjectValue(entry),
      },
      apply: (target, now, nextId) => {
        target.appendObjectPreference({
          kind: entry.kind,
          object: entry.object,
          databaseKind: entry.databaseKind,
          now,
          id: nextId(),
          ...(entry.band !== undefined ? { band: entry.band } : {}),
          ...(entry.pinOrder !== undefined ? { pinOrder: entry.pinOrder } : {}),
        });
      },
    });
  }
  return planned;
}

/** Preview of an import against the current local decisions; no mutation. */
export function diffJoinKnowledgeImport(
  store: JoinKnowledgeStore,
  document: JoinKnowledgeExportDocument,
): JoinKnowledgeImportDiff {
  const items = planImport(store, document).map((entry) => entry.item);
  return {
    items,
    added: items.filter((item) => item.status === "added").length,
    unchanged: items.filter((item) => item.status === "unchanged").length,
    conflicts: items.filter((item) => item.status === "conflict").length,
  };
}

export interface ApplyJoinKnowledgeImportOptions {
  /**
   * `keep-local` (default) never replaces an active local decision;
   * `keep-import` replaces every conflicting one.
   */
  strategy?: "keep-local" | "keep-import";
  /** Conflict item ids taken from the import regardless of the strategy. */
  takeImported?: ReadonlySet<string>;
  now: string;
}

export interface JoinKnowledgeImportResult {
  added: number;
  replaced: number;
  keptLocal: number;
  unchanged: number;
}

/**
 * Apply an import. New and accepted conflicting decisions are appended as new
 * local records (new ids, `createdAt = now`); the imported install's history
 * is never copied, and replaced local records keep their own revert chain.
 */
export function applyJoinKnowledgeImport(
  store: JoinKnowledgeStore,
  document: JoinKnowledgeExportDocument,
  options: ApplyJoinKnowledgeImportOptions,
): JoinKnowledgeImportResult {
  const result: JoinKnowledgeImportResult = { added: 0, replaced: 0, keptLocal: 0, unchanged: 0 };
  let sequence = 0;
  const stamp = options.now.replace(/[^0-9]/gu, "");
  const nextId = (): string => `import-${stamp}-${(sequence += 1)}`;
  for (const { item, apply } of planImport(store, document)) {
    if (item.status === "unchanged") {
      result.unchanged += 1;
      continue;
    }
    if (item.status === "conflict") {
      const takeImported = options.strategy === "keep-import" || options.takeImported?.has(item.id) === true;
      if (!takeImported) {
        result.keptLocal += 1;
        continue;
      }
      apply(store, options.now, nextId);
      result.replaced += 1;
      continue;
    }
    apply(store, options.now, nextId);
    result.added += 1;
  }
  return result;
}
