import {
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  mergeJoinKnowledgeIndexDelta,
  normalizeObjectRef,
  objectRefKey,
  type IdentityDefaults,
  type IdentityDatabaseKind,
  type JoinKnowledgeIndex,
  type JoinEvidenceStrength,
  type JoinKnowledgeIndexDelta,
  type JoinKnowledgeSnapshot,
  type ObjectPreferenceSnapshot,
  type ObjectRef,
  type RelationColumn,
  type RelationIdentity,
  type TableRef,
  type WorkspaceRelationSnapshot,
} from "@justybase/sql-core/joinKnowledge";

/**
 * In-memory knowledge ranking state for the language server.
 *
 * The host sends one snapshot notification; every completion request below the
 * completion engine uses only map lookups (no I/O, git, parsing or network).
 */
let snapshot: JoinKnowledgeSnapshot = {
  version: 1,
  relations: [],
  objectPreferences: [],
};
let index: JoinKnowledgeIndex = buildJoinKnowledgeIndex(snapshot);
let personalizeFromObjects = true;
let joinNameHeuristics = true;
let personalizeColumns = true;
/** Test/replay clock override; production uses the wall clock at snapshot build. */
let injectedNow: string | undefined;

function rebuildIndex(): void {
  index = buildJoinKnowledgeIndex(snapshot, {
    now: injectedNow ?? new Date().toISOString(),
  });
}

export function setJoinKnowledgeSnapshot(
  nextSnapshot: JoinKnowledgeSnapshot | undefined,
  options?: {
    personalizeFromObjects?: boolean;
    joinNameHeuristics?: boolean;
    personalizeColumns?: boolean;
    /** Injected clock for freshness scoring (tests and offline replay). */
    now?: string;
  },
): void {
  snapshot = nextSnapshot ?? {
    version: 1,
    relations: [],
    objectPreferences: [],
  };
  if (options?.now !== undefined) {
    injectedNow = options.now;
  }
  if (options?.personalizeColumns !== undefined) {
    personalizeColumns = options.personalizeColumns;
  }
  rebuildIndex();
  if (options?.personalizeFromObjects !== undefined) {
    personalizeFromObjects = options.personalizeFromObjects;
  }
  if (options?.joinNameHeuristics !== undefined) {
    joinNameHeuristics = options.joinNameHeuristics;
  }
}

/** Apply an affected-key workspace index update without touching decisions. */
export function applyJoinKnowledgeIndexDelta(
  delta: JoinKnowledgeIndexDelta,
): void {
  snapshot = mergeJoinKnowledgeIndexDelta(snapshot, delta);
  rebuildIndex();
}

/** Test hook; production state always arrives through the LSP notification. */
export function __TEST_ONLY_resetJoinKnowledge(): void {
  snapshot = {
    version: 1,
    relations: [],
    objectPreferences: [],
  };
  injectedNow = undefined;
  rebuildIndex();
  personalizeFromObjects = true;
  joinNameHeuristics = true;
  personalizeColumns = true;
}

export function getJoinKnowledgeIndex(): JoinKnowledgeIndex {
  return index;
}

export function setJoinKnowledgeOptions(options: {
  personalizeFromObjects?: boolean;
  joinNameHeuristics?: boolean;
  personalizeColumns?: boolean;
}): void {
  if (options.personalizeColumns !== undefined) {
    personalizeColumns = options.personalizeColumns;
  }
  if (options.personalizeFromObjects !== undefined) {
    personalizeFromObjects = options.personalizeFromObjects;
  }
  if (options.joinNameHeuristics !== undefined) {
    joinNameHeuristics = options.joinNameHeuristics;
  }
}

export function isObjectPersonalizationEnabled(): boolean {
  return personalizeFromObjects;
}

export function isJoinNameHeuristicsEnabled(): boolean {
  return joinNameHeuristics;
}

export interface RelationDecisionResult {
  key: string | undefined;
  decision: "confirmed" | "blocked" | "favorite" | "none";
  relation: RelationIdentity | undefined;
}

export function getRelationDecision(
  left: TableRef,
  right: TableRef,
  columns: readonly RelationColumn[],
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): RelationDecisionResult {
  const relation = canonicalizeRelation(
    { left, right, columns: [...columns] },
    databaseKind,
    defaults,
  );
  if (!relation) {
    return { key: undefined, decision: "none", relation: undefined };
  }
  if (index.blockedRelations.has(relation.key)) {
    return { key: relation.key, decision: "blocked", relation };
  }
  if (index.confirmedRelations.has(relation.key)) {
    return { key: relation.key, decision: "confirmed", relation };
  }
  if (index.favoriteRelations.has(relation.key)) {
    return { key: relation.key, decision: "favorite", relation };
  }
  return { key: relation.key, decision: "none", relation };
}

/** Active favorites; blocked relations are already excluded by the index. */
export function getFavoriteRelations(): Iterable<RelationIdentity> {
  return index.favoriteRelations.values();
}

/** Eligible workspace relations; below-threshold records are diagnostics only. */
export function getWorkspaceRelations(): Iterable<WorkspaceRelationSnapshot> {
  return index.workspaceRelations.values();
}

/**
 * One observed JOIN candidate per canonical relation. Executed evidence (`0_4_`)
 * takes precedence over workspace evidence (`0_5_`) for the same relation, and
 * executed records from another dialect are ignored; workspace evidence then
 * remains available. Counts only; no SQL is derived here.
 */
export interface ObservedJoinRelation {
  key: string;
  relation: RelationIdentity;
  source: "executed" | "workspace";
  /** Breadth label built from counters, e.g. `3 execution(s), 2 day(s)`. */
  breadth: string;
}

export function getObservedRelations(
  databaseKind?: string,
): ObservedJoinRelation[] {
  const requested = databaseKind ?? "netezza";
  const observed: ObservedJoinRelation[] = [];
  const covered = new Map<string, ObservedJoinRelation>();
  for (const record of index.executedRelations.values()) {
    // Executed evidence is captured for Netezza only; a missing dialect means Netezza.
    if ((record.databaseKind ?? "netezza") !== requested) {
      continue;
    }
    const entry: ObservedJoinRelation = {
      key: record.relationKey,
      relation: record.relation,
      source: "executed",
      breadth: `${record.observations} execution(s), ${record.distinctDays} day(s)`,
    };
    covered.set(record.relationKey, entry);
    observed.push(entry);
  }
  for (const relation of index.workspaceRelations.values()) {
    const executedEntry = covered.get(relation.key);
    if (executedEntry) {
      // Executed evidence owns the tier; the label still shows both sources
      // because the within-tier score merges them.
      executedEntry.breadth = `${executedEntry.breadth}; ${relation.distinctFiles} file(s)`;
      continue;
    }
    observed.push({
      key: relation.key,
      relation: relation.relation,
      source: "workspace",
      breadth: `${relation.distinctFiles} file(s), ${relation.distinctQueries} query(ies)`,
    });
  }
  return observed;
}

/** Precomputed breadth/freshness for a relation; `undefined` without evidence. */
export function getRelationEvidenceStrength(
  relationKey: string | undefined,
): JoinEvidenceStrength | undefined {
  return relationKey ? index.relationEvidenceStrength.get(relationKey) : undefined;
}

export function hasRelationEvidence(): boolean {
  return index.relationEvidenceStrength.size > 0;
}

export function getRelationScoreAdjustment(relationKey: string | undefined): number {
  return relationKey ? index.relationScoreAdjustments.get(relationKey) ?? 0 : 0;
}

export function hasRelationScoreAdjustments(): boolean {
  return index.relationScoreAdjustments.size > 0;
}

export function getWorkspaceRelation(
  relationKey: string,
): WorkspaceRelationSnapshot | undefined {
  return index.workspaceRelations.get(relationKey);
}

/**
 * Evidence keys for one catalog object. Workspace and executed SQL store
 * identifiers as written, so an unqualified `FROM ORDERS` (or `DB..ORDERS`) is
 * keyed without schema. Such evidence applies only to the object that the
 * unqualified name resolves to: the one in the effective database/schema.
 */
export function objectEvidenceKeys(
  ref: ObjectRef,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): string[] {
  const scoped = normalizeObjectRef(ref, databaseKind, defaults);
  if (!scoped) {
    return [];
  }
  const keys = [objectRefKey(scoped)];
  const resolvedUnqualified = normalizeObjectRef({ name: ref.name }, databaseKind, defaults);
  if (resolvedUnqualified && objectRefKey(resolvedUnqualified) === keys[0]) {
    keys.push(objectRefKey({ name: scoped.name }));
    if (scoped.database) {
      keys.push(objectRefKey({ database: scoped.database, name: scoped.name }));
    }
  }
  return [...new Set(keys)];
}

function bestBand(
  bands: ReadonlyMap<string, number>,
  keys: readonly string[],
): number | undefined {
  let best: number | undefined;
  for (const key of keys) {
    const band = bands.get(key);
    if (band !== undefined && (best === undefined || band < best)) {
      best = band;
    }
  }
  return best;
}

export function getWorkspaceObjectBand(
  ref: ObjectRef,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): number | undefined {
  if (!personalizeFromObjects) {
    return undefined;
  }
  const keys = objectEvidenceKeys(ref, databaseKind, defaults);
  if (keys.length === 0) {
    return undefined;
  }
  // Executed usage is Netezza-only. All sources merge by the better band, never summed.
  const bands = [
    bestBand(index.workspaceObjectBands, keys),
    (databaseKind ?? "netezza") === "netezza"
      ? bestBand(index.executedObjectBands, keys)
      : undefined,
    bestBand(index.acceptedObjectBands, keys),
  ].filter((band): band is number => band !== undefined);
  return bands.length > 0 ? Math.min(...bands) : undefined;
}

/**
 * Learned column bands for one table (`10`–`49`, lower = used more broadly),
 * keyed by upper-cased column name; `undefined` when nothing was learned.
 * Workspace and executed usage merge by the better band, never summed.
 */
export function getColumnUsageBands(
  ref: ObjectRef,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): ReadonlyMap<string, number> | undefined {
  if (
    !personalizeColumns
    || (index.columnBands.size === 0 && index.executedColumnBands.size === 0)
  ) {
    return undefined;
  }
  const sources = [index.columnBands];
  // Executed usage is Netezza-only, like executed object bands.
  if ((databaseKind ?? "netezza") === "netezza") {
    sources.push(index.executedColumnBands);
  }
  let merged: Map<string, number> | undefined;
  for (const key of objectEvidenceKeys(ref, databaseKind, defaults)) {
    for (const source of sources) {
      const bands = source.get(key);
      if (!bands) {
        continue;
      }
      merged ??= new Map<string, number>();
      for (const [column, band] of bands) {
        const previous = merged.get(column);
        merged.set(column, previous === undefined ? band : Math.min(previous, band));
      }
    }
  }
  return merged;
}

export function hasWorkspaceObjectEvidence(): boolean {
  return personalizeFromObjects && index.workspaceObjectBands.size > 0;
}

export function isJoinFavorite(relationKey: string): boolean {
  return index.favoriteRelations.has(relationKey);
}

export function getConfirmedRelation(
  relationKey: string | undefined,
): RelationIdentity | undefined {
  return relationKey ? index.confirmedRelations.get(relationKey) : undefined;
}

/** Active confirmed relations, blocked ones excluded by the index. */
export function getConfirmedRelations(): Iterable<RelationIdentity> {
  return index.confirmedRelations.values();
}

export function getObjectPreference(
  ref: ObjectRef,
  databaseKind?: IdentityDatabaseKind,
  defaults?: IdentityDefaults,
): ObjectPreferenceSnapshot | undefined {
  if (!personalizeFromObjects) {
    return undefined;
  }
  const object = normalizeObjectRef(ref, databaseKind, defaults);
  if (!object) {
    return undefined;
  }
  return index.objectPreferences.get(objectRefKey(object));
}

export function hasObjectPreferences(): boolean {
  return personalizeFromObjects && index.hasObjectPreferences;
}
