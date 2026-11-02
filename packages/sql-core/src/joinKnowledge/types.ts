/**
 * Persistent and in-memory JOIN Knowledge records.
 *
 * Only identifiers, counters and timestamps are stored. SQL text, literals,
 * hosts, connection names and salts are intentionally absent from every type
 * in this file.
 */

import type { RelationIdentity, ObjectRef } from "./identity";

export type JoinRelationDecisionKind = "confirm" | "block" | "favorite";

/** One append-only decision record for a canonical relation key. */
export interface JoinRelationOverride {
  id: string;
  relationKey: string;
  kind: JoinRelationDecisionKind;
  /** Full normalized relation, so SQL can be generated without stored text. */
  relation: RelationIdentity;
  /** Dialect used for normalization (informational, never a connection name). */
  databaseKind?: string;
  createdAt: string;
  revertedAt?: string;
  replacedBy?: string;
}

/** Append-only, bounded user adjustment to this relation's score within a rank tier. */
export interface JoinRelationScoreOverride {
  id: string;
  relationKey: string;
  relation: RelationIdentity;
  /**
   * Dialect used to canonicalize `relation`. Persisted so a reload verifies
   * the stored key with the same folding rules; without it a PostgreSQL-like
   * key would be re-normalized as Netezza and silently dropped.
   */
  databaseKind?: string;
  /** -5 (less often) through +5 (more often); 0 resets to neutral. */
  adjustment: number;
  createdAt: string;
  revertedAt?: string;
  replacedBy?: string;
}

export type ObjectPreferenceKind = "pin" | "boost" | "demote" | "exclude";

/** One append-only manual preference for a database/schema/name object key. */
export interface ObjectPreferenceOverride {
  id: string;
  objectKey: string;
  object: ObjectRef;
  kind: ObjectPreferenceKind;
  /** Boost band 00-09, only for `kind === "boost"`. */
  band?: number;
  /** Explicit order, only for `kind === "pin"`. */
  pinOrder?: number;
  databaseKind?: string;
  createdAt: string;
  revertedAt?: string;
  replacedBy?: string;
}

export type JoinEvidenceSource =
  | "confirmed"
  | "catalog-fk"
  | "accepted"
  | "executed"
  | "workspace";

/** One record per `(canonical relation key, source)`; sources merge at ranking time. */
export interface JoinRelationEvidenceRecord {
  relationKey: string;
  relation: RelationIdentity;
  /** Dialect used to canonicalize `relation`; required for a lossless reload. */
  databaseKind?: string;
  source: JoinEvidenceSource;
  observations: number;
  distinctDays: number;
  distinctFiles?: number;
  distinctQueries?: number;
  /**
   * Executed evidence only: bounded set of UTC days (`YYYY-MM-DD`) that actually
   * contributed. It keeps `distinctDays` correct when the clock moves backwards.
   */
  days?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  belowThreshold: boolean;
}

export interface ObjectUsageCounters {
  select: number;
  insert: number;
  update: number;
  delete: number;
}

/** One record per `(object key, source)` for future learning stages. */
export interface ObjectEvidenceRecord {
  objectKey: string;
  object: ObjectRef;
  /** `accepted`: explicit FROM completion selections (half-weight queries). */
  source: "workspace" | "executed" | "accepted";
  usage: ObjectUsageCounters;
  bestBand: number;
  distinctFiles?: number;
  distinctQueries?: number;
  /** Executed evidence only: successful executions that referenced the object. */
  observations?: number;
  /** Executed evidence only: distinct UTC days with a successful reference. */
  distinctDays?: number;
  /** Executed evidence only: bounded set of UTC days that actually contributed. */
  days?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  belowThreshold: boolean;
}

/**
 * Executed usage of one column of one table (`source: "executed"`). Column
 * evidence ranks only column completions; it never creates a JOIN relation or
 * changes FROM-object order.
 */
export interface ColumnEvidenceRecord {
  /** `objectKey` + NUL + normalized column name. */
  columnKey: string;
  objectKey: string;
  object: ObjectRef;
  column: string;
  databaseKind?: string;
  source: "executed";
  observations: number;
  distinctDays: number;
  /** Bounded set of UTC days that actually contributed. */
  days?: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  belowThreshold: boolean;
}

export interface JoinKnowledgeState {
  version: 1;
  relationOverrides: JoinRelationOverride[];
  relationScoreOverrides?: JoinRelationScoreOverride[];
  objectOverrides: ObjectPreferenceOverride[];
  relationEvidence: JoinRelationEvidenceRecord[];
  objectEvidence: ObjectEvidenceRecord[];
  /**
   * Bounded ledger of already-counted successful-execution events. It contains
   * opaque `executionId:statementIndex` keys only, so a duplicate delivery after
   * a restart is rejected without storing SQL or fingerprints.
   */
  executedEvents?: string[];
  /** Executed column usage; absent in files written before column ranking. */
  columnEvidence?: ColumnEvidenceRecord[];
  /** True when an executed-evidence retention limit was reached. */
  executedTruncated?: boolean;
  savedAt?: string;
}

export interface JoinKnowledgeRelationSnapshot {
  key: string;
  /**
   * `favorite` is a persistent "show this more often" preference. It is a
   * display preference, never semantic confirmation, and ranks in the
   * observed/preference band (`0_3_`) below catalog foreign keys.
   */
  decision: "confirmed" | "blocked" | "favorite";
  /** True when the user also marked the relation as a favorite. */
  favorite?: boolean;
  relation: RelationIdentity;
}

export interface ObjectPreferenceSnapshot {
  key: string;
  kind: ObjectPreferenceKind;
  object: ObjectRef;
  band?: number;
  pinOrder?: number;
}

/** Aggregated workspace evidence for one canonical relation. */
export interface WorkspaceRelationSnapshot {
  key: string;
  relation: RelationIdentity;
  observations: number;
  distinctFiles: number;
  distinctQueries: number;
  /** Accepted completion selections; each contributes half a query observation. */
  acceptedSelections?: number;
  /** File queries plus half-weighted accepted selections. */
  weightedQueries?: number;
  /**
   * True until `minDistinctFiles` or `minDistinctQueries` is reached. A
   * below-threshold record is stored but never ranked.
   */
  belowThreshold: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Aggregated workspace usage for one FROM object. */
export interface WorkspaceObjectSnapshot {
  key: string;
  object: ObjectRef;
  usage: ObjectUsageCounters;
  distinctFiles: number;
  distinctQueries: number;
  belowThreshold: boolean;
  /** Learned band 10-49, only when eligible. */
  band?: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Aggregated workspace usage of one column of one table. Only eligible
 * records (above the shared workspace threshold) are published.
 */
export interface WorkspaceColumnSnapshot {
  /** `objectKey` + NUL + normalized column name. */
  key: string;
  object: ObjectRef;
  column: string;
  distinctFiles: number;
  distinctQueries: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Identifier/counter-only workspace index payload for the language server. */
export interface WorkspaceIndexSnapshot {
  version: 1;
  relations: WorkspaceRelationSnapshot[];
  objects: WorkspaceObjectSnapshot[];
  /** Eligible column usage; absent in snapshots built before column ranking. */
  columns?: WorkspaceColumnSnapshot[];
  /** True when a file/byte cap or a failed parse removed possible evidence. */
  truncated: boolean;
  generatedAt: string;
}

/** Incremental update of the workspace index; no per-file paths or hashes. */
export interface JoinKnowledgeIndexDelta {
  version: 1;
  relationsUpsert: WorkspaceRelationSnapshot[];
  relationsRemove: string[];
  objectsUpsert: WorkspaceObjectSnapshot[];
  objectsRemove: string[];
  columnsUpsert?: WorkspaceColumnSnapshot[];
  columnsRemove?: string[];
  truncated?: boolean;
  generatedAt?: string;
}

/**
 * Serializable ranking input sent to the language server. Contains no SQL,
 * literals, hosts, connection names, history, salts or per-file fingerprints.
 */
export interface JoinKnowledgeSnapshot {
  version: 1;
  relations: JoinKnowledgeRelationSnapshot[];
  objectPreferences: ObjectPreferenceSnapshot[];
  relationScoreOverrides?: JoinRelationScoreOverride[];
  /** Workspace `.sql` evidence, identifiers and counters only. */
  workspace?: WorkspaceIndexSnapshot;
  /**
   * Successful-execution evidence (`0_4_`). Records are identifier/counter only
   * and carry the dialect they were canonicalized with; the ranking layer
   * ignores records whose dialect differs from the completion request.
   */
  /**
   * Accepted FROM completion selections. Preference evidence only: each
   * selection weighs half a query, ranks inside the learned band range, and
   * never creates a JOIN relation.
   */
  acceptedObjects?: ObjectEvidenceRecord[];
  executed?: JoinKnowledgeExecutedSnapshot;
}

export interface JoinKnowledgeExecutedSnapshot {
  relations: JoinRelationEvidenceRecord[];
  objects: ObjectEvidenceRecord[];
  /** Executed column usage (identifiers and counters only). */
  columns?: ColumnEvidenceRecord[];
}

export interface JoinKnowledgeDiagnostics {
  relationOverrides: {
    active: number;
    reverted: number;
    confirmed: number;
    blocked: number;
    favorites: number;
  };
  objectOverrides: {
    active: number;
    reverted: number;
    pinned: number;
    boosted: number;
    demoted: number;
    excluded: number;
  };
  relationEvidence: number;
  objectEvidence: number;
  executed: {
    relationsEligible: number;
    relationsBelowThreshold: number;
    objectsEligible: number;
    objectsBelowThreshold: number;
    columnsEligible: number;
    columnsBelowThreshold: number;
    /** True when a retention limit stopped executed-evidence growth. */
    truncated: boolean;
  };
}
