import type { DatabaseKind } from "../contracts/database";
import type { QualificationProposal } from "../core/tableQualificationResolver";
import type {
  JoinKnowledgeIndexDelta,
  JoinKnowledgeSnapshot,
} from "@justybase/sql-core/joinKnowledge";

export const NETEZZA_GET_METADATA_REQUEST = "netezza/getMetadata";
export const NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION =
  "netezza/documentContextChanged";
export const NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION =
  "netezza/metadataCacheInvalidated";
export const NETEZZA_JOIN_KNOWLEDGE_CHANGED_NOTIFICATION =
  "netezza/joinKnowledgeChanged";
export const NETEZZA_JOIN_KNOWLEDGE_SUGGESTIONS_REQUEST =
  "netezza/getJoinKnowledgeSuggestions";
export const NETEZZA_UX_PERF_NOTIFICATION = "netezza/uxPerf";
/** Confident JOIN target or ON condition offered as inline ghost text. */
export const NETEZZA_JOIN_GHOST_SUGGESTION_REQUEST = "netezza/joinGhostSuggestion";
/** Catalog column a host can reveal for the SQL column at a position. */
export const NETEZZA_COLUMN_CATALOG_TARGET_REQUEST = "netezza/columnCatalogTarget";

export type ColumnCatalogTargetParams = {
  textDocument: { uri: string };
  position: { line: number; character: number };
};

/** Mirrors the sql-core catalog target; null when the column has none. */
export type ColumnCatalogTargetResponse = {
  database: string | null;
  schema: string | null;
  relation: string;
  column: string;
  via: "catalog" | "origin";
} | null;

export type UxPerfNotificationParams = {
  op: string;
  phase: string;
  traceId?: string;
  durationMs?: number;
  doc?: {
    uri?: string;
    chars?: number;
    lines?: number;
    ver?: number;
  };
  meta?: Record<string, string | number | boolean | null>;
};

export type MetadataRequestKind =
  | "context"
  | "databases"
  | "schemas"
  | "tables"
  | "views"
  | "sourceObjects"
  | "procedures"
  | "columns"
  | "cachedTableInfo"
  | "cachedJoinTargets"
  | "tableInfo"
  | "warmDatabaseColumns"
  | "qualifyTable"
  | "netezzaDefaultSchema";

export interface MetadataRequestParams {
  documentUri: string;
  kind: MetadataRequestKind;
  database?: string;
  schema?: string;
  table?: string;
  /** Existing FROM/JOIN sources to match against cached PK/FK metadata. */
  joinSources?: Array<{ schema?: string; table: string }>;
  allowPublicSynonym?: boolean;
  /** Completion list lookups may explicitly forbid a live catalog fallback. */
  cacheOnly?: boolean;
  /** Batch-warm column metadata for these databases (one query per DB). */
  databases?: string[];
}

export interface MetadataContextResponse {
  serverVersionNum?: number;
  searchPath?: readonly string[];
  connectionName?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
  databaseKind?: DatabaseKind;
  netezzaSchemasEnabled?: boolean;
  joinCompletionSettings?: JoinCompletionSettings;
  /** `justybase.sql.completionKeywordCase`: case of inserted keywords. */
  completionKeywordCase?: CompletionKeywordCase;
}

export type CompletionKeywordCase = "upper" | "lower" | "matchTyped";

export interface JoinTableIdentity {
  database?: string;
  schema?: string;
  table: string;
}

export interface JoinRelationSetting {
  left: JoinTableIdentity;
  right: JoinTableIdentity;
  columns: Array<{ left: string; right: string }>;
}

export interface JoinCompletionSettings {
  nameHeuristicsEnabled: boolean;
  autoAliases: boolean;
  aliases: readonly { table: JoinTableIdentity; alias: string }[];
  relations: readonly JoinRelationSetting[];
}

export interface DocumentContextChangedParams {
  documentUri: string;
}

/** Optional connection scope keeps legacy parameter-less invalidation valid. */
export interface MetadataCacheInvalidatedParams {
  connectionName?: string;
}

/** Knowledge snapshot for completion ranking; never contains SQL text. */
export interface JoinKnowledgeChangedParams {
  /** Full snapshot on manual changes, rebuild or index start/stop. */
  snapshot?: JoinKnowledgeSnapshot;
  /** Affected-key workspace update; merged without replacing manual decisions. */
  workspaceDelta?: JoinKnowledgeIndexDelta;
  /** FROM-object personalization master switch. */
  personalizeFromObjects: boolean;
  /** Heuristic JOIN buckets master switch (`justybase.sql.joinNameHeuristics`). */
  joinNameHeuristics: boolean;
  /** Learned column ordering switch (`justybase.sql.personalizeColumns`). */
  personalizeColumns?: boolean;
}

export interface JoinKnowledgeSuggestionRelation {
  left: { database?: string; schema?: string; table: string };
  right: { database?: string; schema?: string; table: string };
  columns: Array<{ left: string; right: string }>;
  databaseKind?: string;
  effectiveDatabase?: string;
  effectiveSchema?: string;
}

export interface JoinKnowledgeSuggestionItem {
  label: string;
  detail?: string;
  relation: JoinKnowledgeSuggestionRelation;
  favorite: boolean;
}

export interface JoinKnowledgeSuggestionsParams {
  documentUri: string;
  position: { line: number; character: number };
}

export interface JoinKnowledgeSuggestionsResponse {
  items: JoinKnowledgeSuggestionItem[];
}

/** `justybase.sql.joinGhostText`. */
export type JoinGhostMode = "off" | "afterJoin" | "afterJoinAndNewLine";

export interface JoinGhostSuggestionParams {
  documentUri: string;
  position: { line: number; character: number };
  mode: JoinGhostMode;
  /** `justybase.sql.groupByGhostText`: also offer the list after `GROUP BY `. */
  groupBy?: boolean;
}

export interface JoinGhostSuggestion {
  /**
   * `target` completes the joined table, `predicate` the ON condition,
   * `groupBy` the non-aggregated SELECT expressions after `GROUP BY `.
   */
  kind: "target" | "predicate" | "groupBy";
  /** Text inserted at the cursor (may start with `JOIN ` or `ON `). */
  insertText: string;
  /** The JOIN relation; absent for `groupBy`. */
  relation?: JoinKnowledgeSuggestionRelation;
}

export interface MetadataObjectItem {
  name: string;
  database?: string;
  schema?: string;
  objectType?:
    | "table"
    | "view"
    | "materialized-view"
    | "synonym"
    | "procedure";
  detail?: string;
  description?: string;
  /** Parsed from procedure signature when objectType is procedure. */
  argumentNames?: string[];
  /** Cached PK/FK name matches used to build a complete JOIN suggestion. */
  joinUsesDefaultSchema?: boolean;
  joinMatches?: Array<{
    sourceTable: string;
    sourceSchema?: string;
    sourceColumn: string;
    targetColumn: string;
    relationType?: "foreignKey" | "heuristic";
    constraintName?: string;
    ordinalPosition?: number;
    /**
     * Target side of the relation: `parent` is referenced by the source (the
     * "one" side, keeps the grain), `child` references the source (fans out).
     */
    targetRole?: "parent" | "child" | "peer";
    /** Matches with the same group form one composite condition. */
    group?: string;
  }>;
}

export interface MetadataColumnItem {
  name: string;
  type?: string;
  description?: string;
  isPk?: boolean;
  isFk?: boolean;
  joinReferences?: import("../contracts/database").DatabaseForeignKeyColumnReference[];
}

export interface MetadataTableInfoResponse {
  exists: boolean;
  table: string;
  database?: string;
  schema?: string;
  description?: string;
  columns: MetadataColumnItem[];
  /** True when an empty columns array is a completed negative cache layer. */
  columnsComplete?: boolean;
}

export type MetadataResponse =
  | MetadataContextResponse
  | MetadataObjectItem[]
  | MetadataColumnItem[]
  | MetadataTableInfoResponse
  | QualificationProposal[]
  | string
  | null;
