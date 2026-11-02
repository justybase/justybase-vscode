import * as vscode from "vscode";
import {
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  explainObjectPreference,
  explainRelationDecision,
  type JoinKnowledgeExecutedSnapshot,
  type JoinKnowledgeIndex,
  type JoinKnowledgeRelationSnapshot,
  type JoinKnowledgeSnapshot,
  type JoinRelationEvidenceRecord,
  type JoinRelationOverride,
  type JoinRelationScoreOverride,
  type ObjectPreferenceOverride,
  type ObjectPreferenceSnapshot,
  type RelationColumn,
  type RelationIdentity,
  type TableRef,
  type WorkspaceIndexSnapshot,
  type WorkspaceObjectSnapshot,
  type WorkspaceRelationSnapshot,
} from "@justybase/sql-core/joinKnowledge";
import type {
  JoinKnowledgeManagerFocus,
  ManagerManualRelationInput,
  ManagerMeta,
  ManagerObjectRow,
  ManagerRelationRow,
  ManagerRelationSource,
  ManagerState,
  ManagerWebviewMessage,
} from "../contracts/joinKnowledgeManager";
import type { JoinKnowledgeService } from "../knowledge/joinKnowledgeService";
import type {
  WorkspaceIndexCoordinator,
  WorkspaceIndexStatus,
} from "../knowledge/workspaceIndexCoordinator";
import {
  getJoinKnowledgeExecutionCapture,
  getJoinKnowledgeService,
  getWorkspaceIndexCoordinator,
} from "../knowledge/joinKnowledgeRuntime";
import { tryGetLogger } from "../utils/logger";

export interface ConfiguredJoinRelation {
  left: TableRef;
  right: TableRef;
  columns: RelationColumn[];
}

interface RelationActionTarget {
  relation: RelationIdentity;
  /** Dialect used for the stored key; manager actions must reuse it. */
  databaseKind: string;
}

export interface ManagerStateInput {
  relationOverrides: readonly JoinRelationOverride[];
  relationScoreOverrides?: readonly JoinRelationScoreOverride[];
  objectOverrides: readonly ObjectPreferenceOverride[];
  workspaceSnapshot?: WorkspaceIndexSnapshot;
  executedSnapshot?: JoinKnowledgeExecutedSnapshot;
  configured: readonly ConfiguredJoinRelation[];
  status?: WorkspaceIndexStatus;
  execution?: ManagerMeta["execution"];
  personalizeEnabled: boolean;
}

const TIER_ORDER = ["0_0_", "0_1_", "0_3_", "0_4_", "0_5_", "below", "blocked"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tableRef(value: unknown): TableRef | undefined {
  if (!isRecord(value) || typeof value.table !== "string" || !value.table.trim()) {
    return undefined;
  }
  return {
    table: value.table.trim(),
    ...(typeof value.database === "string" && value.database.trim()
      ? { database: value.database.trim() }
      : {}),
    ...(typeof value.schema === "string" && value.schema.trim()
      ? { schema: value.schema.trim() }
      : {}),
  };
}

/** Parse the `justybase.sql.joinRelations` setting defensively. */
export function parseConfiguredRelations(value: unknown): ConfiguredJoinRelation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const relations: ConfiguredJoinRelation[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const left = tableRef(entry.left);
    const right = tableRef(entry.right);
    if (!left || !right || !Array.isArray(entry.columns)) {
      continue;
    }
    const columns: RelationColumn[] = [];
    for (const column of entry.columns) {
      if (!isRecord(column) || typeof column.left !== "string" || typeof column.right !== "string") {
        continue;
      }
      if (!column.left.trim() || !column.right.trim()) {
        continue;
      }
      columns.push({ left: column.left.trim(), right: column.right.trim() });
    }
    if (columns.length > 0) {
      relations.push({ left, right, columns });
    }
  }
  return relations;
}

function tableLabel(ref: TableRef): string {
  return [ref.database, ref.schema, ref.table].filter(Boolean).join(".");
}

function predicateLabel(relation: RelationIdentity): string {
  const display = relation.display;
  return display.columns
    .map((column) => `${tableLabel(display.left)}.${column.left} = ${tableLabel(display.right)}.${column.right}`)
    .join(" AND ");
}

function activeRelationOverrides(
  overrides: readonly JoinRelationOverride[],
): JoinRelationOverride[] {
  return overrides.filter((entry) => !entry.revertedAt);
}

function latestActiveScoreOverride(
  overrides: readonly JoinRelationScoreOverride[] | undefined,
  key: string,
): JoinRelationScoreOverride | undefined {
  const active = (overrides ?? []).filter(
    (entry) => !entry.revertedAt && entry.relationKey === key,
  );
  return active[active.length - 1];
}

export const RELATION_SCORE_ADJUSTMENT_LIMIT = 5;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a webview message before it can reach a mutation. TypeScript's
 * message union is not enforced at runtime, and an unknown action must never
 * fall through to a different mutation (for example an unknown object action
 * being treated as `exclude`).
 */
export function validateManagerMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "Malformed JOIN manager message.";
  }
  switch (value.type) {
    case "ready":
    case "refresh":
    case "rebuildIndex":
    case "openSettings":
      return undefined;
    case "relationAction":
      if (value.action !== "confirm" && value.action !== "block" && value.action !== "favorite") {
        return "Unsupported JOIN relation action.";
      }
      return isNonEmptyString(value.key) ? undefined : "A relation key is required.";
    case "relationScoreAction":
      if (value.action !== "increase" && value.action !== "decrease" && value.action !== "reset") {
        return "Unsupported JOIN ranking action.";
      }
      return isNonEmptyString(value.key) ? undefined : "A relation key is required.";
    case "objectAction":
      if (
        value.action !== "pin"
        && value.action !== "boost"
        && value.action !== "demote"
        && value.action !== "exclude"
      ) {
        return "Unsupported JOIN object action.";
      }
      return isNonEmptyString(value.key) ? undefined : "An object key is required.";
    case "revert":
      if (value.kind !== "relation" && value.kind !== "object" && value.kind !== "manual") {
        return "Unsupported JOIN revert kind.";
      }
      return isNonEmptyString(value.id) ? undefined : "An override id is required.";
    case "deleteEvidence":
      if (value.kind !== "relation" && value.kind !== "object") {
        return "Unsupported evidence kind.";
      }
      return isNonEmptyString(value.key) ? undefined : "An evidence key is required.";
    case "deleteAcceptedEvidence":
      return isNonEmptyString(value.key) ? undefined : "A relation key is required.";
    case "clearExecutedEvidence":
      if (value.kind !== "relation" && value.kind !== "object") {
        return "Unsupported executed-evidence kind.";
      }
      return isNonEmptyString(value.key) ? undefined : "An executed-evidence key is required.";
    case "clearAllExecutedEvidence":
      return undefined;
    case "bulk":
      if (value.action !== "exclude" && value.action !== "deleteEvidence") {
        return "Unsupported bulk action.";
      }
      return Array.isArray(value.keys) && value.keys.length > 0
        && value.keys.every(isNonEmptyString)
        ? undefined
        : "Bulk keys must be a non-empty array of identifiers.";
    case "saveManualRelation":
      return isRecord(value.relation) ? undefined : "A manual relation is required.";
    case "removeManualRelation":
      return isNonEmptyString(value.key) ? undefined : "A relation key is required.";
    default:
      return "Unknown JOIN manager message.";
  }
}

/**
 * Resolve one Raise/Lower/Reset click defensively. Unknown actions return
 * `undefined` instead of being treated as a decrement.
 */
export function nextRelationScoreAdjustment(
  current: number,
  action: unknown,
): number | undefined {
  if (action !== "increase" && action !== "decrease" && action !== "reset") {
    return undefined;
  }
  if (action === "reset") {
    return 0;
  }
  const bounded = Number.isFinite(current)
    ? Math.max(
      -RELATION_SCORE_ADJUSTMENT_LIMIT,
      Math.min(RELATION_SCORE_ADJUSTMENT_LIMIT, Math.trunc(current)),
    )
    : 0;
  return action === "increase"
    ? Math.min(RELATION_SCORE_ADJUSTMENT_LIMIT, bounded + 1)
    : Math.max(-RELATION_SCORE_ADJUSTMENT_LIMIT, bounded - 1);
}

function overrideIds(
  key: string,
  overrides: readonly JoinRelationOverride[],
): ManagerRelationRow["overrideIds"] {
  const ids: ManagerRelationRow["overrideIds"] = {};
  for (const entry of overrides) {
    if (entry.revertedAt || entry.relationKey !== key) {
      continue;
    }
    if (entry.kind === "confirm") {
      ids.confirm = entry.id;
    } else if (entry.kind === "block") {
      ids.block = entry.id;
    } else {
      ids.favorite = entry.id;
    }
  }
  return ids;
}

function latestCreatedAt(
  key: string,
  overrides: readonly JoinRelationOverride[],
): string | undefined {
  const timestamps = overrides
    .filter((entry) => !entry.revertedAt && entry.relationKey === key)
    .map((entry) => entry.createdAt)
    .sort();
  return timestamps[timestamps.length - 1];
}

function relationRank(
  key: string,
  index: JoinKnowledgeIndex,
  configured: boolean,
  workspace?: WorkspaceRelationSnapshot,
  executed?: JoinRelationEvidenceRecord,
): { tier: string; rankLabel: string } {
  if (index.blockedRelations.has(key)) {
    return { tier: "blocked", rankLabel: "Blocked (removed before tiering)" };
  }
  if (configured) {
    return { tier: "0_0_", rankLabel: "Configured manual relation (0_0_)" };
  }
  if (index.confirmedRelations.has(key)) {
    return { tier: "0_1_", rankLabel: "Confirmed by user (0_1_)" };
  }
  if (index.favoriteRelations.has(key)) {
    return { tier: "0_3_", rankLabel: "Favorite preference (0_3_, not confirmation)" };
  }
  if (executed && !executed.belowThreshold) {
    return {
      tier: "0_4_",
      rankLabel: "Executed successfully (0_4_, observed; not semantic confirmation)",
    };
  }
  if (workspace && !workspace.belowThreshold) {
    return { tier: "0_5_", rankLabel: "Workspace SQL evidence (0_5_)" };
  }
  if (executed) {
    return { tier: "below", rankLabel: "Executed evidence below threshold (stored, never ranked)" };
  }
  return { tier: "below", rankLabel: "Below threshold (stored, never ranked)" };
}

function relationSources(input: {
  key: string;
  configured: boolean;
  workspace?: WorkspaceRelationSnapshot;
  executed?: JoinRelationEvidenceRecord;
  overrides: readonly JoinRelationOverride[];
}): ManagerRelationSource[] {
  const sources: ManagerRelationSource[] = [];
  if (input.configured) {
    sources.push({
      kind: "configured",
      label: "justybase.sql.joinRelations",
      detail: "Manual relation, tier 0_0_; wins over every observed source.",
    });
  }
  for (const entry of input.overrides) {
    if (entry.revertedAt || entry.relationKey !== input.key) {
      continue;
    }
    if (entry.kind === "confirm") {
      sources.push({ kind: "confirmed", label: "Confirmed", detail: `Tier 0_1_, ${entry.createdAt}` });
    } else if (entry.kind === "block") {
      sources.push({ kind: "blocked", label: "Blocked", detail: `Applied before tiering, ${entry.createdAt}` });
    } else {
      sources.push({ kind: "favorite", label: "Favorite", detail: `Preference 0_3_, ${entry.createdAt}` });
    }
  }
  if (input.executed) {
    sources.push({
      kind: "executed",
      label: "Executed successfully",
      detail: input.executed.belowThreshold
        ? `${input.executed.observations} execution(s), ${input.executed.distinctDays} day(s) — below threshold; observed, not confirmation`
        : `${input.executed.observations} execution(s), ${input.executed.distinctDays} day(s) — eligible; observed, not confirmation`,
    });
  }
  if (input.workspace) {
    sources.push({
      kind: "workspace",
      label: "Workspace SQL",
      detail: input.workspace.belowThreshold
        ? `${input.workspace.distinctFiles} file(s), ${input.workspace.distinctQueries} query(ies), ${input.workspace.acceptedSelections ?? 0} accepted selection(s) — below threshold`
        : `${input.workspace.distinctFiles} file(s), ${input.workspace.distinctQueries} query(ies), ${input.workspace.acceptedSelections ?? 0} accepted selection(s) — eligible`,
    });
  }
  return sources;
}

function buildIndexSnapshot(input: ManagerStateInput): JoinKnowledgeSnapshot {
  const byKey = new Map<string, JoinRelationOverride[]>();
  for (const override of activeRelationOverrides(input.relationOverrides)) {
    const group = byKey.get(override.relationKey) ?? [];
    group.push(override);
    byKey.set(override.relationKey, group);
  }
  const relations: JoinKnowledgeRelationSnapshot[] = [];
  for (const [key, overrides] of byKey) {
    const blocked = overrides.some((entry) => entry.kind === "block");
    const confirmed = overrides.some((entry) => entry.kind === "confirm");
    const favorite = overrides.some((entry) => entry.kind === "favorite");
    const identity = (overrides.find((entry) => entry.kind === "block")
      ?? overrides.find((entry) => entry.kind === "confirm")
      ?? overrides.find((entry) => entry.kind === "favorite"))?.relation;
    if (!identity) {
      continue;
    }
    relations.push({
      key,
      decision: blocked ? "blocked" : confirmed ? "confirmed" : "favorite",
      ...(favorite ? { favorite: true } : {}),
      relation: identity,
    });
  }
  const objectPreferences: ObjectPreferenceSnapshot[] = input.objectOverrides
    .filter((entry) => !entry.revertedAt)
    .map((entry) => ({
      key: entry.objectKey,
      kind: entry.kind,
      object: entry.object,
      ...(entry.band !== undefined ? { band: entry.band } : {}),
      ...(entry.pinOrder !== undefined ? { pinOrder: entry.pinOrder } : {}),
    }));
  return {
    version: 1,
    relations,
    objectPreferences,
    relationScoreOverrides: (input.relationScoreOverrides ?? [])
      .filter((entry) => !entry.revertedAt),
    ...(input.workspaceSnapshot ? { workspace: input.workspaceSnapshot } : {}),
    ...(input.executedSnapshot ? { executed: input.executedSnapshot } : {}),
  };
}

function buildRelationRows(input: ManagerStateInput): {
  rows: ManagerRelationRow[];
  index: JoinKnowledgeIndex;
} {
  const index = buildJoinKnowledgeIndex(buildIndexSnapshot(input));

  const rows = new Map<string, ManagerRelationRow>();
  const configuredKeys = new Set<string>();
  const workspaceByKey = new Map(
    (input.workspaceSnapshot?.relations ?? []).map((entry) => [entry.key, entry]),
  );
  const executedByKey = new Map(
    (input.executedSnapshot?.relations ?? []).map((entry) => [entry.relationKey, entry]),
  );
  for (const relation of input.configured) {
    const canonical = canonicalizeRelation(relation, "netezza");
    if (!canonical) {
      continue;
    }
    configuredKeys.add(canonical.key);
    const rank = relationRank(
      canonical.key,
      index,
      true,
      workspaceByKey.get(canonical.key),
      executedByKey.get(canonical.key),
    );
    rows.set(canonical.key, {
      key: canonical.key,
      tables: `${tableLabel(canonical.display.left)} → ${tableLabel(canonical.display.right)}`,
      predicate: predicateLabel(canonical),
      left: canonical.display.left,
      right: canonical.display.right,
      columns: canonical.display.columns.map((column) => ({ left: column.left, right: column.right })),
      decision: index.blockedRelations.has(canonical.key)
        ? "blocked"
        : index.confirmedRelations.has(canonical.key)
          ? "confirmed"
          : index.favoriteRelations.has(canonical.key)
            ? "favorite"
            : "none",
      favorite: index.favoriteRelations.has(canonical.key),
      scoreAdjustment: 0,
      tier: rank.tier,
      rankLabel: rank.rankLabel,
      sources: [],
      explanation: [],
      configured: true,
      overrideIds: overrideIds(canonical.key, input.relationOverrides),
      ...(latestCreatedAt(canonical.key, input.relationOverrides)
        ? { updatedAt: latestCreatedAt(canonical.key, input.relationOverrides) }
        : {}),
    });
  }

  for (const override of activeRelationOverrides(input.relationOverrides)) {
    const existing = rows.get(override.relationKey);
    if (existing) {
      continue;
    }
    const relation = override.relation;
    const rank = relationRank(
      override.relationKey,
      index,
      false,
      workspaceByKey.get(override.relationKey),
      executedByKey.get(override.relationKey),
    );
    rows.set(override.relationKey, {
      key: override.relationKey,
      tables: `${tableLabel(relation.display.left)} → ${tableLabel(relation.display.right)}`,
      predicate: predicateLabel(relation),
      left: relation.display.left,
      right: relation.display.right,
      columns: relation.display.columns.map((column) => ({ left: column.left, right: column.right })),
      decision: index.blockedRelations.has(override.relationKey)
        ? "blocked"
        : index.confirmedRelations.has(override.relationKey)
          ? "confirmed"
          : index.favoriteRelations.has(override.relationKey)
            ? "favorite"
            : "none",
      favorite: index.favoriteRelations.has(override.relationKey),
      scoreAdjustment: 0,
      tier: rank.tier,
      rankLabel: rank.rankLabel,
      sources: [],
      explanation: [],
      configured: false,
      overrideIds: overrideIds(override.relationKey, input.relationOverrides),
      ...(latestCreatedAt(override.relationKey, input.relationOverrides)
        ? { updatedAt: latestCreatedAt(override.relationKey, input.relationOverrides) }
        : {}),
    });
  }

  for (const scoreOverride of input.relationScoreOverrides ?? []) {
    if (scoreOverride.revertedAt || rows.has(scoreOverride.relationKey)) {
      continue;
    }
    const relation = scoreOverride.relation;
    rows.set(scoreOverride.relationKey, {
      key: scoreOverride.relationKey,
      tables: `${tableLabel(relation.display.left)} → ${tableLabel(relation.display.right)}`,
      predicate: predicateLabel(relation),
      left: relation.display.left,
      right: relation.display.right,
      columns: relation.display.columns.map((column) => ({ left: column.left, right: column.right })),
      decision: "none",
      favorite: false,
      scoreAdjustment: 0,
      tier: "below",
      rankLabel: "No active suggestion source (score retained)",
      sources: [],
      explanation: ["The user score is retained but does not make a relation eligible for suggestions."],
      configured: false,
      overrideIds: {},
    });
  }

  for (const workspace of input.workspaceSnapshot?.relations ?? []) {
    if (rows.has(workspace.key)) {
      continue;
    }
    const rank = relationRank(
      workspace.key,
      index,
      false,
      workspaceByKey.get(workspace.key),
      executedByKey.get(workspace.key),
    );
    rows.set(workspace.key, {
      key: workspace.key,
      tables: `${tableLabel(workspace.relation.display.left)} → ${tableLabel(workspace.relation.display.right)}`,
      predicate: predicateLabel(workspace.relation),
      left: workspace.relation.display.left,
      right: workspace.relation.display.right,
      columns: workspace.relation.display.columns.map((column) => ({ left: column.left, right: column.right })),
      decision: "none",
      favorite: false,
      scoreAdjustment: 0,
      tier: rank.tier,
      rankLabel: rank.rankLabel,
      sources: [],
      explanation: [],
      configured: false,
      overrideIds: {},
    });
  }

  for (const executed of input.executedSnapshot?.relations ?? []) {
    if (rows.has(executed.relationKey)) {
      continue;
    }
    const rank = relationRank(
      executed.relationKey,
      index,
      false,
      workspaceByKey.get(executed.relationKey),
      executed,
    );
    rows.set(executed.relationKey, {
      key: executed.relationKey,
      tables: `${tableLabel(executed.relation.display.left)} → ${tableLabel(executed.relation.display.right)}`,
      predicate: predicateLabel(executed.relation),
      left: executed.relation.display.left,
      right: executed.relation.display.right,
      columns: executed.relation.display.columns.map((column) => ({ left: column.left, right: column.right })),
      decision: "none",
      favorite: false,
      scoreAdjustment: 0,
      tier: rank.tier,
      rankLabel: rank.rankLabel,
      sources: [],
      explanation: [],
      configured: false,
      overrideIds: {},
    });
  }

  for (const [key, row] of rows) {
    const scoreOverride = latestActiveScoreOverride(input.relationScoreOverrides, key);
    row.scoreAdjustment = scoreOverride?.adjustment ?? 0;
    if (scoreOverride) {
      row.overrideIds.score = scoreOverride.id;
      row.rankLabel += ` · user score ${scoreOverride.adjustment > 0 ? "+" : ""}${scoreOverride.adjustment}`;
    }
    const workspace = workspaceByKey.get(key);
    const executed = executedByKey.get(key);
    const configured = configuredKeys.has(key);
    row.sources = relationSources({
      key,
      configured,
      ...(workspace ? { workspace } : {}),
      ...(executed ? { executed } : {}),
      overrides: input.relationOverrides,
    });
    const explanation = [
      ...row.explanation,
      ...explainRelationDecision(index, key).reasons,
    ];
    if (configured) {
      explanation.unshift("configured in justybase.sql.joinRelations (tier 0_0_, manual)");
    }
    if (executed) {
      explanation.push(
        executed.belowThreshold
          ? `executed evidence is below threshold: ${executed.observations} execution(s), ${executed.distinctDays} day(s); success is not semantic confirmation`
          : `executed evidence is eligible: ${executed.observations} execution(s), ${executed.distinctDays} day(s); success is not semantic confirmation`,
      );
    }
    if (workspace) {
      explanation.push(
        workspace.belowThreshold
          ? `workspace evidence is below threshold: ${workspace.distinctFiles} file(s), ${workspace.distinctQueries} file query(ies), ${workspace.acceptedSelections ?? 0} accepted selection(s), weighted queries ${workspace.weightedQueries ?? workspace.distinctQueries}`
          : `workspace evidence is eligible: ${workspace.distinctFiles} file(s), ${workspace.distinctQueries} file query(ies), ${workspace.acceptedSelections ?? 0} accepted selection(s), weighted queries ${workspace.weightedQueries ?? workspace.distinctQueries}`,
      );
    }
    if (scoreOverride) {
      explanation.push(
        `user score adjustment: ${scoreOverride.adjustment > 0 ? "+" : ""}${scoreOverride.adjustment} within this rank tier`,
      );
    }
    row.explanation = [...new Set(explanation)];
    if (executed) {
      row.executed = {
        observations: executed.observations,
        distinctDays: executed.distinctDays,
        belowThreshold: executed.belowThreshold,
      };
    }
    if (workspace) {
      row.workspace = {
        observations: workspace.observations,
        distinctFiles: workspace.distinctFiles,
        distinctQueries: workspace.distinctQueries,
        acceptedSelections: workspace.acceptedSelections ?? 0,
        weightedQueries: workspace.weightedQueries ?? workspace.distinctQueries,
        belowThreshold: workspace.belowThreshold,
      };
    }
  }

  return {
    rows: [...rows.values()].sort((left, right) =>
      TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier)
      || left.tables.localeCompare(right.tables, "en")
      || left.predicate.localeCompare(right.predicate, "en"),
    ),
    index,
  };
}

function usageCountersLabel(usage: {
  select: number;
  insert: number;
  update: number;
  delete: number;
}): string {
  return `SELECT ${usage.select}, INSERT ${usage.insert}, UPDATE ${usage.update}, DELETE ${usage.delete}`;
}

function objectUsageLabel(workspace: WorkspaceObjectSnapshot): string {
  return usageCountersLabel(workspace.usage);
}

function buildObjectRows(
  input: ManagerStateInput,
  index: JoinKnowledgeIndex,
): ManagerObjectRow[] {
  const rows = new Map<string, ManagerObjectRow>();
  for (const override of input.objectOverrides) {
    if (override.revertedAt) {
      continue;
    }
    const object = override.object;
    const explanation = explainObjectPreference(index, override.objectKey);
    const label = [object.database, object.schema, object.name].filter(Boolean).join(".");
    rows.set(override.objectKey, {
      key: override.objectKey,
      label,
      name: object.name,
      ...(object.database ? { database: object.database } : {}),
      ...(object.schema ? { schema: object.schema } : {}),
      kind: override.kind,
      ...(override.band !== undefined ? { band: override.band } : {}),
      ...(override.pinOrder !== undefined ? { pinOrder: override.pinOrder } : {}),
      tier: override.kind === "pin"
        ? `2_${override.pinOrder ?? 0}`
        : override.kind === "exclude"
          ? "excluded"
          : override.kind === "demote"
            ? "90"
            : String(override.band ?? 0).padStart(2, "0"),
      rankLabel: override.kind === "pin"
        ? `Pinned at ${override.pinOrder ?? 0} (sortText only)`
        : override.kind === "exclude"
          ? "Excluded from FROM sources"
          : override.kind === "demote"
            ? "Demoted (band 90)"
            : `Boosted to band ${String(override.band ?? 0).padStart(2, "0")}`,
      explanation: explanation.reasons,
      overrideId: override.id,
      updatedAt: override.createdAt,
    });
  }

  for (const workspace of input.workspaceSnapshot?.objects ?? []) {
    const existing = rows.get(workspace.key);
    const usage = {
      ...workspace.usage,
      distinctFiles: workspace.distinctFiles,
      distinctQueries: workspace.distinctQueries,
      belowThreshold: workspace.belowThreshold,
    };
    if (existing) {
      existing.usage = usage;
      existing.explanation = [
        ...existing.explanation,
        `workspace usage ${objectUsageLabel(workspace)}; ${workspace.belowThreshold ? "below threshold" : `band ${String(workspace.band ?? 50).padStart(2, "0")}`}`,
      ];
      continue;
    }
    const object = workspace.object;
    rows.set(workspace.key, {
      key: workspace.key,
      label: [object.database, object.schema, object.name].filter(Boolean).join("."),
      name: object.name,
      ...(object.database ? { database: object.database } : {}),
      ...(object.schema ? { schema: object.schema } : {}),
      kind: workspace.belowThreshold ? "neutral" : "learned",
      ...(workspace.band !== undefined ? { band: workspace.band } : {}),
      tier: workspace.belowThreshold ? "below" : String(workspace.band ?? 50).padStart(2, "0"),
      rankLabel: workspace.belowThreshold
        ? "Below threshold (stored, never ranked)"
        : `Workspace usage band ${String(workspace.band ?? 50).padStart(2, "0")}`,
      explanation: [
        workspace.belowThreshold
          ? "workspace usage is below threshold and never ranked"
          : "workspace usage moved the band inside match rank/scope/kind",
      ],
      usage,
    });
  }

  for (const executed of input.executedSnapshot?.objects ?? []) {
    const existing = rows.get(executed.objectKey);
    const counters = {
      usage: { ...executed.usage },
      observations: executed.observations ?? 0,
      distinctDays: executed.distinctDays ?? 0,
      ...(executed.belowThreshold ? {} : { band: executed.bestBand }),
      belowThreshold: executed.belowThreshold,
    };
    const explanation = executed.belowThreshold
      ? `executed usage ${usageCountersLabel(executed.usage)}; ${executed.observations ?? 0} execution(s), ${executed.distinctDays ?? 0} day(s); below threshold`
      : `executed usage ${usageCountersLabel(executed.usage)}; ${executed.observations ?? 0} execution(s), ${executed.distinctDays ?? 0} day(s); band ${String(executed.bestBand).padStart(2, "0")}`;
    if (existing) {
      existing.executed = counters;
      existing.explanation = [...existing.explanation, explanation];
      if (
        !executed.belowThreshold
        && (existing.kind === "neutral" || existing.kind === "learned")
        && (existing.band === undefined || executed.bestBand < existing.band)
      ) {
        existing.kind = "learned";
        existing.band = executed.bestBand;
        existing.tier = String(executed.bestBand).padStart(2, "0");
        existing.rankLabel = `Executed usage band ${String(executed.bestBand).padStart(2, "0")}`;
      }
      continue;
    }
    const object = executed.object;
    rows.set(executed.objectKey, {
      key: executed.objectKey,
      label: [object.database, object.schema, object.name].filter(Boolean).join("."),
      name: object.name,
      ...(object.database ? { database: object.database } : {}),
      ...(object.schema ? { schema: object.schema } : {}),
      kind: executed.belowThreshold ? "neutral" : "learned",
      ...(executed.belowThreshold ? {} : { band: executed.bestBand }),
      tier: executed.belowThreshold ? "below" : String(executed.bestBand).padStart(2, "0"),
      rankLabel: executed.belowThreshold
        ? "Executed usage below threshold (stored, never ranked)"
        : `Executed usage band ${String(executed.bestBand).padStart(2, "0")}`,
      explanation: [explanation],
      executed: counters,
    });
  }

  return [...rows.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "en"),
  );
}

/** Pure state builder used by the provider and unit tests. */
export function buildManagerState(input: ManagerStateInput): ManagerState {
  const { rows: relations, index } = buildRelationRows(input);
  const objects = buildObjectRows(input, index);
  const status = input.status;
  const executedRelations = input.executedSnapshot?.relations ?? [];
  const executedObjects = input.executedSnapshot?.objects ?? [];
  const execution: ManagerMeta["execution"] = {
    relations: executedRelations.length,
    relationsBelowThreshold: executedRelations.filter((entry) => entry.belowThreshold).length,
    objects: executedObjects.length,
    objectsBelowThreshold: executedObjects.filter((entry) => entry.belowThreshold).length,
    truncated: input.execution?.truncated === true,
    ...(input.execution?.observed !== undefined ? { observed: input.execution.observed } : {}),
    ...(input.execution?.recorded !== undefined ? { recorded: input.execution.recorded } : {}),
    ...(input.execution?.duplicates !== undefined ? { duplicates: input.execution.duplicates } : {}),
    ...(input.execution?.notDurable !== undefined ? { notDurable: input.execution.notDurable } : {}),
    ...(input.execution?.skipped ? { skipped: { ...input.execution.skipped } } : {}),
  };
  const meta: ManagerMeta = {
    indexingEnabled: status?.enabled === true,
    personalizeEnabled: input.personalizeEnabled,
    truncated: status?.truncated === true,
    gitMode: status?.git.mode ?? "disabled",
    filesIndexed: status?.filesIndexed ?? 0,
    ...(status?.lastIndexedAt ? { lastIndexedAt: status.lastIndexedAt } : {}),
    ...(status?.lastError ? { lastError: status.lastError } : {}),
    configuredCount: input.configured.length,
    counts: {
      relations: relations.length,
      confirmed: relations.filter((row) => row.decision === "confirmed").length,
      blocked: relations.filter((row) => row.decision === "blocked").length,
      favorites: relations.filter((row) => row.favorite).length,
      objects: objects.length,
      pinned: objects.filter((row) => row.kind === "pin").length,
      excluded: objects.filter((row) => row.kind === "exclude").length,
    },
    ...(input.execution || executedRelations.length > 0 || executedObjects.length > 0
      ? { execution }
      : {}),
  };
  return { tab: "relations", relations, objects, meta };
}

function parseManualColumns(columns: string): RelationColumn[] {
  return columns
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split("=");
      return {
        left: (left ?? "").trim(),
        right: (right ?? "").trim(),
      };
    })
    .filter((column) => column.left.length > 0 && column.right.length > 0);
}

function manualRelationToSetting(
  relation: ManagerManualRelationInput,
): ConfiguredJoinRelation {
  const scope = (database?: string, schema?: string) => ({
    ...(database?.trim() ? { database: database.trim() } : {}),
    ...(schema?.trim() ? { schema: schema.trim() } : {}),
  });
  return {
    left: {
      ...scope(relation.leftDatabase, relation.leftSchema),
      table: relation.leftTable.trim(),
    },
    right: {
      ...scope(relation.rightDatabase, relation.rightSchema),
      table: relation.rightTable.trim(),
    },
    columns: parseManualColumns(relation.columns),
  };
}

function manualRelationKey(relation: ConfiguredJoinRelation): string | undefined {
  return canonicalizeRelation(relation, "netezza")?.key;
}

function configuredSettingValue(relations: readonly ConfiguredJoinRelation[]): unknown[] {
  return relations.map((relation) => ({
    left: relation.left,
    right: relation.right,
    columns: relation.columns,
  }));
}

export class JoinKnowledgeManagerView {
  public static readonly viewType = "netezza.joinKnowledge";

  private panel?: vscode.WebviewPanel;
  /** Applied with the next state message only. */
  private pendingFocus?: JoinKnowledgeManagerFocus;
  private disposables: vscode.Disposable[] = [];
  private lastManualUndo?: ConfiguredJoinRelation[];
  private attachedToService = false;
  private attachedToIndex = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly serviceProvider: () => JoinKnowledgeService | undefined = getJoinKnowledgeService,
    private readonly indexProvider: () => WorkspaceIndexCoordinator | undefined = getWorkspaceIndexCoordinator,
  ) {}

  public openInEditor(focus?: JoinKnowledgeManagerFocus): void {
    this.pendingFocus = focus;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.postState();
      return;
    }
    this.disposeSubscriptions();
    const panel = vscode.window.createWebviewPanel(
      JoinKnowledgeManagerView.viewType,
      "JOIN Knowledge",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: false,
      },
    );
    this.panel = panel;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    panel.webview.html = this.html(panel.webview);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: ManagerWebviewMessage) => {
        void this.handleMessage(message);
      }),
      panel.onDidDispose(() => this.disposeSubscriptions()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("justybase.sql.joinRelations")
          || event.affectsConfiguration("justybase.sql.personalizeFromObjects")
        ) {
          this.postState();
        }
      }),
    );
    this.ensureRuntimeSubscriptions();
    this.postState();
  }

  private ensureRuntimeSubscriptions(): void {
    const service = this.serviceProvider();
    if (service && !this.attachedToService) {
      this.attachedToService = true;
      this.disposables.push(service.onDidChange(() => this.postState()));
    }
    const index = this.indexProvider();
    if (index && !this.attachedToIndex) {
      this.attachedToIndex = true;
      this.disposables.push(index.onDidChange(() => this.postState()));
    }
  }

  private disposeSubscriptions(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel = undefined;
    this.attachedToService = false;
    this.attachedToIndex = false;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private postState(): void {
    if (!this.panel) {
      return;
    }
    this.ensureRuntimeSubscriptions();
    const service = this.serviceProvider();
    const index = this.indexProvider();
    const snapshot = this.knowledgeSnapshot();
    const state = buildManagerState({
      relationOverrides: service?.getRelationOverrides() ?? [],
      relationScoreOverrides: service?.getRelationScoreOverrides() ?? [],
      objectOverrides: service?.getObjectOverrides() ?? [],
      workspaceSnapshot: snapshot?.workspace ?? index?.getSnapshot(),
      ...(snapshot?.executed ? { executedSnapshot: snapshot.executed } : {}),
      configured: this.configuredRelations(),
      ...(index ? { status: index.getStatus() } : {}),
      ...(this.executionMeta(snapshot) ? { execution: this.executionMeta(snapshot) } : {}),
      personalizeEnabled: vscode.workspace
        .getConfiguration("justybase.sql")
        .get<boolean>("personalizeFromObjects", true),
    });
    const focus = this.pendingFocus;
    this.pendingFocus = undefined;
    this.post({ type: "state", state, ...(focus ? { focus } : {}) });
  }

  private configuredRelations(): ConfiguredJoinRelation[] {
    return parseConfiguredRelations(
      vscode.workspace.getConfiguration("justybase.sql").get<unknown>("joinRelations", []),
    );
  }

  private knowledgeSnapshot(): JoinKnowledgeSnapshot | undefined {
    const index = this.indexProvider();
    return this.serviceProvider()?.getSnapshot(index?.getSnapshot());
  }

  private workspaceSnapshot(): WorkspaceIndexSnapshot | undefined {
    return this.knowledgeSnapshot()?.workspace ?? this.indexProvider()?.getSnapshot();
  }

  private executedSnapshot(): JoinKnowledgeExecutedSnapshot | undefined {
    return this.knowledgeSnapshot()?.executed;
  }

  private executionMeta(
    snapshot: JoinKnowledgeSnapshot | undefined = this.knowledgeSnapshot(),
  ): ManagerMeta["execution"] | undefined {
    const executed = snapshot?.executed;
    const capture = getJoinKnowledgeExecutionCapture()?.getCounters();
    if (!executed && !capture) {
      return undefined;
    }
    const relations = executed?.relations ?? [];
    const objects = executed?.objects ?? [];
    return {
      relations: relations.length,
      relationsBelowThreshold: relations.filter((entry) => entry.belowThreshold).length,
      objects: objects.length,
      objectsBelowThreshold: objects.filter((entry) => entry.belowThreshold).length,
      truncated: this.serviceProvider()?.getDiagnostics().executed.truncated === true,
      ...(capture ? {
        observed: capture.observed,
        recorded: capture.recorded,
        duplicates: capture.duplicates,
        notDurable: capture.notDurable,
        skipped: { ...capture.skipped },
      } : {}),
    };
  }

  private relationForKey(key: string): RelationActionTarget | undefined {
    const service = this.serviceProvider();
    const index = this.indexProvider();
    const state = buildManagerState({
      relationOverrides: service?.getRelationOverrides() ?? [],
      relationScoreOverrides: service?.getRelationScoreOverrides() ?? [],
      objectOverrides: service?.getObjectOverrides() ?? [],
      workspaceSnapshot: this.workspaceSnapshot(),
      ...(this.executedSnapshot() ? { executedSnapshot: this.executedSnapshot() } : {}),
      configured: this.configuredRelations(),
      ...(index ? { status: index.getStatus() } : {}),
      personalizeEnabled: true,
    });
    const row = state.relations.find((entry) => entry.key === key);
    if (!row) {
      return undefined;
    }
    return this.relationForRow(row);
  }

  private relationForRow(row: ManagerRelationRow): RelationActionTarget | undefined {
    const configured = this.configuredRelations().find(
      (relation) => manualRelationKey(relation) === row.key,
    );
    if (configured) {
      const relation = canonicalizeRelation(configured, "netezza");
      return relation ? { relation, databaseKind: "netezza" } : undefined;
    }
    const service = this.serviceProvider();
    const override = service?.getRelationOverrides().find(
      (entry) => !entry.revertedAt && entry.relationKey === row.key,
    );
    if (override) {
      return {
        relation: override.relation,
        databaseKind: override.databaseKind ?? "netezza",
      };
    }
    const scoreOverride = latestActiveScoreOverride(
      service?.getRelationScoreOverrides(),
      row.key,
    );
    if (scoreOverride) {
      return {
        relation: scoreOverride.relation,
        databaseKind: scoreOverride.databaseKind ?? "netezza",
      };
    }
    const executed = this.executedSnapshot()?.relations
      .find((entry) => entry.relationKey === row.key);
    if (executed) {
      return { relation: executed.relation, databaseKind: executed.databaseKind ?? "netezza" };
    }
    const workspace = this.workspaceSnapshot()?.relations
      .find((entry) => entry.key === row.key)?.relation;
    // The workspace index is built with the manager's default Netezza folding
    // and does not carry a per-relation dialect.
    return workspace ? { relation: workspace, databaseKind: "netezza" } : undefined;
  }

  private async handleMessage(message: ManagerWebviewMessage): Promise<void> {
    try {
      const invalid = validateManagerMessage(message);
      if (invalid) {
        throw new Error(invalid);
      }
      switch (message.type) {
        case "ready":
        case "refresh":
          this.postState();
          return;
        case "relationAction": {
          const target = this.relationForKey(message.key);
          const service = this.serviceProvider();
          if (!target || !service) {
            throw new Error("The selected relation is no longer available.");
          }
          const input = {
            left: target.relation.display.left,
            right: target.relation.display.right,
            columns: target.relation.display.columns,
            databaseKind: target.databaseKind,
          };
          let id: string | undefined;
          let verb: string;
          if (message.action === "confirm") {
            id = await service.confirmRelation(input);
            verb = "confirmed";
          } else if (message.action === "block") {
            id = await service.blockRelation(input);
            verb = "blocked";
          } else {
            const result = await service.toggleFavoriteRelation(input);
            id = result.id;
            verb = result.favorited ? "favorited" : "favorite removed";
          }
          this.lastManualUndo = undefined;
          this.post({
            type: "actionResult",
            ok: true,
            message: `Relation ${verb}.`,
            ...(id ? { undo: { kind: "relation" as const, id, label: `Undo ${verb}` } } : {}),
          });
          this.postState();
          return;
        }
        case "relationScoreAction": {
          if (typeof message.key !== "string" || message.key.trim().length === 0) {
            throw new Error("A relation key is required.");
          }
          const target = this.relationForKey(message.key);
          const service = this.serviceProvider();
          if (!target || !service) {
            throw new Error("The selected relation is no longer available.");
          }
          const current = latestActiveScoreOverride(
            service.getRelationScoreOverrides(),
            message.key,
          )?.adjustment ?? 0;
          const adjustment = nextRelationScoreAdjustment(current, message.action);
          if (adjustment === undefined) {
            throw new Error("Unsupported JOIN ranking action.");
          }
          const input = {
            left: target.relation.display.left,
            right: target.relation.display.right,
            columns: target.relation.display.columns,
            databaseKind: target.databaseKind,
          };
          if (message.action === "reset") {
            const cleared = await service.clearRelationScoreAdjustment(input);
            this.post({
              type: "actionResult",
              ok: true,
              message: cleared
                ? "JOIN ranking score reset."
                : "JOIN ranking score is already neutral.",
            });
            this.postState();
            return;
          }
          if (adjustment === current) {
            const limitText = adjustment > 0 ? `+${adjustment}` : String(adjustment);
            this.post({
              type: "actionResult",
              ok: true,
              message: `JOIN ranking score is already at ${limitText}.`,
            });
            this.postState();
            return;
          }
          await service.setRelationScoreAdjustment(input, adjustment);
          this.post({
            type: "actionResult",
            ok: true,
            message: `JOIN ranking score set to ${adjustment > 0 ? "+" : ""}${adjustment}.`,
          });
          this.postState();
          return;
        }
        case "objectAction": {
          const service = this.serviceProvider();
          const state = buildManagerState({
            relationOverrides: service?.getRelationOverrides() ?? [],
            relationScoreOverrides: service?.getRelationScoreOverrides() ?? [],
            objectOverrides: service?.getObjectOverrides() ?? [],
            workspaceSnapshot: this.workspaceSnapshot(),
            ...(this.executedSnapshot() ? { executedSnapshot: this.executedSnapshot() } : {}),
            configured: this.configuredRelations(),
            ...(this.indexProvider() ? { status: this.indexProvider()!.getStatus() } : {}),
            personalizeEnabled: true,
          });
          const row = state.objects.find((entry) => entry.key === message.key);
          if (!service || !row) {
            throw new Error("The selected object is no longer available.");
          }
          const input = {
            object: {
              name: row.name,
              ...(row.database ? { database: row.database } : {}),
              ...(row.schema ? { schema: row.schema } : {}),
            },
            databaseKind: "netezza",
            ...(message.band !== undefined ? { band: message.band } : {}),
            ...(message.pinOrder !== undefined && Number.isFinite(message.pinOrder)
              ? { pinOrder: message.pinOrder }
              : {}),
          };
          let id: string;
          if (message.action === "pin") {
            id = await service.pinObject(input);
          } else if (message.action === "boost") {
            id = await service.boostObject({ ...input, band: message.band ?? 5 });
          } else if (message.action === "demote") {
            id = await service.demoteObject(input);
          } else {
            id = await service.excludeObject(input);
          }
          this.lastManualUndo = undefined;
          this.post({
            type: "actionResult",
            ok: true,
            message: `Object ${message.action}.`,
            undo: { kind: "object", id, label: `Undo ${message.action}` },
          });
          this.postState();
          return;
        }
        case "revert": {
          if (message.kind === "manual") {
            if (!this.lastManualUndo) {
              this.post({ type: "actionResult", ok: false, message: "There is no manual relation change to undo." });
              return;
            }
            const previous = this.lastManualUndo;
            this.lastManualUndo = undefined;
            await this.writeConfiguredRelations(previous);
            this.post({ type: "actionResult", ok: true, message: "Manual relation change undone." });
            this.postState();
            return;
          }
          const service = this.serviceProvider();
          if (!service) {
            throw new Error("JOIN knowledge is not available in this host.");
          }
          const reverted = message.kind === "relation"
            ? await service.revertRelationOverride(message.id)
            : await service.revertObjectPreference(message.id);
          this.post({
            type: "actionResult",
            ok: reverted,
            message: reverted ? "Decision reverted." : "The decision was already reverted.",
          });
          this.postState();
          return;
        }
        case "deleteEvidence": {
          const index = this.indexProvider();
          if (!index) {
            throw new Error("Workspace indexing is disabled in this workspace.");
          }
          const choice = await vscode.window.showWarningMessage(
            message.kind === "relation"
              ? "Delete indexed SQL JOIN evidence?"
              : "Delete observed workspace object evidence?",
            {
              modal: true,
              detail: message.kind === "relation"
                ? "Only file-indexed SQL evidence is removed. Accepted completion selections, score adjustments and manual decisions stay."
                : "Only observed workspace object evidence is removed. Manual object preferences stay. A later edit or rebuild can re-observe the object.",
            },
            "Delete evidence",
          );
          if (choice !== "Delete evidence") {
            this.post({ type: "actionResult", ok: false, message: "Evidence deletion cancelled." });
            return;
          }
          if (message.kind === "relation") {
            await index.deleteRelationEvidence(message.key);
          } else {
            await index.deleteObjectEvidence(message.key);
          }
          this.post({
            type: "actionResult",
            ok: true,
            message: message.kind === "relation"
              ? "Indexed SQL JOIN evidence deleted."
              : "Observed workspace object evidence deleted.",
          });
          this.postState();
          return;
        }
        case "deleteAcceptedEvidence": {
          const service = this.serviceProvider();
          if (!service) {
            throw new Error("JOIN knowledge is not available in this host.");
          }
          const choice = await vscode.window.showWarningMessage(
            "Clear accepted JOIN selections?",
            {
              modal: true,
              detail: "Only the half-weight completion-selection counter is removed. Indexed SQL evidence, score adjustments and manual decisions stay.",
            },
            "Clear selections",
          );
          if (choice !== "Clear selections") {
            this.post({ type: "actionResult", ok: false, message: "Accepted-selection deletion cancelled." });
            return;
          }
          const removed = await service.deleteAcceptedRelationEvidence(message.key);
          this.post({
            type: "actionResult",
            ok: removed,
            message: removed
              ? "Accepted JOIN selections cleared."
              : "No accepted selections remain for this relation.",
          });
          this.postState();
          return;
        }
        case "clearExecutedEvidence": {
          const service = this.serviceProvider();
          if (!service) {
            throw new Error("JOIN knowledge is not available in this host.");
          }
          const choice = await vscode.window.showWarningMessage(
            message.kind === "relation"
              ? "Clear executed JOIN evidence?"
              : "Clear executed object usage?",
            {
              modal: true,
              detail: "Only successful-execution evidence is removed. Manual decisions, favorites, score adjustments, accepted selections and workspace evidence stay.",
            },
            "Clear executed evidence",
          );
          if (choice !== "Clear executed evidence") {
            this.post({ type: "actionResult", ok: false, message: "Executed-evidence deletion cancelled." });
            return;
          }
          const removed = message.kind === "relation"
            ? await service.deleteExecutedRelationEvidence(message.key)
            : await service.deleteExecutedObjectEvidence(message.key);
          this.post({
            type: "actionResult",
            ok: removed,
            message: removed
              ? "Executed evidence cleared."
              : "No executed evidence remains for this entry.",
          });
          this.postState();
          return;
        }
        case "clearAllExecutedEvidence": {
          const service = this.serviceProvider();
          if (!service) {
            throw new Error("JOIN knowledge is not available in this host.");
          }
          const choice = await vscode.window.showWarningMessage(
            "Clear all executed evidence?",
            {
              modal: true,
              detail: "Only successful-execution relation and object evidence is removed. Manual decisions, favorites, score adjustments, accepted selections and workspace evidence stay.",
            },
            "Clear all executed evidence",
          );
          if (choice !== "Clear all executed evidence") {
            this.post({ type: "actionResult", ok: false, message: "Executed-evidence deletion cancelled." });
            return;
          }
          const removed = await service.clearExecutedEvidence();
          this.post({
            type: "actionResult",
            ok: true,
            message: `Executed evidence cleared: ${removed.relations} relation(s), ${removed.objects} object(s).`,
          });
          this.postState();
          return;
        }
        case "bulk": {
          const service = this.serviceProvider();
          const index = this.indexProvider();
          if (message.keys.length === 0) {
            return;
          }
          if (message.action === "exclude") {
            if (!service) {
              throw new Error("JOIN knowledge is not available in this host.");
            }
            const state = buildManagerState({
              relationOverrides: service.getRelationOverrides(),
              relationScoreOverrides: service.getRelationScoreOverrides(),
              objectOverrides: service.getObjectOverrides(),
              workspaceSnapshot: this.workspaceSnapshot(),
              ...(this.executedSnapshot() ? { executedSnapshot: this.executedSnapshot() } : {}),
              configured: this.configuredRelations(),
              ...(index ? { status: index.getStatus() } : {}),
              personalizeEnabled: true,
            });
            for (const key of message.keys) {
              const row = state.objects.find((entry) => entry.key === key);
              if (!row) {
                continue;
              }
              await service.excludeObject({
                object: {
                  name: row.name,
                  ...(row.database ? { database: row.database } : {}),
                  ...(row.schema ? { schema: row.schema } : {}),
                },
                databaseKind: "netezza",
              });
            }
            this.post({ type: "actionResult", ok: true, message: `Excluded ${message.keys.length} object(s).` });
          } else {
            if (!index) {
              throw new Error("Workspace indexing is disabled in this workspace.");
            }
            const choice = await vscode.window.showWarningMessage(
              `Delete observed evidence for ${message.keys.length} object(s)?`,
              { modal: true },
              "Delete evidence",
            );
            if (choice !== "Delete evidence") {
              this.post({ type: "actionResult", ok: false, message: "Evidence deletion cancelled." });
              return;
            }
            for (const key of message.keys) {
              await index.deleteObjectEvidence(key);
            }
            this.post({ type: "actionResult", ok: true, message: "Observed object evidence deleted." });
          }
          this.postState();
          return;
        }
        case "saveManualRelation": {
          await this.saveManualRelation(message.relation, message.originalKey);
          return;
        }
        case "removeManualRelation": {
          await this.removeManualRelation(message.key);
          return;
        }
        case "rebuildIndex": {
          const index = this.indexProvider();
          if (!index) {
            throw new Error("Workspace indexing is disabled in this workspace.");
          }
          const status = await index.rebuild();
          this.post({
            type: "actionResult",
            ok: true,
            message: `Index rebuilt: ${status.filesIndexed} file(s), ${status.relations.eligible} eligible relation(s).`,
          });
          this.postState();
          return;
        }
        case "openSettings":
          await vscode.commands.executeCommand("netezza.openSettings");
          return;
        default:
          return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      tryGetLogger()?.warn(`JOIN manager action failed: ${message}`);
      this.post({ type: "error", message });
    }
  }

  private async saveManualRelation(
    input: ManagerManualRelationInput,
    originalKey?: string,
  ): Promise<void> {
    const relation = manualRelationToSetting(input);
    if (!relation.left.table || !relation.right.table || relation.columns.length === 0) {
      throw new Error("A manual relation needs both tables and at least one `left=right` column pair.");
    }
    const canonical = canonicalizeRelation(relation, "netezza");
    if (!canonical) {
      throw new Error("The manual relation is invalid (same table on both sides or empty columns).");
    }
    const current = this.configuredRelations();
    const currentKeys = current.map((entry) => manualRelationKey(entry));
    const replaceIndex = originalKey
      ? currentKeys.indexOf(originalKey)
      : currentKeys.indexOf(canonical.key);
    const next = [...current];
    const before = replaceIndex >= 0 ? current[replaceIndex] : undefined;
    if (replaceIndex >= 0) {
      next[replaceIndex] = relation;
    } else {
      next.push(relation);
    }
    const detail = [
      before ? `Replace: ${JSON.stringify(before)}` : "Add a new manual relation",
      `With: ${JSON.stringify(manualRelationToSetting(input))}`,
      "Scope: workspace settings (justybase.sql.joinRelations).",
    ].join("\n");
    const choice = await vscode.window.showInformationMessage(
      "Apply manual JOIN relation change?",
      { modal: true, detail },
      "Apply",
    );
    if (choice !== "Apply") {
      this.post({ type: "actionResult", ok: false, message: "Manual relation change cancelled." });
      return;
    }
    this.lastManualUndo = current;
    await this.writeConfiguredRelations(next);
    this.post({
      type: "actionResult",
      ok: true,
      message: before ? "Manual relation replaced." : "Manual relation added.",
      undo: { kind: "manual", id: "manual", label: "Undo manual relation change" },
    });
    this.postState();
  }

  private async removeManualRelation(key: string): Promise<void> {
    const current = this.configuredRelations();
    const index = current.findIndex((entry) => manualRelationKey(entry) === key);
    if (index < 0) {
      throw new Error("The manual relation is no longer configured.");
    }
    const removed = current[index];
    const choice = await vscode.window.showWarningMessage(
      `Remove manual relation ${tableLabel(removed.left)} → ${tableLabel(removed.right)}?`,
      {
        modal: true,
        detail: "This edits justybase.sql.joinRelations at workspace scope. Observed evidence is untouched.",
      },
      "Remove",
    );
    if (choice !== "Remove") {
      this.post({ type: "actionResult", ok: false, message: "Manual relation removal cancelled." });
      return;
    }
    this.lastManualUndo = current;
    const next = current.filter((_, entryIndex) => entryIndex !== index);
    await this.writeConfiguredRelations(next);
    this.post({
      type: "actionResult",
      ok: true,
      message: "Manual relation removed.",
      undo: { kind: "manual", id: "manual", label: "Undo manual relation removal" },
    });
    this.postState();
  }

  private async writeConfiguredRelations(relations: readonly ConfiguredJoinRelation[]): Promise<void> {
    await vscode.workspace
      .getConfiguration("justybase.sql")
      .update("joinRelations", configuredSettingValue(relations), vscode.ConfigurationTarget.Workspace);
  }

  private html(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "joinKnowledge.css"),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "media", "joinKnowledge.js"),
    );
    const nonce = Array.from({ length: 24 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>JOIN Knowledge Manager</title>
</head>
<body>
  <div id="app" class="jk-app" data-state="loading">
    <header class="jk-header">
      <div>
        <h1>JOIN Knowledge</h1>
        <p class="jk-subtitle">Ranking sources, decisions and observed evidence</p>
      </div>
      <button id="refresh" class="jk-icon-button" title="Refresh" aria-label="Refresh">↻</button>
    </header>
    <div id="banner" class="jk-banner" hidden></div>
    <div class="jk-toolbar">
      <div role="tablist" aria-label="Knowledge domain" class="jk-tabs">
        <button role="tab" id="tab-relations" data-tab="relations" aria-selected="true">JOIN relations</button>
        <button role="tab" id="tab-objects" data-tab="objects" aria-selected="false">SQL objects</button>
      </div>
      <input id="search" type="search" placeholder="Filter by table, column or object" aria-label="Filter">
      <select id="filter" aria-label="Filter by source or status">
        <option value="all">All</option>
        <option value="confirmed">Confirmed</option>
        <option value="favorite">Favorite</option>
        <option value="blocked">Blocked</option>
        <option value="executed">Executed evidence</option>
        <option value="workspace">Workspace evidence</option>
        <option value="below">Below threshold</option>
        <option value="configured">Configured</option>
      </select>
    </div>
    <div id="status" class="jk-status" aria-live="polite"></div>
    <main class="jk-main">
      <section id="list" class="jk-list" aria-label="Knowledge entries"></section>
      <section id="detail" class="jk-detail" aria-label="Detail"></section>
    </main>
    <footer id="footer" class="jk-footer"></footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
