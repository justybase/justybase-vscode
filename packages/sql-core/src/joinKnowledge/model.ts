import type { ObjectUsageCounters } from "./types";

/**
 * Normative JOIN Knowledge ranking model.
 *
 * This module is the single executable source for tiers, bands, thresholds and
 * sort-key grammar. It must stay free of I/O and platform imports so the host
 * extension, the language server and future webviews share one definition.
 *
 * See `docs/join-knowledge/01-ranking-model.md`.
 */

/** JOIN target tiers. Lexicographic sort keys, lowest tier wins. */
export const JOIN_TARGET_TIERS = Object.freeze({
  manual: "0_0_",
  confirmed: "0_1_",
  catalogFk: "0_2_",
  /** Persistent "show more often" preference; never semantic confirmation. */
  favorite: "0_3_",
  executed: "0_4_",
  workspace: "0_5_",
  heuristic: "2_",
} as const);

export type JoinTargetSource = keyof typeof JOIN_TARGET_TIERS;

/**
 * Bucket after every tier for a JOIN target whose exact relation (same table
 * pair and column pairs) is already written in the statement. Joining the
 * same relation twice is almost never intended; role-playing joins through
 * other columns keep their tier.
 */
export const JOIN_TARGET_REDUNDANT_TIER = "3_";

/** ON predicate tiers mirror the target order plus two heuristic buckets. */
export const JOIN_PREDICATE_TIERS = Object.freeze({
  manual: "0_0_",
  confirmed: "0_1_",
  catalogFk: "0_2_",
  /** Persistent "show more often" preference; never semantic confirmation. */
  favorite: "0_3_",
  executed: "0_4_",
  workspace: "0_5_",
  cachedKey: "0_6_",
  nameMatch: "0_7_",
} as const);

export type JoinPredicateSource = keyof typeof JOIN_PREDICATE_TIERS;

export interface JoinTierSources {
  /** `justybase.sql.joinRelations` — authoritative and never overridden. */
  manual?: boolean;
  /** Explicit per-relation confirmation; the only promotion above FK. */
  confirmed?: boolean;
  /** Catalog foreign key. */
  catalogFk?: boolean;
  /**
   * Persistent user preference to show this relation more often. It is not
   * confirmation and never outranks a catalog FK.
   */
  favorite?: boolean;
  /** Executed successfully often enough to leave the single-observation state. */
  executed?: boolean;
  /** Workspace `.sql` evidence above the breadth threshold. */
  workspace?: boolean;
  /** Predicate-only: cached key metadata match. */
  cachedKey?: boolean;
  /** Predicate-only: name match heuristic. */
  nameMatch?: boolean;
  /** Block is applied before tiering; blocked relations never rank. */
  blocked?: boolean;
}

export type JoinTierResolution =
  | {
      ranked: true;
      tier: string;
      source: JoinTargetSource | JoinPredicateSource;
      /** Lower-priority sources that lost to this one for the same relation. */
      suppressed: Array<JoinTargetSource | JoinPredicateSource>;
      /** Winner that caused `suppressed` to be non-empty (diagnostics only). */
      suppressedBy?: JoinTargetSource | JoinPredicateSource;
    }
  | {
      ranked: false;
      reason: "blocked" | "none";
      suppressed: Array<JoinTargetSource | JoinPredicateSource>;
    };

interface OrderedSource {
  source: JoinTierSourceName;
  enabled: boolean;
  tier: string;
}

type JoinTierSourceName = JoinTargetSource | JoinPredicateSource;

function resolveOrderedTier(
  ordered: ReadonlyArray<OrderedSource>,
  fallback?: OrderedSource,
): JoinTierResolution {
  const winnerIndex = ordered.findIndex((candidate) => candidate.enabled);
  if (winnerIndex < 0) {
    if (fallback) {
      return {
        ranked: true,
        tier: fallback.tier,
        source: fallback.source,
        suppressed: [],
      };
    }
    return { ranked: false, reason: "none", suppressed: [] };
  }
  const winner = ordered[winnerIndex];
  const suppressed = ordered
    .slice(winnerIndex + 1)
    .filter((candidate) => candidate.enabled)
    .map((candidate) => candidate.source);
  return {
    ranked: true,
    tier: winner.tier,
    source: winner.source,
    suppressed,
    ...(suppressed.length > 0 ? { suppressedBy: winner.source } : {}),
  };
}

/**
 * Resolve the winning JOIN target tier. Precedence is normative:
 * manual > confirmed > catalog FK > executed > workspace > heuristic.
 */
export function resolveJoinTargetTier(
  sources: JoinTierSources,
): JoinTierResolution {
  if (sources.blocked) {
    return { ranked: false, reason: "blocked", suppressed: [] };
  }
  return resolveOrderedTier([
    { source: "manual", enabled: sources.manual === true, tier: JOIN_TARGET_TIERS.manual },
    { source: "confirmed", enabled: sources.confirmed === true, tier: JOIN_TARGET_TIERS.confirmed },
    { source: "catalogFk", enabled: sources.catalogFk === true, tier: JOIN_TARGET_TIERS.catalogFk },
    { source: "favorite", enabled: sources.favorite === true, tier: JOIN_TARGET_TIERS.favorite },
    { source: "executed", enabled: sources.executed === true, tier: JOIN_TARGET_TIERS.executed },
    { source: "workspace", enabled: sources.workspace === true, tier: JOIN_TARGET_TIERS.workspace },
  ], { source: "heuristic", enabled: true, tier: JOIN_TARGET_TIERS.heuristic });
}

/**
 * Resolve the winning ON predicate tier. Observed evidence (`executed`,
 * `workspace`) can never outrank a catalog FK; confirmation is the
 * only path above it.
 */
export function resolveJoinPredicateTier(
  sources: JoinTierSources,
): JoinTierResolution {
  if (sources.blocked) {
    return { ranked: false, reason: "blocked", suppressed: [] };
  }
  return resolveOrderedTier([
    { source: "manual", enabled: sources.manual === true, tier: JOIN_PREDICATE_TIERS.manual },
    { source: "confirmed", enabled: sources.confirmed === true, tier: JOIN_PREDICATE_TIERS.confirmed },
    { source: "catalogFk", enabled: sources.catalogFk === true, tier: JOIN_PREDICATE_TIERS.catalogFk },
    { source: "favorite", enabled: sources.favorite === true, tier: JOIN_PREDICATE_TIERS.favorite },
    { source: "executed", enabled: sources.executed === true, tier: JOIN_PREDICATE_TIERS.executed },
    { source: "workspace", enabled: sources.workspace === true, tier: JOIN_PREDICATE_TIERS.workspace },
    { source: "cachedKey", enabled: sources.cachedKey === true, tier: JOIN_PREDICATE_TIERS.cachedKey },
  ], { source: "nameMatch", enabled: true, tier: JOIN_PREDICATE_TIERS.nameMatch });
}

/** Bounded 2-digit band-internal score. Never promotes across tiers. */
export const JOIN_SCORE_RANGE = Object.freeze({ min: 0, max: 99 });

export function clampJoinScore(score: number | undefined): number | undefined {
  if (score === undefined || !Number.isFinite(score)) {
    return undefined;
  }
  return Math.max(JOIN_SCORE_RANGE.min, Math.min(JOIN_SCORE_RANGE.max, Math.round(score)));
}

/**
 * Build a JOIN sort key: `TIER[_SCORE]_LABEL`. The optional score only breaks
 * ties inside one tier.
 */
export function buildJoinSortText(
  tier: string,
  label: string,
  score?: number,
): string {
  const clamped = clampJoinScore(score);
  const scorePart = clamped === undefined ? "" : `${String(clamped).padStart(2, "0")}_`;
  return `${tier}${scorePart}${label.toLocaleUpperCase()}`;
}

/**
 * Tie-break inside a tier. Favorites sort first in their preference tier;
 * accepted selections are merged into workspace evidence and have no tier.
 *
 * @deprecated Within-tier order now comes from {@link scoreJoinCandidate};
 * kept for callers that only need the legacy favorite marker.
 */
export function getJoinTierScore(
  source: JoinTargetSource | JoinPredicateSource,
): number | undefined {
  if (source === "favorite") {
    return 0;
  }
  return undefined;
}

/**
 * Within-tier JOIN score model (`01-ranking-model.md` §1). Factor weights sum
 * to 1; the resulting strength maps onto `scoreBase..scoreBase+scoreSpan`, so a
 * user adjustment (±5 × `adjustmentStep`) can still move a relation to either
 * end of its tier. The score never changes the tier prefix.
 */
export const JOIN_SCORE_MODEL = Object.freeze({
  factors: Object.freeze({
    columnPairExactness: 0.3,
    tableSchemaAgreement: 0.15,
    breadth: 0.2,
    contextSimilarity: 0.15,
    freshness: 0.1,
    grain: 0.1,
  }),
  scoreBase: 25,
  scoreSpan: 50,
  adjustmentStep: 10,
  /** Freshness halves every 90 days since the last observation. */
  freshnessHalfLifeDays: 90,
  /** Ranking breadth saturates at 16 files/days and 32 queries/executions. */
  breadthPrimarySaturation: 16,
  breadthSecondarySaturation: 32,
  /** Extra points (worse) for a target whose table is already in the query. */
  alreadyJoinedPenalty: 20,
});

export type JoinTargetRole = "parent" | "peer" | "child";

/** Grain factor in `[0, 1]`: parent 1, peer/unknown 0.5, child 0. */
export function joinTargetGrain(role: JoinTargetRole | undefined): number {
  return role === "parent" ? 1 : role === "child" ? 0 : 0.5;
}

/** Static evidence strength of one relation, computed at snapshot build. */
export interface JoinEvidenceStrength {
  /** Breadth in `[0, 1]` (log-scaled files/days and queries/executions). */
  breadth: number;
  /** Freshness in `[0, 1]`, `1` = observed at `now`. */
  freshness: number;
}

export interface JoinCandidateScoreInput {
  evidence?: JoinEvidenceStrength;
  /** `[0, 1]`, see {@link joinColumnPairExactness}. */
  columnPairExactness: number;
  /** `[0, 1]`, see {@link joinTableSchemaAgreement}. */
  tableSchemaAgreement: number;
  /** `[0, 1]`: proximity of the source table to the cursor. */
  contextSimilarity: number;
  /**
   * Target side of the relation. `parent` (referenced by the source) keeps
   * the query grain, `child` fans rows out; unknown counts as `peer`.
   */
  targetRole?: JoinTargetRole;
  /** Target table already present in the statement (not a self-join). */
  alreadyJoined?: boolean;
  /** Per-relation user adjustment, `-5..+5`. */
  userAdjustment?: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Ranking breadth in `[0, 1]`. Logarithmic so that 8 files still beat 4 files;
 * the eligibility thresholds are unaffected (they use raw counters).
 */
export function joinEvidenceBreadth(primary: number, secondary: number): number {
  const scaled = (count: number, saturation: number): number =>
    count <= 0 ? 0 : Math.log1p(count) / Math.log1p(saturation);
  return clampUnit(
    0.6 * clampUnit(scaled(primary, JOIN_SCORE_MODEL.breadthPrimarySaturation))
      + 0.4 * clampUnit(scaled(secondary, JOIN_SCORE_MODEL.breadthSecondarySaturation)),
  );
}

/** Exponential freshness decay from `lastSeenAt` to the injected `now`. */
export function joinEvidenceFreshness(
  lastSeenAt: string | undefined,
  now: string | undefined,
): number {
  const last = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const current = now ? Date.parse(now) : Number.NaN;
  if (!Number.isFinite(last) || !Number.isFinite(current)) {
    return 0;
  }
  const ageDays = Math.max(0, (current - last) / 86_400_000);
  return clampUnit(0.5 ** (ageDays / JOIN_SCORE_MODEL.freshnessHalfLifeDays));
}

function bareColumnName(name: string): string {
  return name.replace(/^"|"$/g, "").toUpperCase();
}

function singularTableStem(table: string): string {
  const upper = bareColumnName(table);
  if (upper.endsWith("IES")) {
    return `${upper.slice(0, -3)}Y`;
  }
  if (upper.endsWith("SES") || upper.endsWith("XES")) {
    return upper.slice(0, -2);
  }
  return upper.endsWith("S") ? upper.slice(0, -1) : upper;
}

/**
 * Column-pair exactness in `[0, 1]`, averaged over pairs: identical names `1`,
 * a key-style pair (`CUSTOMER_ID = ID` on `CUSTOMERS`) `0.85`, containment
 * `0.6`, anything else `0.35`.
 */
export function joinColumnPairExactness(
  pairs: ReadonlyArray<{ left: string; right: string }>,
  leftTable: string,
  rightTable: string,
): number {
  if (pairs.length === 0) {
    return 0;
  }
  const isKeyStyle = (column: string, otherColumn: string, otherTable: string): boolean => {
    if (otherColumn !== "ID") {
      return false;
    }
    const stem = singularTableStem(otherTable);
    return column === `${stem}_ID` || column === `${stem}ID` || column === `${stem}_KEY`;
  };
  let total = 0;
  for (const pair of pairs) {
    const left = bareColumnName(pair.left);
    const right = bareColumnName(pair.right);
    if (left === right) {
      total += 1;
    } else if (isKeyStyle(left, right, rightTable) || isKeyStyle(right, left, leftTable)) {
      total += 0.85;
    } else if (left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left))) {
      total += 0.6;
    } else {
      total += 0.35;
    }
  }
  return total / pairs.length;
}

/**
 * Database/schema agreement between source and target in `[0, 1]`: same
 * database and schema `1`, same database `0.5`, otherwise `0`. Missing parts
 * fall back to the effective scope.
 */
export function joinTableSchemaAgreement(
  source: { database?: string; schema?: string },
  target: { database?: string; schema?: string },
  defaults: { database?: string; schema?: string } = {},
): number {
  const norm = (value: string | undefined, fallback: string | undefined): string =>
    (value || fallback || "").replace(/^"|"$/g, "").toUpperCase();
  const sameDatabase = norm(source.database, defaults.database) === norm(target.database, defaults.database);
  if (!sameDatabase) {
    return 0;
  }
  return norm(source.schema, defaults.schema) === norm(target.schema, defaults.schema) ? 1 : 0.5;
}

/**
 * Bounded 2-digit within-tier score (lower sorts first). The tier prefix is
 * emitted separately, so this value can never promote across tiers.
 */
export function scoreJoinCandidate(input: JoinCandidateScoreInput): number {
  const factors = JOIN_SCORE_MODEL.factors;
  const context = input.alreadyJoined ? 0 : clampUnit(input.contextSimilarity);
  const strength = factors.columnPairExactness * clampUnit(input.columnPairExactness)
    + factors.tableSchemaAgreement * clampUnit(input.tableSchemaAgreement)
    + factors.breadth * clampUnit(input.evidence?.breadth ?? 0)
    + factors.contextSimilarity * context
    + factors.freshness * clampUnit(input.evidence?.freshness ?? 0)
    + factors.grain * joinTargetGrain(input.targetRole);
  const adjustment = Math.max(-5, Math.min(5, Math.round(input.userAdjustment ?? 0)));
  const score = JOIN_SCORE_MODEL.scoreBase
    + Math.round(JOIN_SCORE_MODEL.scoreSpan * (1 - clampUnit(strength)))
    + (input.alreadyJoined ? JOIN_SCORE_MODEL.alreadyJoinedPenalty : 0)
    - adjustment * JOIN_SCORE_MODEL.adjustmentStep;
  return clampJoinScore(score) ?? JOIN_SCORE_RANGE.max;
}

/** Thresholds shared by JOIN and object evidence sources. */
/** Tier and within-tier score of a JOIN `sortText` (`0_4_31_LABEL` → `0_4_`, 31). */
export interface JoinSortKey {
  tier: string;
  score: number | undefined;
}

export function parseJoinSortKey(sortText: string | undefined): JoinSortKey | undefined {
  const match = /^(0_\d_|\d_)(?:(\d\d)_)?/u.exec(sortText ?? "");
  if (!match) {
    return undefined;
  }
  return { tier: match[1], score: match[2] === undefined ? undefined : Number(match[2]) };
}

/** What a ghost suggestion completes: the JOIN target or the ON condition. */
export type JoinGhostKind = "target" | "predicate";

/**
 * Tiers whose top suggestion may become inline ghost text. Calibrated with the
 * ghost replay (`docs/join-knowledge/10-ghost-text-and-history.md`): the next
 * JOIN target is ambiguous in star schemas (best score-based gate ≤ 0.70
 * precision; executed `0_4_` targets 0/3 star, newline 0/8), so only explicit
 * user decisions qualify; ON conditions for a written target are near-certain
 * up to cached key matches.
 */
export const JOIN_GHOST_MODEL = Object.freeze({
  target: Object.freeze(["0_0_", "0_1_", "0_3_"]) as readonly string[],
  predicate: Object.freeze(["0_0_", "0_1_", "0_2_", "0_3_", "0_4_", "0_5_", "0_6_"]) as readonly string[],
});

/**
 * The top suggestion is confident when its tier qualifies for the kind and no
 * other suggestion shares that tier: a runner-up in the same tier means the
 * choice is ambiguous, whatever the scores say.
 */
export function isConfidentJoinSuggestion(
  kind: JoinGhostKind,
  top: string | undefined,
  runnerUp: string | undefined,
  model: typeof JOIN_GHOST_MODEL = JOIN_GHOST_MODEL,
): boolean {
  const first = parseJoinSortKey(top);
  if (!first || !model[kind].includes(first.tier)) {
    return false;
  }
  return parseJoinSortKey(runnerUp)?.tier !== first.tier;
}

export const JOIN_KNOWLEDGE_THRESHOLDS = Object.freeze({
  minExecutions: 2,
  minDistinctDays: 2,
  minDistinctFiles: 2,
  minDistinctQueries: 3,
});

/**
 * Explicit retention limits for executed evidence. Reaching a limit stops
 * growth (under-count) and sets a visible `truncated` flag; it never evicts
 * older evidence silently.
 */
export interface ExecutedEvidenceLimits {
  /** Stored relation records. */
  maxRelationRecords: number;
  /** Stored object records. */
  maxObjectRecords: number;
  /** Distinct UTC days kept per relation/object record. */
  maxDaysPerRecord: number;
  /** Persisted execution-event keys used for duplicate-delivery rejection. */
  maxRecentExecutionKeys: number;
  /** Stored executed column-usage records. */
  maxColumnRecords: number;
}

export const EXECUTED_EVIDENCE_LIMITS: ExecutedEvidenceLimits = Object.freeze({
  maxRelationRecords: 2_000,
  maxObjectRecords: 2_000,
  maxDaysPerRecord: 64,
  maxRecentExecutionKeys: 1_024,
  maxColumnRecords: 8_000,
});

/**
 * Workspace column-usage publication cap. Only eligible columns are published;
 * past the cap the broadest ones are kept and the snapshot is marked truncated.
 */
export const WORKSPACE_COLUMN_LIMIT = 20_000;

/** True when executed evidence is broad enough to leave `belowThreshold`. */
export function isExecutedEvidenceEligible(
  executions: number,
  distinctDays: number,
): boolean {
  return (
    executions >= JOIN_KNOWLEDGE_THRESHOLDS.minExecutions
    || distinctDays >= JOIN_KNOWLEDGE_THRESHOLDS.minDistinctDays
  );
}

/** True when workspace evidence is broad enough to leave `belowThreshold`. */
export function isWorkspaceEvidenceEligible(
  distinctFiles: number,
  distinctQueries: number,
  weightedQueries = distinctQueries,
): boolean {
  return (
    distinctFiles >= JOIN_KNOWLEDGE_THRESHOLDS.minDistinctFiles
    || weightedQueries >= JOIN_KNOWLEDGE_THRESHOLDS.minDistinctQueries
  );
}

/**
 * Object (FROM) ranking bands. Bands are emitted after match rank, scope and
 * kind; only pin (`2_`) may cross those boundaries.
 */
export const OBJECT_BANDS = Object.freeze({
  boostMin: 0,
  boostMax: 9,
  learnedMin: 10,
  learnedMax: 49,
  neutral: 50,
  demote: 90,
});

export type ObjectUsageKind = "select" | "insert" | "update" | "delete";

export const OBJECT_RANKING_MODEL = Object.freeze({
  usageWeights: Object.freeze<Record<ObjectUsageKind, number>>({
    select: 1,
    insert: 0.5,
    update: 0.25,
    delete: 0.25,
  }),
  /** Best band reachable by a source for one usage kind. */
  bestBandCaps: Object.freeze<Record<ObjectUsageKind, number>>({
    select: OBJECT_BANDS.learnedMin,
    insert: 25,
    update: 35,
    delete: 35,
  }),
  /** Within-tier JOIN factors; single source in {@link JOIN_SCORE_MODEL}. */
  tieBreakFactors: JOIN_SCORE_MODEL.factors,
  thresholds: JOIN_KNOWLEDGE_THRESHOLDS,
});

/**
 * Learned FROM-object band from workspace usage.
 *
 * A kind-specific cap keeps INSERT/UPDATE/DELETE-only evidence from reaching
 * the SELECT band. Within the cap, broader evidence (more distinct files and
 * queries) moves the band toward the best value. Returns `undefined` until the
 * shared workspace breadth threshold is met, so single observations are never
 * ranked.
 */
export function objectBandForUsage(
  usage: Partial<ObjectUsageCounters>,
  distinctFiles: number,
  distinctQueries: number,
): number | undefined {
  if (!isWorkspaceEvidenceEligible(distinctFiles, distinctQueries)) {
    return undefined;
  }
  return bandForUsageBreadth(
    usage,
    breadthStrengthOf(distinctFiles, distinctQueries),
  );
}

/**
 * Learned FROM-object band from explicit completion selections. Each selection
 * weighs half a query (as for JOIN acceptance), so six selections reach the
 * shared three-query threshold; there is no file breadth.
 */
export function acceptedObjectBand(selections: number): number | undefined {
  return objectBandForUsage({ select: selections }, 0, selections * 0.5);
}

/**
 * Learned FROM-object band from successful executions. Uses the executed
 * thresholds (2 executions or 2 distinct days), never the file thresholds, and
 * the same per-kind caps as workspace evidence. Object usage from executions is
 * merged with workspace usage by taking the better band, never by summing.
 */
export function executedObjectBandForUsage(
  usage: Partial<ObjectUsageCounters>,
  executions: number,
  distinctDays: number,
): number | undefined {
  if (!isExecutedEvidenceEligible(executions, distinctDays)) {
    return undefined;
  }
  return bandForUsageBreadth(
    usage,
    breadthStrengthOf(distinctDays, executions),
  );
}

/**
 * Breadth in `[0, 1]` on the shared log scale ({@link joinEvidenceBreadth}).
 * A linear scale saturated at 4 files or 7 queries, so every object used
 * regularly tied at the best band and fell back to alphabetical order.
 */
function breadthStrengthOf(primary: number, secondary: number): number {
  return joinEvidenceBreadth(primary, secondary);
}

function bandForUsageBreadth(
  usage: Partial<ObjectUsageCounters>,
  breadthStrength: number,
): number | undefined {
  let best: number | undefined;
  for (const kind of Object.keys(OBJECT_RANKING_MODEL.usageWeights) as ObjectUsageKind[]) {
    const count = usage[kind] ?? 0;
    if (count <= 0) {
      continue;
    }
    // The cap already encodes the usage weight (select 10, insert 25,
    // update/delete 35); breadth moves the band toward that cap.
    const cap = OBJECT_RANKING_MODEL.bestBandCaps[kind];
    const band = cap
      + Math.round((OBJECT_BANDS.learnedMax - cap) * (1 - breadthStrength));
    const bounded = Math.max(
      cap,
      Math.min(OBJECT_BANDS.learnedMax, band),
    );
    best = best === undefined ? bounded : Math.min(best, bounded);
  }
  return best;
}

/**
 * Learned column band (`10`–`49`, lower sorts first) from usage breadth. It is
 * only emitted inside the column list of one table and never crosses the
 * existing completion group prefixes.
 */
function columnBandForBreadth(primary: number, secondary: number): number {
  const strength = joinEvidenceBreadth(primary, secondary);
  return OBJECT_BANDS.learnedMin
    + Math.round((OBJECT_BANDS.learnedMax - OBJECT_BANDS.learnedMin) * (1 - strength));
}

/**
 * Catalog prior for columns after `alias.`, applied inside the usage band:
 * join keys first in `ON`, last where values are selected or grouped; in a
 * `SUM(`/`AVG(` argument (`aggregate`) non-key numeric columns first. WHERE
 * keeps catalog order (keys first measured worse there). Calibration:
 * `docs/join-knowledge/11-column-object-ranking.md`.
 */
export type ColumnClausePrior = "first" | "last" | "measure";

export const COLUMN_CLAUSE_PRIOR: Readonly<Record<string, ColumnClausePrior>> = Object.freeze({
  on: "first",
  select: "last",
  group: "last",
  order: "last",
  having: "last",
  aggregate: "measure",
});

export function columnClausePrior(clause: string | undefined): ColumnClausePrior | undefined {
  return clause ? COLUMN_CLAUSE_PRIOR[clause] : undefined;
}

/** Workspace column band; `undefined` below the shared workspace threshold. */
export function workspaceColumnBand(distinctFiles: number, distinctQueries: number): number | undefined {
  return isWorkspaceEvidenceEligible(distinctFiles, distinctQueries)
    ? columnBandForBreadth(distinctFiles, distinctQueries)
    : undefined;
}

/** Executed column band; `undefined` below the executed threshold. */
export function executedColumnBand(executions: number, distinctDays: number): number | undefined {
  return isExecutedEvidenceEligible(executions, distinctDays)
    ? columnBandForBreadth(distinctDays, executions)
    : undefined;
}

/** Object kind prefix (`00` table, `10` view, `20`/`30` synonym, `40` procedure, `90` other). */
export function getObjectKindPrefix(
  objectType: string | undefined,
  schema?: string,
): string {
  switch (objectType) {
    case "table":
      return "00";
    case "view":
    case "materialized-view":
      return "10";
    case "synonym":
      return schema && schema.toLocaleUpperCase() === "PUBLIC" ? "30" : "20";
    case "procedure":
      return "40";
    default:
      return "90";
  }
}

export function clampObjectBand(band: number | undefined): number | undefined {
  if (band === undefined || !Number.isFinite(band)) {
    return undefined;
  }
  return Math.max(OBJECT_BANDS.boostMin, Math.min(OBJECT_BANDS.demote, Math.round(band)));
}

export function isBoostBand(band: number | undefined): boolean {
  return band !== undefined
    && band >= OBJECT_BANDS.boostMin
    && band <= OBJECT_BANDS.boostMax;
}

export function isDemotedBand(band: number | undefined): boolean {
  return band !== undefined && band === OBJECT_BANDS.demote;
}

export interface ObjectSortTextInput {
  /** `0` = effective schema, `1` = other schema. */
  scope: "0" | "1";
  /** Two-digit kind prefix, see {@link getObjectKindPrefix}. */
  kind: string;
  /** Completion match rank 0-4; `0` is an exact prefix. */
  matchRank: number;
  /** Manual preference band (boost 00-09, learned 10-49, neutral 50, demote 90). */
  band?: number;
  /** Manual pin order; pin crosses scope/kind and is the only such crossing. */
  pinOrder?: number;
  name: string;
  /**
   * Emit `matchRank + neutral band` for objects without a preference. Callers
   * enable this only when at least one object preference is active so empty
   * knowledge keeps today's exact sortText grammar.
   */
  emitNeutralBand?: boolean;
}

/**
 * Build the sortText prefix for a FROM object:
 *
 * ```
 * 3_<scope><kind>_<matchRank><band>_NAME   # learned / neutral / demoted
 * 2_<pinOrder><matchRank>_NAME             # manual pin only
 * ```
 *
 * With no active object knowledge the legacy `3_<scope><kind>[_<rank>]_NAME`
 * form is preserved verbatim.
 */
export function buildObjectSortText(input: ObjectSortTextInput): string {
  const rank = Math.max(0, Math.min(9, Math.trunc(input.matchRank)));
  const pinOrder = input.pinOrder === undefined
    ? undefined
    : Math.max(0, Math.min(99, Math.trunc(input.pinOrder)));
  const hasBand = input.band !== undefined
    && input.band !== OBJECT_BANDS.neutral;

  if (pinOrder !== undefined) {
    return `2_${String(pinOrder).padStart(2, "0")}${rank}_${input.name}`;
  }

  if (hasBand || input.emitNeutralBand) {
    const band = hasBand ? clampObjectBand(input.band) ?? OBJECT_BANDS.neutral : OBJECT_BANDS.neutral;
    return `3_${input.scope}${input.kind}_${rank}${String(band).padStart(2, "0")}_${input.name}`;
  }

  return `3_${input.scope}${input.kind}_${rank > 0 ? `${rank}_` : ""}${input.name}`;
}
