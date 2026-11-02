/**
 * Pure workspace SQL index aggregation.
 *
 * The host parses each file once and stores identifier/counter-only records.
 * This module turns those per-file records into the canonical relation/object
 * snapshot consumed by ranking. It performs no I/O and never sees SQL text in
 * its output.
 */

import {
  canonicalRelationDisplay,
  columnUsageKey,
  objectRefKey,
  type ObjectRef,
  type RelationIdentity,
} from "./identity";
import {
  isWorkspaceEvidenceEligible,
  objectBandForUsage,
  WORKSPACE_COLUMN_LIMIT,
  type ObjectUsageKind,
} from "./model";
import type {
  JoinKnowledgeIndexDelta,
  ObjectUsageCounters,
  WorkspaceColumnSnapshot,
  WorkspaceIndexSnapshot,
  WorkspaceObjectSnapshot,
  WorkspaceRelationSnapshot,
} from "./types";

export type WorkspaceEvidenceConfidence = "exact" | "probable";

export type WorkspaceSkipReason =
  | "ddl"
  | "parse-error"
  | "unsupported"
  | "ambiguous"
  | "using"
  | "no-columns"
  | "subquery"
  | "or"
  | "non-equality"
  | "unresolved"
  | "too-large"
  | "ignored"
  | "untitled";

export interface WorkspaceFileRelationContribution {
  relation: RelationIdentity;
  /** Salted statement fingerprint; local to the workspace index. */
  fingerprint: string;
}

export interface WorkspaceFileObjectContribution {
  object: ObjectRef;
  kind: ObjectUsageKind;
  /** Salted statement fingerprint; local to the workspace index. */
  fingerprint: string;
  confidence: WorkspaceEvidenceConfidence;
}

/** One column of one table referenced by a statement (identifiers only). */
export interface WorkspaceFileColumnContribution {
  object: ObjectRef;
  column: string;
  /** Salted statement fingerprint; local to the workspace index. */
  fingerprint: string;
}

/** One persisted per-file record. No SQL text is ever stored. */
export interface WorkspaceFileIndexRecord {
  relPath: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  dirty: boolean;
  open: boolean;
  /** Salted fingerprints of every statement that contributed evidence. */
  fingerprints: string[];
  relations: WorkspaceFileRelationContribution[];
  objects: WorkspaceFileObjectContribution[];
  /**
   * Column usage. `undefined` marks a record written before column ranking;
   * the host re-parses such files once instead of trusting the content hash.
   */
  columns?: WorkspaceFileColumnContribution[];
  skipped: Partial<Record<WorkspaceSkipReason, number>>;
}

export interface WorkspaceIndexAggregate {
  relations: WorkspaceRelationSnapshot[];
  objects: WorkspaceObjectSnapshot[];
  /** Eligible column usage only; see {@link WORKSPACE_COLUMN_LIMIT}. */
  columns: WorkspaceColumnSnapshot[];
  /** Column records kept out because they were below the threshold. */
  columnsBelowThreshold: number;
  /** True when {@link WORKSPACE_COLUMN_LIMIT} dropped eligible columns. */
  columnsTruncated: boolean;
}

export interface WorkspaceIndexAggregateOptions {
  /** Injected clock for dirty/open files that have no disk mtime. */
  now?: string;
}

function recordTimestamp(
  file: WorkspaceFileIndexRecord,
  now: string,
): string {
  if (Number.isFinite(file.mtimeMs) && file.mtimeMs > 0) {
    const timestamp = new Date(file.mtimeMs).toISOString();
    if (!Number.isNaN(Date.parse(timestamp))) {
      return timestamp;
    }
  }
  return now;
}

function earlier(left: string, right: string): string {
  return left <= right ? left : right;
}

function later(left: string, right: string): string {
  return left >= right ? left : right;
}

interface RelationAccumulator {
  relation: RelationIdentity;
  contributions: Set<string>;
  files: Set<string>;
  queries: Set<string>;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface ColumnAccumulator {
  object: ObjectRef;
  column: string;
  files: Set<string>;
  queries: Set<string>;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface ObjectAccumulator {
  object: ObjectRef;
  contributions: Set<string>;
  files: Set<string>;
  queries: Set<string>;
  usage: ObjectUsageCounters;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Aggregate per-file records deterministically. Relation display is rebuilt
 * from the canonical orientation, and output arrays are sorted by key so a
 * full rebuild and an incremental update produce byte-identical labels.
 */
export function aggregateWorkspaceIndex(
  files: readonly WorkspaceFileIndexRecord[],
  options: WorkspaceIndexAggregateOptions = {},
): WorkspaceIndexAggregate {
  const now = options.now ?? new Date(0).toISOString();
  const relations = new Map<string, RelationAccumulator>();
  const objects = new Map<string, ObjectAccumulator>();
  const columns = new Map<string, ColumnAccumulator>();

  for (const file of files) {
    const timestamp = recordTimestamp(file, now);
    for (const contribution of file.relations) {
      const key = contribution.relation.key;
      const accumulator = relations.get(key) ?? {
        relation: contribution.relation,
        contributions: new Set<string>(),
        files: new Set<string>(),
        queries: new Set<string>(),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      accumulator.contributions.add(`${file.relPath}\u0000${contribution.fingerprint}`);
      accumulator.files.add(file.relPath);
      accumulator.queries.add(contribution.fingerprint);
      accumulator.firstSeenAt = earlier(accumulator.firstSeenAt, timestamp);
      accumulator.lastSeenAt = later(accumulator.lastSeenAt, timestamp);
      relations.set(key, accumulator);
    }
    for (const contribution of file.objects) {
      const key = `${contribution.object.database ?? ""}\u0000${contribution.object.schema ?? ""}\u0000${contribution.object.name}`;
      const accumulator = objects.get(key) ?? {
        object: contribution.object,
        contributions: new Set<string>(),
        files: new Set<string>(),
        queries: new Set<string>(),
        usage: { select: 0, insert: 0, update: 0, delete: 0 },
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      const contributionKey = `${file.relPath}\u0000${contribution.kind}\u0000${contribution.fingerprint}`;
      if (!accumulator.contributions.has(contributionKey)) {
        accumulator.contributions.add(contributionKey);
        accumulator.usage[contribution.kind] += 1;
      }
      accumulator.files.add(file.relPath);
      accumulator.queries.add(contribution.fingerprint);
      accumulator.firstSeenAt = earlier(accumulator.firstSeenAt, timestamp);
      accumulator.lastSeenAt = later(accumulator.lastSeenAt, timestamp);
      objects.set(key, accumulator);
    }
    for (const contribution of file.columns ?? []) {
      const key = columnUsageKey(objectRefKey(contribution.object), contribution.column);
      if (!key) {
        continue;
      }
      const accumulator = columns.get(key) ?? {
        object: contribution.object,
        column: contribution.column,
        files: new Set<string>(),
        queries: new Set<string>(),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      accumulator.files.add(file.relPath);
      accumulator.queries.add(contribution.fingerprint);
      accumulator.firstSeenAt = earlier(accumulator.firstSeenAt, timestamp);
      accumulator.lastSeenAt = later(accumulator.lastSeenAt, timestamp);
      columns.set(key, accumulator);
    }
  }

  const relationSnapshots: WorkspaceRelationSnapshot[] = [...relations.entries()]
    .map(([key, accumulator]) => ({
      key,
      relation: {
        ...accumulator.relation,
        display: canonicalRelationDisplay(accumulator.relation),
      },
      observations: accumulator.contributions.size,
      distinctFiles: accumulator.files.size,
      distinctQueries: accumulator.queries.size,
      belowThreshold: !isWorkspaceEvidenceEligible(
        accumulator.files.size,
        accumulator.queries.size,
      ),
      firstSeenAt: accumulator.firstSeenAt,
      lastSeenAt: accumulator.lastSeenAt,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  const objectSnapshots: WorkspaceObjectSnapshot[] = [...objects.entries()]
    .map(([key, accumulator]) => {
      const belowThreshold = !isWorkspaceEvidenceEligible(
        accumulator.files.size,
        accumulator.queries.size,
      );
      const band = belowThreshold
        ? undefined
        : objectBandForUsage(
            accumulator.usage,
            accumulator.files.size,
            accumulator.queries.size,
          );
      return {
        key,
        object: accumulator.object,
        usage: { ...accumulator.usage },
        distinctFiles: accumulator.files.size,
        distinctQueries: accumulator.queries.size,
        belowThreshold,
        ...(band !== undefined ? { band } : {}),
        firstSeenAt: accumulator.firstSeenAt,
        lastSeenAt: accumulator.lastSeenAt,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  let columnsBelowThreshold = 0;
  const eligibleColumns: WorkspaceColumnSnapshot[] = [];
  for (const [key, accumulator] of columns) {
    if (!isWorkspaceEvidenceEligible(accumulator.files.size, accumulator.queries.size)) {
      columnsBelowThreshold += 1;
      continue;
    }
    eligibleColumns.push({
      key,
      object: accumulator.object,
      column: accumulator.column,
      distinctFiles: accumulator.files.size,
      distinctQueries: accumulator.queries.size,
      firstSeenAt: accumulator.firstSeenAt,
      lastSeenAt: accumulator.lastSeenAt,
    });
  }
  const columnsTruncated = eligibleColumns.length > WORKSPACE_COLUMN_LIMIT;
  const columnSnapshots = (columnsTruncated
    ? [...eligibleColumns]
        .sort((left, right) =>
          right.distinctFiles - left.distinctFiles
          || right.distinctQueries - left.distinctQueries
          || left.key.localeCompare(right.key, "en"))
        .slice(0, WORKSPACE_COLUMN_LIMIT)
    : eligibleColumns)
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  return {
    relations: relationSnapshots,
    objects: objectSnapshots,
    columns: columnSnapshots,
    columnsBelowThreshold,
    columnsTruncated,
  };
}

export function createWorkspaceIndexSnapshot(
  aggregate: WorkspaceIndexAggregate,
  options: {
    generatedAt: string;
    truncated: boolean;
  },
): WorkspaceIndexSnapshot {
  return {
    version: 1,
    relations: aggregate.relations,
    objects: aggregate.objects,
    columns: aggregate.columns,
    truncated: options.truncated || aggregate.columnsTruncated,
    generatedAt: options.generatedAt,
  };
}

/** Aggregate counts and skip reasons for `netezza.showJoinKnowledgeStatus`. */
export interface WorkspaceIndexStats {
  relations: {
    total: number;
    eligible: number;
    belowThreshold: number;
  };
  objects: {
    total: number;
    eligible: number;
    belowThreshold: number;
  };
  columns: {
    eligible: number;
    belowThreshold: number;
    truncated: boolean;
  };
  skipped: Partial<Record<WorkspaceSkipReason, number>>;
}

export function summarizeWorkspaceIndex(
  files: readonly WorkspaceFileIndexRecord[],
  aggregate: WorkspaceIndexAggregate,
): WorkspaceIndexStats {
  const skipped: Partial<Record<WorkspaceSkipReason, number>> = {};
  for (const file of files) {
    for (const [reason, count] of Object.entries(file.skipped)) {
      if (!count) {
        continue;
      }
      const key = reason as WorkspaceSkipReason;
      skipped[key] = (skipped[key] ?? 0) + count;
    }
  }
  return {
    relations: {
      total: aggregate.relations.length,
      eligible: aggregate.relations.filter((entry) => !entry.belowThreshold).length,
      belowThreshold: aggregate.relations.filter((entry) => entry.belowThreshold).length,
    },
    objects: {
      total: aggregate.objects.length,
      eligible: aggregate.objects.filter((entry) => !entry.belowThreshold).length,
      belowThreshold: aggregate.objects.filter((entry) => entry.belowThreshold).length,
    },
    columns: {
      eligible: aggregate.columns.length,
      belowThreshold: aggregate.columnsBelowThreshold,
      truncated: aggregate.columnsTruncated,
    },
    skipped,
  };
}

function serializeRelation(entry: WorkspaceRelationSnapshot): string {
  return JSON.stringify(entry);
}

function serializeObject(entry: WorkspaceObjectSnapshot): string {
  return JSON.stringify(entry);
}

/** Diff two aggregates into affected-key upserts/removals for the language server. */
export function diffWorkspaceIndex(
  previous: WorkspaceIndexAggregate,
  next: WorkspaceIndexAggregate,
  options: {
    generatedAt: string;
    truncated: boolean;
  },
): JoinKnowledgeIndexDelta {
  const previousRelations = new Map(
    previous.relations.map((entry) => [entry.key, serializeRelation(entry)]),
  );
  const nextRelations = new Map(
    next.relations.map((entry) => [entry.key, serializeRelation(entry)]),
  );
  const previousObjects = new Map(
    previous.objects.map((entry) => [entry.key, serializeObject(entry)]),
  );
  const nextObjects = new Map(
    next.objects.map((entry) => [entry.key, serializeObject(entry)]),
  );
  const previousColumns = new Map(
    previous.columns.map((entry) => [entry.key, JSON.stringify(entry)]),
  );
  const nextColumnKeys = new Set(next.columns.map((entry) => entry.key));

  return {
    version: 1,
    relationsUpsert: next.relations.filter(
      (entry) => previousRelations.get(entry.key) !== serializeRelation(entry),
    ),
    relationsRemove: previous.relations
      .filter((entry) => !nextRelations.has(entry.key))
      .map((entry) => entry.key)
      .sort((left, right) => left.localeCompare(right, "en")),
    objectsUpsert: next.objects.filter(
      (entry) => previousObjects.get(entry.key) !== serializeObject(entry),
    ),
    objectsRemove: previous.objects
      .filter((entry) => !nextObjects.has(entry.key))
      .map((entry) => entry.key)
      .sort((left, right) => left.localeCompare(right, "en")),
    columnsUpsert: next.columns.filter(
      (entry) => previousColumns.get(entry.key) !== JSON.stringify(entry),
    ),
    columnsRemove: previous.columns
      .filter((entry) => !nextColumnKeys.has(entry.key))
      .map((entry) => entry.key)
      .sort((left, right) => left.localeCompare(right, "en")),
    truncated: options.truncated || next.columnsTruncated,
    generatedAt: options.generatedAt,
  };
}
