/**
 * Pure JOIN Knowledge store.
 *
 * Decisions are append-only: reverting writes `revertedAt` (and optionally
 * `replacedBy`) instead of deleting a record. The store performs no I/O; the
 * host persists its state and publishes {@link JoinKnowledgeSnapshot} to the
 * language server.
 */

import {
  canonicalizeRelation,
  columnUsageKey,
  normalizeObjectRef,
  objectRefKey,
  verifyRelationIdentity,
  type IdentityDatabaseKind,
  type IdentityDefaults,
  type ObjectRef,
  type RelationIdentity,
  type RelationInput,
} from "./identity";
import {
  acceptedObjectBand,
  EXECUTED_EVIDENCE_LIMITS,
  executedColumnBand,
  executedObjectBandForUsage,
  isBoostBand,
  isExecutedEvidenceEligible,
  isWorkspaceEvidenceEligible,
  joinEvidenceBreadth,
  joinEvidenceFreshness,
  OBJECT_BANDS,
  OBJECT_RANKING_MODEL,
  workspaceColumnBand,
  type ExecutedEvidenceLimits,
  type JoinEvidenceStrength,
  type ObjectUsageKind,
} from "./model";
import type {
  ColumnEvidenceRecord,
  JoinKnowledgeDiagnostics,
  JoinKnowledgeExecutedSnapshot,
  JoinKnowledgeRelationSnapshot,
  JoinKnowledgeSnapshot,
  JoinKnowledgeState,
  JoinRelationEvidenceRecord,
  JoinRelationOverride,
  JoinRelationScoreOverride,
  ObjectEvidenceRecord,
  ObjectPreferenceKind,
  ObjectPreferenceOverride,
  ObjectPreferenceSnapshot,
  WorkspaceColumnSnapshot,
  WorkspaceObjectSnapshot,
  WorkspaceRelationSnapshot,
} from "./types";

export interface JoinKnowledgeStoreOptions {
  /** Test/retention override; production uses {@link EXECUTED_EVIDENCE_LIMITS}. */
  limits?: Partial<ExecutedEvidenceLimits>;
}

export interface RecordExecutedStatementInput {
  /**
   * Stable identity of one successful statement execution (for example
   * `executionId:statementIndex`). A repeated key is a duplicate delivery of the
   * same event and never adds evidence.
   */
  executionKey: string;
  /** Dialect used for canonicalization; stored on every record. */
  databaseKind?: IdentityDatabaseKind;
  relations: readonly RelationIdentity[];
  objects: ReadonlyArray<{ object: ObjectRef; kind: ObjectUsageKind }>;
  /** Columns referenced through a resolved table binding (identifiers only). */
  columns?: ReadonlyArray<{ object: ObjectRef; column: string }>;
  /** Injected clock; the UTC day of `now` counts toward distinct days. */
  now: string;
}

/**
 * - `recorded`: at least one relation or object was counted.
 * - `duplicate`: the execution key was already counted in this session.
 * - `empty`: the statement contributed no eligible identifiers.
 */
export type RecordExecutedStatementOutcome = "recorded" | "duplicate" | "empty";

export interface AppendRelationOverrideInput {
  kind: "confirm" | "block" | "favorite";
  relation: RelationInput;
  databaseKind?: IdentityDatabaseKind;
  /**
   * Active database/schema scope. It must be applied before the record is
   * written, so `display` remains sufficient for a storage round-trip without
   * the original editor context.
   */
  defaults?: IdentityDefaults;
  now: string;
  id?: string;
}

export interface AppendObjectPreferenceInput {
  kind: ObjectPreferenceKind;
  object: ObjectRef;
  databaseKind?: IdentityDatabaseKind;
  /** Active database/schema scope, applied before the record is written. */
  defaults?: IdentityDefaults;
  now: string;
  id?: string;
  band?: number;
  pinOrder?: number;
}

export interface RecordAcceptedObjectInput {
  object: ObjectRef;
  databaseKind?: IdentityDatabaseKind;
  /** Active scope, applied before the record is written. */
  defaults?: IdentityDefaults;
  now: string;
}

export interface AppendRelationScoreOverrideInput {
  relation: RelationInput;
  databaseKind?: IdentityDatabaseKind;
  defaults?: IdentityDefaults;
  adjustment: number;
  now: string;
  id?: string;
}

export interface JoinKnowledgeIndex {
  confirmedRelations: ReadonlyMap<string, RelationIdentity>;
  blockedRelations: ReadonlySet<string>;
  /** Active favorites, including relations that are also confirmed. */
  favoriteRelations: ReadonlyMap<string, RelationIdentity>;
  /** Active within-tier user score adjustments, keyed by canonical relation. */
  relationScoreAdjustments: ReadonlyMap<string, number>;
  /** Eligible workspace relations; below-threshold records stay in diagnostics. */
  workspaceRelations: ReadonlyMap<string, WorkspaceRelationSnapshot>;
  /** Eligible successful-execution relations (`0_4_`), keyed by canonical relation. */
  executedRelations: ReadonlyMap<string, JoinRelationEvidenceRecord>;
  /**
   * Within-tier evidence strength per canonical relation, merged from eligible
   * workspace and executed records by the stronger value (never summed). Also
   * available for manual/confirmed/FK relations that have observed evidence.
   */
  relationEvidenceStrength: ReadonlyMap<string, JoinEvidenceStrength>;
  /** Learned FROM-object bands, keyed by database/schema/name. */
  workspaceObjectBands: ReadonlyMap<string, number>;
  /**
   * Learned column bands (`10`–`49`) from workspace SQL per object key, then
   * per upper-cased column name.
   */
  columnBands: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Learned column bands from successful executions. Kept apart from workspace
   * bands because executed evidence is dialect-scoped (Netezza only).
   */
  executedColumnBands: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Learned FROM-object bands from successful executions. Kept apart from
   * workspace bands because executed evidence is dialect-scoped.
   */
  executedObjectBands: ReadonlyMap<string, number>;
  /** Learned FROM-object bands from accepted completion selections. */
  acceptedObjectBands: ReadonlyMap<string, number>;
  objectPreferences: ReadonlyMap<string, ObjectPreferenceSnapshot>;
  hasObjectPreferences: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function parseUtcDays(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const days: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && UTC_DAY_PATTERN.test(entry) && !days.includes(entry)) {
      days.push(entry);
      if (days.length >= limit) {
        break;
      }
    }
  }
  return days;
}

function parseExecutionEvents(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: string[] = [];
  for (const entry of value) {
    const key = asString(entry);
    if (key && !events.includes(key)) {
      events.push(key);
      if (events.length >= limit) {
        break;
      }
    }
  }
  return events;
}

/** In-place removal; returns how many entries were removed. */
function removeWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  let removed = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      items.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Executions can be recorded out of order (history backfill replays older
 * statements after live capture), so the seen range only ever widens.
 */
function earlierTimestamp(existing: string | undefined, next: string): string {
  return existing !== undefined && existing < next ? existing : next;
}

function laterTimestamp(existing: string | undefined, next: string): string {
  return existing !== undefined && existing > next ? existing : next;
}

function nextId(prefix: string, now: string, index: number): string {
  return `${prefix}-${now}-${index}`;
}

function parseRelationOverride(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): JoinRelationOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const kind = record.kind === "confirm"
    || record.kind === "block"
    || record.kind === "favorite"
    ? record.kind
    : undefined;
  const createdAt = isIsoTimestamp(record.createdAt) ? record.createdAt : undefined;
  const relationValue = record.relation;
  if (!id || !kind || !createdAt || !relationValue || typeof relationValue !== "object") {
    return undefined;
  }
  const relationRecord = relationValue as Partial<RelationIdentity>;
  if (
    !relationRecord.key
    || !relationRecord.display
    || !Array.isArray(relationRecord.display.columns)
  ) {
    return undefined;
  }
  const canonical = verifyRelationIdentity(
    relationRecord as RelationIdentity,
    asString(record.databaseKind) ?? databaseKind,
  );
  if (!canonical) {
    return undefined;
  }
  const revertedAt = isIsoTimestamp(record.revertedAt) ? record.revertedAt : undefined;
  const replacedBy = asString(record.replacedBy);
  const recordDatabaseKind = asString(record.databaseKind) ?? databaseKind;
  return {
    id,
    relationKey: canonical.key,
    kind,
    relation: canonical,
    ...(recordDatabaseKind ? { databaseKind: recordDatabaseKind } : {}),
    createdAt,
    ...(revertedAt ? { revertedAt } : {}),
    ...(replacedBy ? { replacedBy } : {}),
  };
}

function parseObjectPreference(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): ObjectPreferenceOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const kind = record.kind;
  if (
    !id
    || (kind !== "pin" && kind !== "boost" && kind !== "demote" && kind !== "exclude")
    || !isIsoTimestamp(record.createdAt)
  ) {
    return undefined;
  }
  const objectValue = record.object;
  if (!objectValue || typeof objectValue !== "object") {
    return undefined;
  }
  const objectRecord = objectValue as Record<string, unknown>;
  const recordDatabaseKind = asString(record.databaseKind) ?? databaseKind;
  const object = normalizeObjectRef(
    {
      name: asString(objectRecord.name) ?? "",
      ...(asString(objectRecord.database) ? { database: asString(objectRecord.database)! } : {}),
      ...(asString(objectRecord.schema) ? { schema: asString(objectRecord.schema)! } : {}),
    },
    recordDatabaseKind,
  );
  if (!object) {
    return undefined;
  }
  const key = objectRefKey(object);
  const bandValue = asNumber(record.band);
  const band = kind === "boost"
    ? (bandValue !== undefined && isBoostBand(bandValue)
      ? Math.round(bandValue)
      : Math.round(OBJECT_BANDS.boostMin))
    : undefined;
  const pinValue = asNumber(record.pinOrder);
  const pinOrder = kind === "pin"
    ? Math.max(0, Math.min(99, Math.round(pinValue ?? 0)))
    : undefined;
  const revertedAt = isIsoTimestamp(record.revertedAt) ? record.revertedAt : undefined;
  const replacedBy = asString(record.replacedBy);
  return {
    id,
    objectKey: key,
    object,
    kind,
    ...(band !== undefined ? { band } : {}),
    ...(pinOrder !== undefined ? { pinOrder } : {}),
    ...(recordDatabaseKind ? { databaseKind: recordDatabaseKind } : {}),
    createdAt: record.createdAt as string,
    ...(revertedAt ? { revertedAt } : {}),
    ...(replacedBy ? { replacedBy } : {}),
  };
}

function parseRelationScoreOverride(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): JoinRelationScoreOverride | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const createdAt = isIsoTimestamp(record.createdAt) ? record.createdAt : undefined;
  const relationValue = record.relation;
  const adjustment = asNumber(record.adjustment);
  if (
    !id
    || !createdAt
    || !relationValue
    || typeof relationValue !== "object"
    || adjustment === undefined
    || !Number.isInteger(adjustment)
    || adjustment < -5
    || adjustment > 5
  ) {
    return undefined;
  }
  const recordDatabaseKind = asString(record.databaseKind) ?? databaseKind;
  const relation = verifyRelationIdentity(
    relationValue as RelationIdentity,
    recordDatabaseKind,
  );
  if (!relation) {
    return undefined;
  }
  const revertedAt = isIsoTimestamp(record.revertedAt) ? record.revertedAt : undefined;
  const replacedBy = asString(record.replacedBy);
  return {
    id,
    relationKey: relation.key,
    relation,
    ...(recordDatabaseKind ? { databaseKind: recordDatabaseKind } : {}),
    adjustment,
    createdAt,
    ...(revertedAt ? { revertedAt } : {}),
    ...(replacedBy ? { replacedBy } : {}),
  };
}

function parseRelationEvidence(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): JoinRelationEvidenceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (
    source !== "confirmed"
    && source !== "catalog-fk"
    && source !== "accepted"
    && source !== "executed"
    && source !== "workspace"
  ) {
    return undefined;
  }
  const relationValue = record.relation;
  if (!relationValue || typeof relationValue !== "object") {
    return undefined;
  }
  const recordDatabaseKind = asString(record.databaseKind) ?? databaseKind;
  const relation = verifyRelationIdentity(
    relationValue as RelationIdentity,
    recordDatabaseKind,
  );
  if (!relation) {
    return undefined;
  }
  const firstSeenAt = isIsoTimestamp(record.firstSeenAt) ? record.firstSeenAt : undefined;
  const lastSeenAt = isIsoTimestamp(record.lastSeenAt) ? record.lastSeenAt : undefined;
  if (!firstSeenAt || !lastSeenAt) {
    return undefined;
  }
  const observations = asNumber(record.observations);
  const distinctDays = asNumber(record.distinctDays);
  if (observations === undefined || distinctDays === undefined) {
    return undefined;
  }
  const days = source === "executed"
    ? parseUtcDays(record.days, EXECUTED_EVIDENCE_LIMITS.maxDaysPerRecord)
    : undefined;
  return {
    relationKey: relation.key,
    relation,
    ...(recordDatabaseKind ? { databaseKind: recordDatabaseKind } : {}),
    source,
    observations: Math.max(0, observations),
    distinctDays: Math.max(0, distinctDays),
    ...(asNumber(record.distinctFiles) !== undefined
      ? { distinctFiles: Math.max(0, asNumber(record.distinctFiles)!) }
      : {}),
    ...(asNumber(record.distinctQueries) !== undefined
      ? { distinctQueries: Math.max(0, asNumber(record.distinctQueries)!) }
      : {}),
    ...(days !== undefined ? { days } : {}),
    firstSeenAt,
    lastSeenAt,
    belowThreshold: record.belowThreshold === true,
  };
}

function parseObjectEvidence(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): ObjectEvidenceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (source !== "workspace" && source !== "executed" && source !== "accepted") {
    return undefined;
  }
  const objectValue = record.object;
  if (!objectValue || typeof objectValue !== "object") {
    return undefined;
  }
  const objectRecord = objectValue as Record<string, unknown>;
  const object = normalizeObjectRef(
    {
      name: asString(objectRecord.name) ?? "",
      ...(asString(objectRecord.database) ? { database: asString(objectRecord.database)! } : {}),
      ...(asString(objectRecord.schema) ? { schema: asString(objectRecord.schema)! } : {}),
    },
    databaseKind,
  );
  if (!object) {
    return undefined;
  }
  const usageValue = record.usage;
  if (!usageValue || typeof usageValue !== "object" || Array.isArray(usageValue)) {
    return undefined;
  }
  const usageRecord = usageValue as Record<string, unknown>;
  const usage = {
    select: Math.max(0, asNumber(usageRecord.select) ?? 0),
    insert: Math.max(0, asNumber(usageRecord.insert) ?? 0),
    update: Math.max(0, asNumber(usageRecord.update) ?? 0),
    delete: Math.max(0, asNumber(usageRecord.delete) ?? 0),
  };
  const firstSeenAt = isIsoTimestamp(record.firstSeenAt) ? record.firstSeenAt : undefined;
  const lastSeenAt = isIsoTimestamp(record.lastSeenAt) ? record.lastSeenAt : undefined;
  if (!firstSeenAt || !lastSeenAt) {
    return undefined;
  }
  const bestBand = asNumber(record.bestBand);
  if (bestBand === undefined) {
    return undefined;
  }
  const days = source === "executed"
    ? parseUtcDays(record.days, EXECUTED_EVIDENCE_LIMITS.maxDaysPerRecord)
    : undefined;
  return {
    objectKey: objectRefKey(object),
    object,
    source,
    usage,
    bestBand: Math.max(OBJECT_BANDS.learnedMin, Math.min(OBJECT_BANDS.learnedMax, Math.round(bestBand))),
    ...(asNumber(record.distinctFiles) !== undefined
      ? { distinctFiles: Math.max(0, asNumber(record.distinctFiles)!) }
      : {}),
    ...(asNumber(record.distinctQueries) !== undefined
      ? { distinctQueries: Math.max(0, asNumber(record.distinctQueries)!) }
      : {}),
    ...(asNumber(record.observations) !== undefined
      ? { observations: Math.max(0, asNumber(record.observations)!) }
      : {}),
    ...(asNumber(record.distinctDays) !== undefined
      ? { distinctDays: Math.max(0, asNumber(record.distinctDays)!) }
      : {}),
    ...(days !== undefined ? { days } : {}),
    firstSeenAt,
    lastSeenAt,
    belowThreshold: record.belowThreshold === true,
  };
}

function parseColumnEvidence(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): ColumnEvidenceRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.source !== "executed") {
    return undefined;
  }
  const objectValue = record.object;
  if (!objectValue || typeof objectValue !== "object" || Array.isArray(objectValue)) {
    return undefined;
  }
  const objectRecord = objectValue as Record<string, unknown>;
  const object = normalizeObjectRef(
    {
      name: asString(objectRecord.name) ?? "",
      ...(asString(objectRecord.database) ? { database: asString(objectRecord.database)! } : {}),
      ...(asString(objectRecord.schema) ? { schema: asString(objectRecord.schema)! } : {}),
    },
    databaseKind,
  );
  const column = asString(record.column);
  if (!object || !column) {
    return undefined;
  }
  const objectKey = objectRefKey(object);
  const columnKey = columnUsageKey(objectKey, column);
  const firstSeenAt = isIsoTimestamp(record.firstSeenAt) ? record.firstSeenAt : undefined;
  const lastSeenAt = isIsoTimestamp(record.lastSeenAt) ? record.lastSeenAt : undefined;
  const observations = asNumber(record.observations);
  const distinctDays = asNumber(record.distinctDays);
  if (!columnKey || !firstSeenAt || !lastSeenAt || observations === undefined || distinctDays === undefined) {
    return undefined;
  }
  const days = parseUtcDays(record.days, EXECUTED_EVIDENCE_LIMITS.maxDaysPerRecord);
  const safeObservations = Math.max(0, observations);
  const safeDays = Math.max(0, distinctDays);
  return {
    columnKey,
    objectKey,
    object,
    column,
    ...(asString(record.databaseKind) ? { databaseKind: asString(record.databaseKind)! } : {}),
    source: "executed",
    observations: safeObservations,
    distinctDays: safeDays,
    ...(days !== undefined ? { days } : {}),
    firstSeenAt,
    lastSeenAt,
    belowThreshold: !isExecutedEvidenceEligible(safeObservations, safeDays),
  };
}

/**
 * Parse persisted state defensively. Unknown versions and malformed records are
 * dropped rather than trusted; no record can inject SQL text because only the
 * documented identifier/counter fields survive.
 */
export function parseJoinKnowledgeState(
  value: unknown,
  databaseKind?: IdentityDatabaseKind,
): JoinKnowledgeState {
  const empty: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return empty;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return empty;
  }
  const relationOverrides = Array.isArray(record.relationOverrides)
    ? record.relationOverrides
        .map((entry) => parseRelationOverride(entry, databaseKind))
        .filter((entry): entry is JoinRelationOverride => !!entry)
    : [];
  const relationScoreOverrides = Array.isArray(record.relationScoreOverrides)
    ? record.relationScoreOverrides
        .map((entry) => parseRelationScoreOverride(entry, databaseKind))
        .filter((entry): entry is JoinRelationScoreOverride => !!entry)
    : [];
  const objectOverrides = Array.isArray(record.objectOverrides)
    ? record.objectOverrides
        .map((entry) => parseObjectPreference(entry, databaseKind))
        .filter((entry): entry is ObjectPreferenceOverride => !!entry)
    : [];
  const relationEvidence = Array.isArray(record.relationEvidence)
    ? record.relationEvidence
        .map((entry) => parseRelationEvidence(entry, databaseKind))
        .filter((entry): entry is JoinRelationEvidenceRecord => !!entry)
    : [];
  const objectEvidence = Array.isArray(record.objectEvidence)
    ? record.objectEvidence
        .map((entry) => parseObjectEvidence(entry, databaseKind))
        .filter((entry): entry is ObjectEvidenceRecord => !!entry)
    : [];
  const executedEvents = parseExecutionEvents(
    record.executedEvents,
    EXECUTED_EVIDENCE_LIMITS.maxRecentExecutionKeys,
  );
  const columnEvidence = Array.isArray(record.columnEvidence)
    ? record.columnEvidence
        .map((entry) => parseColumnEvidence(entry, databaseKind))
        .filter((entry): entry is ColumnEvidenceRecord => !!entry)
    : [];
  return {
    ...empty,
    relationOverrides,
    relationScoreOverrides,
    objectOverrides,
    relationEvidence,
    objectEvidence,
    ...(columnEvidence.length > 0 ? { columnEvidence } : {}),
    ...(executedEvents.length > 0 ? { executedEvents } : {}),
    ...(record.executedTruncated === true ? { executedTruncated: true } : {}),
    savedAt: isIsoTimestamp(record.savedAt) ? record.savedAt : undefined,
  };
}

export class JoinKnowledgeStore {
  private relationOverrides: JoinRelationOverride[];
  private readonly relationScoreOverrides: JoinRelationScoreOverride[];
  private objectOverrides: ObjectPreferenceOverride[];
  private readonly relationEvidence: JoinRelationEvidenceRecord[];
  private readonly objectEvidence: ObjectEvidenceRecord[];
  /** Executed column usage keyed by `columnKey`. */
  private readonly columnEvidence = new Map<string, ColumnEvidenceRecord>();
  private savedAt: string | undefined;
  private executedTruncated: boolean;
  private readonly limits: ExecutedEvidenceLimits;
  /**
   * Counted execution keys. The ledger is persisted so a duplicate delivery
   * after a restart is still rejected; keys are opaque and contain no SQL.
   */
  private readonly recentExecutionKeys = new Set<string>();

  constructor(
    state: JoinKnowledgeState = {
      version: 1,
      relationOverrides: [],
      relationScoreOverrides: [],
      objectOverrides: [],
      relationEvidence: [],
      objectEvidence: [],
    },
    options: JoinKnowledgeStoreOptions = {},
  ) {
    this.limits = { ...EXECUTED_EVIDENCE_LIMITS, ...options.limits };
    this.relationOverrides = [...state.relationOverrides];
    this.relationScoreOverrides = [...(state.relationScoreOverrides ?? [])];
    this.objectOverrides = [...state.objectOverrides];
    this.relationEvidence = [...state.relationEvidence];
    this.objectEvidence = [...state.objectEvidence];
    for (const entry of state.columnEvidence ?? []) {
      this.columnEvidence.set(entry.columnKey, { ...entry });
    }
    this.savedAt = state.savedAt;
    this.executedTruncated = state.executedTruncated === true;
    for (const key of state.executedEvents ?? []) {
      this.rememberExecutionKey(key);
    }
  }

  static fromState(
    value: unknown,
    databaseKind?: IdentityDatabaseKind,
    options: JoinKnowledgeStoreOptions = {},
  ): JoinKnowledgeStore {
    return new JoinKnowledgeStore(
      parseJoinKnowledgeState(value, databaseKind),
      options,
    );
  }

  getState(savedAt?: string): JoinKnowledgeState {
    const timestamp = savedAt ?? this.savedAt;
    const executedEvents = [...this.recentExecutionKeys];
    return {
      version: 1,
      relationOverrides: this.relationOverrides.map((entry) => ({ ...entry })),
      relationScoreOverrides: this.relationScoreOverrides.map((entry) => ({ ...entry })),
      objectOverrides: this.objectOverrides.map((entry) => ({ ...entry })),
      relationEvidence: this.relationEvidence.map((entry) => ({
        ...entry,
        ...(entry.days ? { days: [...entry.days] } : {}),
      })),
      objectEvidence: this.objectEvidence.map((entry) => ({
        ...entry,
        ...(entry.days ? { days: [...entry.days] } : {}),
      })),
      ...(this.columnEvidence.size > 0
        ? {
            columnEvidence: [...this.columnEvidence.values()].map((entry) => ({
              ...entry,
              object: { ...entry.object },
              ...(entry.days ? { days: [...entry.days] } : {}),
            })),
          }
        : {}),
      ...(executedEvents.length > 0 ? { executedEvents } : {}),
      ...(this.executedTruncated ? { executedTruncated: true } : {}),
      ...(timestamp ? { savedAt: timestamp } : {}),
    };
  }

  getRelationOverrides(): readonly JoinRelationOverride[] {
    return this.relationOverrides;
  }

  getRelationScoreOverrides(): readonly JoinRelationScoreOverride[] {
    return this.relationScoreOverrides;
  }

  getRelationEvidence(): readonly JoinRelationEvidenceRecord[] {
    return this.relationEvidence;
  }

  getActiveRelationScoreOverride(relationKey: string): JoinRelationScoreOverride | undefined {
    const active = this.relationScoreOverrides.filter(
      (entry) => entry.relationKey === relationKey && !entry.revertedAt,
    );
    return active[active.length - 1];
  }

  appendRelationScoreOverride(
    input: AppendRelationScoreOverrideInput,
  ): JoinRelationScoreOverride {
    if (
      !Number.isInteger(input.adjustment)
      || input.adjustment < -5
      || input.adjustment > 5
    ) {
      throw new Error("JOIN relation score adjustment must be an integer from -5 to 5.");
    }
    const canonical = canonicalizeRelation(input.relation, input.databaseKind, input.defaults);
    if (!canonical) {
      throw new Error("Cannot adjust the score of an invalid JOIN relation.");
    }
    const id = input.id ?? nextId("score", input.now, this.relationScoreOverrides.length + 1);
    const active = this.relationScoreOverrides.filter(
      (entry) => entry.relationKey === canonical.key && !entry.revertedAt,
    );
    for (const entry of active) {
      this.revertRelationScoreOverride(entry.id, input.now, id);
    }
    const override: JoinRelationScoreOverride = {
      id,
      relationKey: canonical.key,
      relation: canonical,
      ...(input.databaseKind ? { databaseKind: input.databaseKind } : {}),
      adjustment: input.adjustment,
      createdAt: input.now,
    };
    this.relationScoreOverrides.push(override);
    return override;
  }

  revertRelationScoreOverride(
    id: string,
    now: string,
    replacedBy?: string,
  ): boolean {
    const target = this.relationScoreOverrides.find((entry) => entry.id === id);
    if (!target || target.revertedAt) {
      return false;
    }
    target.revertedAt = now;
    if (replacedBy) {
      target.replacedBy = replacedBy;
    }
    return true;
  }

  getObjectOverrides(): readonly ObjectPreferenceOverride[] {
    return this.objectOverrides;
  }

  /**
   * Append a confirm/block/favorite decision.
   *
   * Confirm and block replace each other (Stage 1 behavior). A favorite is a
   * separate, weaker preference: it never replaces a confirmation or a block
   * and is not replaced by them, so reverting a block can restore the favorite.
   */
  appendRelationOverride(input: AppendRelationOverrideInput): JoinRelationOverride {
    const canonical = canonicalizeRelation(
      input.relation,
      input.databaseKind,
      input.defaults,
    );
    if (!canonical) {
      throw new Error("Cannot append a JOIN decision for an invalid relation identity.");
    }
    const id = input.id ?? nextId("rel", input.now, this.relationOverrides.length + 1);
    const active = this.relationOverrides.filter(
      (entry) => entry.relationKey === canonical.key && !entry.revertedAt,
    );
    const replaced = input.kind === "favorite"
      ? active.filter((entry) => entry.kind === "favorite")
      : active.filter((entry) => entry.kind !== "favorite");
    for (const entry of replaced) {
      this.revertRelationOverride(entry.id, input.now, id);
    }
    const override: JoinRelationOverride = {
      id,
      relationKey: canonical.key,
      kind: input.kind,
      relation: canonical,
      ...(input.databaseKind ? { databaseKind: input.databaseKind } : {}),
      createdAt: input.now,
    };
    this.relationOverrides.push(override);
    return override;
  }

  revertRelationOverride(
    id: string,
    now: string,
    replacedBy?: string,
  ): boolean {
    const target = this.relationOverrides.find((entry) => entry.id === id);
    if (!target || target.revertedAt) {
      return false;
    }
    target.revertedAt = now;
    if (replacedBy) {
      target.replacedBy = replacedBy;
    }
    return true;
  }

  /**
   * Precedence for active decisions: block > confirm > favorite. A favorite
   * may coexist with a confirmation and remains available when the stronger
   * decision is reverted.
   */
  getActiveRelationOverride(
    relationKey: string,
  ): JoinRelationOverride | undefined {
    const active = this.relationOverrides.filter(
      (entry) => entry.relationKey === relationKey && !entry.revertedAt,
    );
    return active.find((entry) => entry.kind === "block")
      ?? active.find((entry) => entry.kind === "confirm")
      ?? active.find((entry) => entry.kind === "favorite");
  }

  getRelationDecision(
    relationKey: string,
  ): "confirmed" | "blocked" | "favorite" | undefined {
    const active = this.getActiveRelationOverride(relationKey);
    if (!active) {
      return undefined;
    }
    if (active.kind === "block") {
      return "blocked";
    }
    return active.kind === "confirm" ? "confirmed" : "favorite";
  }

  getActiveFavorite(
    relationKey: string,
  ): JoinRelationOverride | undefined {
    const active = this.relationOverrides.filter(
      (entry) => entry.relationKey === relationKey
        && entry.kind === "favorite"
        && !entry.revertedAt,
    );
    return active[active.length - 1];
  }

  /** Append a pin/boost/demote/exclude. At most one active preference per object. */
  appendObjectPreference(
    input: AppendObjectPreferenceInput,
  ): ObjectPreferenceOverride {
    if (input.band !== undefined && !isBoostBand(input.band)) {
      throw new Error(`Object boost band must be ${OBJECT_BANDS.boostMin}-${OBJECT_BANDS.boostMax}.`);
    }
    const pinOrderValue = input.pinOrder ?? 0;
    if (input.kind === "pin" && !Number.isFinite(pinOrderValue)) {
      throw new Error("Object pin order must be a finite number.");
    }
    const object = normalizeObjectRef(
      input.object,
      input.databaseKind,
      input.defaults,
    );
    if (!object) {
      throw new Error("Cannot append an object preference without a database/schema/name identity.");
    }
    const key = objectRefKey(object);
    const existing = this.getActiveObjectPreference(key);
    const id = input.id ?? nextId("obj", input.now, this.objectOverrides.length + 1);
    if (existing) {
      this.revertObjectPreference(existing.id, input.now, id);
    }
    const override: ObjectPreferenceOverride = {
      id,
      objectKey: key,
      object,
      kind: input.kind,
      ...(input.kind === "boost"
        ? { band: Math.round(input.band ?? OBJECT_BANDS.boostMin) }
        : {}),
      ...(input.kind === "pin"
        ? { pinOrder: Math.max(0, Math.min(99, Math.round(pinOrderValue))) }
        : {}),
      ...(input.databaseKind ? { databaseKind: input.databaseKind } : {}),
      createdAt: input.now,
    };
    this.objectOverrides.push(override);
    return override;
  }

  revertObjectPreference(
    id: string,
    now: string,
    replacedBy?: string,
  ): boolean {
    const target = this.objectOverrides.find((entry) => entry.id === id);
    if (!target || target.revertedAt) {
      return false;
    }
    target.revertedAt = now;
    if (replacedBy) {
      target.replacedBy = replacedBy;
    }
    return true;
  }

  getActiveObjectPreference(
    objectKey: string,
  ): ObjectPreferenceOverride | undefined {
    const active = this.objectOverrides.filter(
      (entry) => entry.objectKey === objectKey && !entry.revertedAt,
    );
    return active.find((entry) => entry.kind === "exclude") ?? active[0];
  }

  getActiveObjectPreferences(): ReadonlyArray<ObjectPreferenceOverride> {
    return this.objectOverrides.filter((entry) => !entry.revertedAt);
  }

  upsertRelationEvidence(record: JoinRelationEvidenceRecord): void {
    const index = this.relationEvidence.findIndex(
      (entry) => entry.relationKey === record.relationKey && entry.source === record.source,
    );
    if (index >= 0) {
      this.relationEvidence[index] = { ...record };
      return;
    }
    this.relationEvidence.push({ ...record });
  }

  removeRelationEvidence(relationKey: string, source: JoinRelationEvidenceRecord["source"]): boolean {
    let removed = false;
    for (let index = this.relationEvidence.length - 1; index >= 0; index -= 1) {
      const entry = this.relationEvidence[index];
      if (entry.relationKey === relationKey && entry.source === source) {
        this.relationEvidence.splice(index, 1);
        removed = true;
      }
    }
    return removed;
  }

  upsertObjectEvidence(record: ObjectEvidenceRecord): void {
    const index = this.objectEvidence.findIndex(
      (entry) => entry.objectKey === record.objectKey && entry.source === record.source,
    );
    if (index >= 0) {
      this.objectEvidence[index] = { ...record };
      return;
    }
    this.objectEvidence.push({ ...record });
  }

  /**
   * Count one successful statement execution as executed evidence (`0_4_`).
   *
   * Each relation and object is counted once per execution. Repeated execution
   * keys are ignored so duplicate delivery of one event cannot inflate the
   * thresholds. Only identifiers, counters and timestamps are written.
   */
  recordExecutedStatement(input: RecordExecutedStatementInput): RecordExecutedStatementOutcome {
    if (this.recentExecutionKeys.has(input.executionKey)) {
      return "duplicate";
    }
    if (
      input.relations.length === 0
      && input.objects.length === 0
      && (input.columns?.length ?? 0) === 0
    ) {
      return "empty";
    }
    this.rememberExecutionKey(input.executionKey);
    const day = input.now.slice(0, 10);
    const hasValidDay = UTC_DAY_PATTERN.test(day);
    let recordedAny = false;

    const executedRelationCount = (): number =>
      this.relationEvidence.filter((entry) => entry.source === "executed").length;
    const executedObjectCount = (): number =>
      this.objectEvidence.filter((entry) => entry.source === "executed").length;

    // One execution counts a relation once even if the input repeats it.
    const relationsByKey = new Map(input.relations.map((relation) => [relation.key, relation]));
    for (const relation of relationsByKey.values()) {
      const existing = this.relationEvidence.find(
        (entry) => entry.relationKey === relation.key && entry.source === "executed",
      );
      if (!existing && executedRelationCount() >= this.limits.maxRelationRecords) {
        this.executedTruncated = true;
        continue;
      }
      const observations = (existing?.observations ?? 0) + 1;
      const days = new Set(existing?.days ?? []);
      if (existing && days.size === 0 && existing.distinctDays > 0) {
        // Legacy record without the day set: seed the last recorded day so a
        // repeated day is not counted again.
        days.add(existing.lastSeenAt.slice(0, 10));
      }
      let distinctDays = Math.max(existing?.distinctDays ?? 0, days.size);
      if (hasValidDay && !days.has(day)) {
        if (days.size < this.limits.maxDaysPerRecord) {
          days.add(day);
          distinctDays = Math.max(distinctDays + 1, days.size);
        } else {
          this.executedTruncated = true;
        }
      }
      this.upsertRelationEvidence({
        relationKey: relation.key,
        relation,
        ...(input.databaseKind ? { databaseKind: input.databaseKind } : {}),
        source: "executed",
        observations,
        distinctDays,
        ...(hasValidDay || existing?.days ? { days: [...days] } : {}),
        firstSeenAt: earlierTimestamp(existing?.firstSeenAt, input.now),
        lastSeenAt: laterTimestamp(existing?.lastSeenAt, input.now),
        belowThreshold: !isExecutedEvidenceEligible(observations, distinctDays),
      });
      recordedAny = true;
    }

    const kindsByObject = new Map<string, { object: ObjectRef; kinds: Set<ObjectUsageKind> }>();
    for (const entry of input.objects) {
      const key = objectRefKey(entry.object);
      const group = kindsByObject.get(key) ?? { object: entry.object, kinds: new Set() };
      group.kinds.add(entry.kind);
      kindsByObject.set(key, group);
    }
    for (const [objectKey, group] of kindsByObject) {
      const existing = this.objectEvidence.find(
        (entry) => entry.objectKey === objectKey && entry.source === "executed",
      );
      if (!existing && executedObjectCount() >= this.limits.maxObjectRecords) {
        this.executedTruncated = true;
        continue;
      }
      const usage = { ...(existing?.usage ?? { select: 0, insert: 0, update: 0, delete: 0 }) };
      for (const kind of group.kinds) {
        usage[kind] += 1;
      }
      const observations = (existing?.observations ?? 0) + 1;
      const days = new Set(existing?.days ?? []);
      if (existing && days.size === 0 && (existing.distinctDays ?? 0) > 0) {
        days.add(existing.lastSeenAt.slice(0, 10));
      }
      let distinctDays = Math.max(existing?.distinctDays ?? 0, days.size);
      if (hasValidDay && !days.has(day)) {
        if (days.size < this.limits.maxDaysPerRecord) {
          days.add(day);
          distinctDays = Math.max(distinctDays + 1, days.size);
        } else {
          this.executedTruncated = true;
        }
      }
      const band = executedObjectBandForUsage(usage, observations, distinctDays);
      this.upsertObjectEvidence({
        objectKey,
        object: group.object,
        source: "executed",
        usage,
        // Informational only: ranking recomputes the band from usage, and
        // `belowThreshold` is authoritative. Stored inside the parser range.
        bestBand: band ?? OBJECT_BANDS.learnedMax,
        observations,
        distinctDays,
        ...(hasValidDay || existing?.days ? { days: [...days] } : {}),
        firstSeenAt: earlierTimestamp(existing?.firstSeenAt, input.now),
        lastSeenAt: laterTimestamp(existing?.lastSeenAt, input.now),
        belowThreshold: band === undefined,
      });
      recordedAny = true;
    }

    // One execution counts a column once, however often the statement uses it.
    const columnsByKey = new Map<string, { object: ObjectRef; column: string }>();
    for (const entry of input.columns ?? []) {
      const key = columnUsageKey(objectRefKey(entry.object), entry.column);
      if (key && !columnsByKey.has(key)) {
        columnsByKey.set(key, entry);
      }
    }
    for (const [columnKey, entry] of columnsByKey) {
      const existing = this.columnEvidence.get(columnKey);
      if (!existing && this.columnEvidence.size >= this.limits.maxColumnRecords) {
        this.executedTruncated = true;
        continue;
      }
      const observations = (existing?.observations ?? 0) + 1;
      const days = new Set(existing?.days ?? []);
      let distinctDays = Math.max(existing?.distinctDays ?? 0, days.size);
      if (hasValidDay && !days.has(day)) {
        if (days.size < this.limits.maxDaysPerRecord) {
          days.add(day);
          distinctDays = Math.max(distinctDays + 1, days.size);
        } else {
          this.executedTruncated = true;
        }
      }
      this.columnEvidence.set(columnKey, {
        columnKey,
        objectKey: objectRefKey(entry.object),
        object: { ...entry.object },
        column: existing?.column ?? entry.column,
        ...(input.databaseKind ? { databaseKind: input.databaseKind } : {}),
        source: "executed",
        observations,
        distinctDays,
        ...(hasValidDay || existing?.days ? { days: [...days] } : {}),
        firstSeenAt: earlierTimestamp(existing?.firstSeenAt, input.now),
        lastSeenAt: laterTimestamp(existing?.lastSeenAt, input.now),
        belowThreshold: !isExecutedEvidenceEligible(observations, distinctDays),
      });
      recordedAny = true;
    }
    return recordedAny ? "recorded" : "empty";
  }

  /**
   * Count one explicit FROM completion selection. It is preference evidence:
   * half a query per selection, `select` usage only, never a JOIN relation.
   */
  recordAcceptedObject(input: RecordAcceptedObjectInput): ObjectEvidenceRecord | undefined {
    const object = normalizeObjectRef(input.object, input.databaseKind, input.defaults);
    if (!object) {
      return undefined;
    }
    const objectKey = objectRefKey(object);
    const existing = this.objectEvidence.find(
      (entry) => entry.objectKey === objectKey && entry.source === "accepted",
    );
    const observations = (existing?.observations ?? 0) + 1;
    const band = acceptedObjectBand(observations);
    const record: ObjectEvidenceRecord = {
      objectKey,
      object,
      source: "accepted",
      usage: { select: observations, insert: 0, update: 0, delete: 0 },
      bestBand: band ?? OBJECT_BANDS.learnedMax,
      observations,
      distinctQueries: 0,
      firstSeenAt: existing?.firstSeenAt ?? input.now,
      lastSeenAt: input.now,
      belowThreshold: band === undefined,
    };
    this.upsertObjectEvidence(record);
    return record;
  }

  getAcceptedObjectEvidence(): ObjectEvidenceRecord[] {
    return this.objectEvidence.filter((entry) => entry.source === "accepted");
  }

  /** Remove accepted FROM selections; one object, or all when no key is given. */
  clearAcceptedObjectEvidence(objectKey?: string): number {
    return removeWhere(
      this.objectEvidence,
      (entry) => entry.source === "accepted" && (objectKey === undefined || entry.objectKey === objectKey),
    );
  }

  getExecutedColumnEvidence(): ColumnEvidenceRecord[] {
    return [...this.columnEvidence.values()];
  }

  getExecutedRelationEvidence(): JoinRelationEvidenceRecord[] {
    return this.relationEvidence.filter((entry) => entry.source === "executed");
  }

  getExecutedObjectEvidence(): ObjectEvidenceRecord[] {
    return this.objectEvidence.filter((entry) => entry.source === "executed");
  }

  /** True when a retention limit stopped executed-evidence growth. */
  /** Oldest `firstSeenAt` of any executed record; `undefined` when there is none. */
  getEarliestExecutedAt(): string | undefined {
    let earliest: string | undefined;
    for (const entry of [
      ...this.getExecutedRelationEvidence(),
      ...this.getExecutedObjectEvidence(),
      ...this.getExecutedColumnEvidence(),
    ]) {
      if (earliest === undefined || entry.firstSeenAt < earliest) {
        earliest = entry.firstSeenAt;
      }
    }
    return earliest;
  }

  isExecutedTruncated(): boolean {
    return this.executedTruncated;
  }

  /**
   * Remove only executed evidence. Manual decisions, score adjustments, accepted
   * evidence and workspace evidence are separate records and are untouched.
   */
  clearExecutedEvidence(): { relations: number; objects: number; columns: number } {
    // Deduplication keys are kept on purpose: clearing evidence must not let an
    // already-counted event be counted again.
    const removed = {
      relations: removeWhere(this.relationEvidence, (entry) => entry.source === "executed"),
      objects: removeWhere(this.objectEvidence, (entry) => entry.source === "executed"),
      columns: this.columnEvidence.size,
    };
    this.columnEvidence.clear();
    if (removed.relations > 0 || removed.objects > 0 || removed.columns > 0) {
      this.executedTruncated = false;
    }
    return removed;
  }

  /** Remove one executed relation record; manual/workspace evidence stays. */
  deleteExecutedRelationEvidence(relationKey: string): boolean {
    const removed = removeWhere(
      this.relationEvidence,
      (entry) => entry.source === "executed" && entry.relationKey === relationKey,
    );
    return removed > 0;
  }

  /**
   * Remove one executed object record and the executed column usage of that
   * object; manual/workspace evidence stays.
   */
  deleteExecutedObjectEvidence(objectKey: string): boolean {
    const removed = removeWhere(
      this.objectEvidence,
      (entry) => entry.source === "executed" && entry.objectKey === objectKey,
    );
    let removedColumns = 0;
    for (const [key, entry] of this.columnEvidence) {
      if (entry.objectKey === objectKey) {
        this.columnEvidence.delete(key);
        removedColumns += 1;
      }
    }
    return removed > 0 || removedColumns > 0;
  }

  private rememberExecutionKey(key: string): void {
    this.recentExecutionKeys.add(key);
    if (this.recentExecutionKeys.size > this.limits.maxRecentExecutionKeys) {
      const oldest = this.recentExecutionKeys.values().next().value;
      if (oldest !== undefined) {
        this.recentExecutionKeys.delete(oldest);
      }
    }
  }

  /** Serializable decision payload; never contains SQL text. */
  buildSnapshot(): JoinKnowledgeSnapshot {
    const activeByKey = new Map<string, JoinRelationOverride[]>();
    for (const entry of this.relationOverrides) {
      if (entry.revertedAt) {
        continue;
      }
      const group = activeByKey.get(entry.relationKey) ?? [];
      group.push(entry);
      activeByKey.set(entry.relationKey, group);
    }
    const relations: JoinKnowledgeRelationSnapshot[] = Array.from(
      activeByKey.entries(),
      ([key, group]) => {
        const winner = group.find((entry) => entry.kind === "block")
          ?? group.find((entry) => entry.kind === "confirm")
          ?? group.find((entry) => entry.kind === "favorite")!;
        return {
          key,
          decision: winner.kind === "block"
            ? "blocked"
            : winner.kind === "confirm"
              ? "confirmed"
              : "favorite",
          ...(group.some((entry) => entry.kind === "favorite")
            ? { favorite: true }
            : {}),
          relation: winner.relation,
        };
      },
    );
    const activeObjectByKey = new Map<string, ObjectPreferenceOverride>();
    for (const entry of this.objectOverrides) {
      if (entry.revertedAt) {
        continue;
      }
      const existing = activeObjectByKey.get(entry.objectKey);
      // Exclude outranks pin/boost/demote if an older build persisted both.
      if (!existing || entry.kind === "exclude") {
        activeObjectByKey.set(entry.objectKey, entry);
      }
    }
    const objectPreferences: ObjectPreferenceSnapshot[] = Array.from(
      activeObjectByKey.values(),
      (entry) => ({
        key: entry.objectKey,
        kind: entry.kind,
        object: { ...entry.object },
        ...(entry.band !== undefined ? { band: entry.band } : {}),
        ...(entry.pinOrder !== undefined ? { pinOrder: entry.pinOrder } : {}),
      }),
    );
    const relationScoreOverrides = this.relationScoreOverrides
      .filter((entry) => !entry.revertedAt)
      .map((entry) => ({ ...entry }));
    // The published snapshot carries counters only. The day set stays in local
    // persistence and never crosses the host/LSP or webview boundary.
    const executedRelations = this.getExecutedRelationEvidence().map((entry) => {
      const published = { ...entry };
      delete published.days;
      return published;
    });
    const executedObjects = this.getExecutedObjectEvidence().map((entry) => {
      const published = { ...entry };
      delete published.days;
      return {
        ...published,
        object: { ...entry.object },
        usage: { ...entry.usage },
      };
    });
    const executedColumns = this.getExecutedColumnEvidence().map((entry) => {
      const published = { ...entry, object: { ...entry.object } };
      delete published.days;
      return published;
    });
    const executed: JoinKnowledgeExecutedSnapshot | undefined = executedRelations.length > 0
      || executedObjects.length > 0
      || executedColumns.length > 0
      ? {
          relations: executedRelations,
          objects: executedObjects,
          ...(executedColumns.length > 0 ? { columns: executedColumns } : {}),
        }
      : undefined;
    const acceptedObjects = this.getAcceptedObjectEvidence().map((entry) => ({
      ...entry,
      object: { ...entry.object },
      usage: { ...entry.usage },
    }));
    return {
      version: 1,
      relations,
      objectPreferences,
      ...(relationScoreOverrides.length > 0 ? { relationScoreOverrides } : {}),
      ...(executed ? { executed } : {}),
      ...(acceptedObjects.length > 0 ? { acceptedObjects } : {}),
    };
  }

  describe(): JoinKnowledgeDiagnostics {
    const activeRelations = this.relationOverrides.filter((entry) => !entry.revertedAt);
    const activeObjects = this.objectOverrides.filter((entry) => !entry.revertedAt);
    const countObjects = (kind: ObjectPreferenceKind): number =>
      activeObjects.filter((entry) => entry.kind === kind).length;
    return {
      relationOverrides: {
        active: activeRelations.length,
        reverted: this.relationOverrides.length - activeRelations.length,
        confirmed: activeRelations.filter((entry) => entry.kind === "confirm").length,
        blocked: activeRelations.filter((entry) => entry.kind === "block").length,
        favorites: activeRelations.filter((entry) => entry.kind === "favorite").length,
      },
      objectOverrides: {
        active: activeObjects.length,
        reverted: this.objectOverrides.length - activeObjects.length,
        pinned: countObjects("pin"),
        boosted: countObjects("boost"),
        demoted: countObjects("demote"),
        excluded: countObjects("exclude"),
      },
      relationEvidence: this.relationEvidence.length,
      objectEvidence: this.objectEvidence.length,
      executed: {
        relationsEligible: this.getExecutedRelationEvidence()
          .filter((entry) => !entry.belowThreshold).length,
        relationsBelowThreshold: this.getExecutedRelationEvidence()
          .filter((entry) => entry.belowThreshold).length,
        objectsEligible: this.getExecutedObjectEvidence()
          .filter((entry) => !entry.belowThreshold).length,
        objectsBelowThreshold: this.getExecutedObjectEvidence()
          .filter((entry) => entry.belowThreshold).length,
        columnsEligible: this.getExecutedColumnEvidence()
          .filter((entry) => !entry.belowThreshold).length,
        columnsBelowThreshold: this.getExecutedColumnEvidence()
          .filter((entry) => entry.belowThreshold).length,
        truncated: this.executedTruncated,
      },
    };
  }
}

export interface BuildJoinKnowledgeIndexOptions {
  /** Injected clock (ISO timestamp) for evidence freshness. */
  now?: string;
}

/** Build constant-time lookup maps for the completion path. */
export function buildJoinKnowledgeIndex(
  snapshot?: JoinKnowledgeSnapshot | undefined,
  options: BuildJoinKnowledgeIndexOptions = {},
): JoinKnowledgeIndex {
  const now = options.now;
  const relationEvidenceStrength = new Map<string, JoinEvidenceStrength>();
  const mergeStrength = (key: string, next: JoinEvidenceStrength): void => {
    const previous = relationEvidenceStrength.get(key);
    relationEvidenceStrength.set(key, previous
      ? {
          breadth: Math.max(previous.breadth, next.breadth),
          freshness: Math.max(previous.freshness, next.freshness),
        }
      : next);
  };
  const confirmedRelations = new Map<string, RelationIdentity>();
  const favoriteRelations = new Map<string, RelationIdentity>();
  const relationScoreAdjustments = new Map<string, number>();
  const blockedRelations = new Set<string>();
  const objectPreferences = new Map<string, ObjectPreferenceSnapshot>();
  const workspaceRelations = new Map<string, WorkspaceRelationSnapshot>();
  const workspaceObjectBands = new Map<string, number>();
  const executedRelations = new Map<string, JoinRelationEvidenceRecord>();
  const executedObjectBands = new Map<string, number>();
  const acceptedObjectBands = new Map<string, number>();
  const columnBands = new Map<string, Map<string, number>>();
  const executedColumnBands = new Map<string, Map<string, number>>();
  const mergeColumnBand = (
    target: Map<string, Map<string, number>>,
    objectKey: string,
    columnKey: string,
    band: number,
  ): void => {
    const column = columnKey.slice(objectKey.length + 1);
    const perObject = target.get(objectKey) ?? new Map<string, number>();
    const previous = perObject.get(column);
    perObject.set(column, previous === undefined ? band : Math.min(previous, band));
    target.set(objectKey, perObject);
  };

  for (const relation of snapshot?.relations ?? []) {
    if (relation.decision === "blocked") {
      blockedRelations.add(relation.key);
      confirmedRelations.delete(relation.key);
      favoriteRelations.delete(relation.key);
      continue;
    }
    if (blockedRelations.has(relation.key)) {
      continue;
    }
    if (relation.decision === "confirmed") {
      confirmedRelations.set(relation.key, relation.relation);
    }
    if (relation.favorite === true || relation.decision === "favorite") {
      favoriteRelations.set(relation.key, relation.relation);
    }
  }
  for (const preference of snapshot?.objectPreferences ?? []) {
    objectPreferences.set(preference.key, preference);
  }
  const latestScoreOverrides = new Map<string, JoinRelationScoreOverride>();
  for (const override of snapshot?.relationScoreOverrides ?? []) {
    if (!override.revertedAt) {
      latestScoreOverrides.set(override.relationKey, override);
    }
  }
  for (const [key, override] of latestScoreOverrides) {
    // A zero value means "neutral": it must clear an older active value and
    // never contribute a score segment on its own.
    if (override.adjustment !== 0) {
      relationScoreAdjustments.set(key, override.adjustment);
    }
  }
  for (const relation of snapshot?.workspace?.relations ?? []) {
    if (relation.belowThreshold || blockedRelations.has(relation.key)) {
      continue;
    }
    mergeStrength(relation.key, {
      breadth: joinEvidenceBreadth(
        relation.distinctFiles,
        relation.weightedQueries ?? relation.distinctQueries,
      ),
      freshness: joinEvidenceFreshness(relation.lastSeenAt, now),
    });
    if (!confirmedRelations.has(relation.key)) {
      workspaceRelations.set(relation.key, relation);
    }
  }
  for (const object of snapshot?.workspace?.objects ?? []) {
    if (!object.belowThreshold && object.band !== undefined) {
      workspaceObjectBands.set(object.key, object.band);
    }
  }
  for (const record of snapshot?.executed?.relations ?? []) {
    // Blocks are applied first, and confirmed relations already sit above
    // executed evidence, so neither needs an executed entry.
    if (
      record.source !== "executed"
      || record.belowThreshold
      || blockedRelations.has(record.relationKey)
    ) {
      continue;
    }
    mergeStrength(record.relationKey, {
      breadth: joinEvidenceBreadth(record.distinctDays, record.observations),
      freshness: joinEvidenceFreshness(record.lastSeenAt, now),
    });
    if (confirmedRelations.has(record.relationKey)) {
      continue;
    }
    executedRelations.set(record.relationKey, record);
  }
  for (const record of snapshot?.executed?.objects ?? []) {
    if (record.source !== "executed") {
      continue;
    }
    const band = executedObjectBandForUsage(
      record.usage,
      record.observations ?? 0,
      record.distinctDays ?? 0,
    );
    if (band === undefined) {
      continue;
    }
    executedObjectBands.set(record.objectKey, band);
  }

  for (const record of snapshot?.acceptedObjects ?? []) {
    const band = record.source === "accepted"
      ? acceptedObjectBand(record.observations ?? 0)
      : undefined;
    if (band !== undefined) {
      acceptedObjectBands.set(record.objectKey, band);
    }
  }
  for (const column of snapshot?.workspace?.columns ?? []) {
    const band = workspaceColumnBand(column.distinctFiles, column.distinctQueries);
    const objectKey = objectRefKey(column.object);
    if (band !== undefined && column.key.startsWith(`${objectKey}\u0000`)) {
      mergeColumnBand(columnBands, objectKey, column.key, band);
    }
  }
  for (const column of snapshot?.executed?.columns ?? []) {
    const band = column.source === "executed"
      ? executedColumnBand(column.observations, column.distinctDays)
      : undefined;
    if (band !== undefined && column.columnKey.startsWith(`${column.objectKey}\u0000`)) {
      mergeColumnBand(executedColumnBands, column.objectKey, column.columnKey, band);
    }
  }

  return {
    confirmedRelations,
    blockedRelations,
    favoriteRelations,
    relationScoreAdjustments,
    workspaceRelations,
    executedRelations,
    relationEvidenceStrength,
    columnBands,
    executedColumnBands,
    workspaceObjectBands,
    executedObjectBands,
    acceptedObjectBands,
    objectPreferences,
    hasObjectPreferences: objectPreferences.size > 0
      || workspaceObjectBands.size > 0
      || executedObjectBands.size > 0
      || acceptedObjectBands.size > 0,
  };
}

/**
 * Merge an incremental workspace-index delta into a full snapshot. Manual
 * decisions are untouched; the returned snapshot is safe to publish.
 */
export function mergeJoinKnowledgeIndexDelta(
  snapshot: JoinKnowledgeSnapshot,
  delta: WorkspaceIndexDeltaLike,
): JoinKnowledgeSnapshot {
  const current = snapshot.workspace ?? {
    version: 1 as const,
    relations: [],
    objects: [],
    truncated: false,
    generatedAt: delta.generatedAt ?? new Date(0).toISOString(),
  };
  const relations = new Map(current.relations.map((entry) => [entry.key, entry]));
  for (const key of delta.relationsRemove ?? []) {
    const existing = relations.get(key);
    if (existing && (existing.acceptedSelections ?? 0) > 0) {
      const acceptedSelections = existing.acceptedSelections ?? 0;
      const weightedQueries = acceptedSelections * 0.5;
      relations.set(key, {
        ...existing,
        observations: acceptedSelections,
        distinctFiles: 0,
        distinctQueries: 0,
        weightedQueries,
        belowThreshold: !isWorkspaceEvidenceEligible(0, 0, weightedQueries),
      });
    } else {
      relations.delete(key);
    }
  }
  for (const entry of delta.relationsUpsert ?? []) {
    const previous = relations.get(entry.key);
    const acceptedSelections = previous?.acceptedSelections ?? 0;
    const weightedQueries = entry.distinctQueries + acceptedSelections * 0.5;
    relations.set(entry.key, {
      ...entry,
      ...(acceptedSelections > 0 ? { acceptedSelections, weightedQueries } : {}),
      belowThreshold: !isWorkspaceEvidenceEligible(
        entry.distinctFiles,
        entry.distinctQueries,
        weightedQueries,
      ),
    });
  }
  const objects = new Map(current.objects.map((entry) => [entry.key, entry]));
  for (const key of delta.objectsRemove ?? []) {
    objects.delete(key);
  }
  for (const entry of delta.objectsUpsert ?? []) {
    objects.set(entry.key, entry);
  }
  const columns = new Map((current.columns ?? []).map((entry) => [entry.key, entry]));
  for (const key of delta.columnsRemove ?? []) {
    columns.delete(key);
  }
  for (const entry of delta.columnsUpsert ?? []) {
    columns.set(entry.key, entry);
  }
  return {
    ...snapshot,
    workspace: {
      version: 1,
      relations: [...relations.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
      objects: [...objects.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
      columns: [...columns.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
      truncated: delta.truncated ?? current.truncated,
      generatedAt: delta.generatedAt ?? current.generatedAt,
    },
  };
}

/** Structural subset used by {@link mergeJoinKnowledgeIndexDelta}. */
export interface WorkspaceIndexDeltaLike {
  /** Accepted from a full `JoinKnowledgeIndexDelta`; the merge itself ignores it. */
  version?: 1;
  relationsUpsert?: WorkspaceRelationSnapshot[];
  relationsRemove?: string[];
  objectsUpsert?: WorkspaceObjectSnapshot[];
  objectsRemove?: string[];
  columnsUpsert?: WorkspaceColumnSnapshot[];
  columnsRemove?: string[];
  truncated?: boolean;
  generatedAt?: string;
}

export interface RelationDecisionExplanation {
  decision: "confirmed" | "blocked" | "favorite" | "none";
  reasons: string[];
}

export function explainRelationDecision(
  index: JoinKnowledgeIndex,
  relationKey: string,
): RelationDecisionExplanation {
  if (index.blockedRelations.has(relationKey)) {
    return {
      decision: "blocked",
      reasons: ["blocked by an explicit manual decision (applied before tiering)"],
    };
  }
  if (index.confirmedRelations.has(relationKey)) {
    return {
      decision: "confirmed",
      reasons: ["explicit per-relation confirmation (tier 0_1_)"],
    };
  }
  if (index.favoriteRelations.has(relationKey)) {
    return {
      decision: "favorite",
      reasons: ["manual favorite preference (tier 0_3_; not confirmation)"],
    };
  }
  return { decision: "none", reasons: ["no explicit relation decision"] };
}

export interface ObjectPreferenceExplanation {
  kind: ObjectPreferenceKind | "none";
  band?: number;
  pinOrder?: number;
  reasons: string[];
}

export function explainObjectPreference(
  index: JoinKnowledgeIndex,
  objectKey: string,
): ObjectPreferenceExplanation {
  const preference = index.objectPreferences.get(objectKey);
  if (!preference) {
    return { kind: "none", reasons: ["no manual object preference"] };
  }
  switch (preference.kind) {
    case "pin":
      return {
        kind: "pin",
        pinOrder: preference.pinOrder,
        reasons: [`manual pin order ${preference.pinOrder ?? 0}; crosses scope/kind, sortText only`],
      };
    case "boost":
      return {
        kind: "boost",
        band: preference.band,
        reasons: [`manual boost band ${String(preference.band ?? 0).padStart(2, "0")}; inside scope/kind/match rank`],
      };
    case "demote":
      return {
        kind: "demote",
        band: OBJECT_BANDS.demote,
        reasons: ["manual demote band 90; inside scope/kind/match rank"],
      };
    case "exclude":
      return {
        kind: "exclude",
        reasons: ["manually excluded from FROM sources"],
      };
  }
}

/** Central object-usage weights/caps used by later learning sources. */
export { OBJECT_RANKING_MODEL };
