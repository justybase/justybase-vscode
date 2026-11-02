/**
 * JOIN Knowledge manager (Stage 3) webview contracts.
 *
 * Rows are identifier/counter-only. SQL text, literals, hosts, connection
 * names and per-file fingerprints never cross this boundary.
 */

export type JoinKnowledgeManagerTab = "relations" | "objects";

export type RelationDecision = "confirmed" | "blocked" | "favorite" | "none";

export interface ManagerTableRef {
  database?: string;
  schema?: string;
  table: string;
}

export interface ManagerColumnPair {
  left: string;
  right: string;
}

export interface ManagerRelationSource {
  kind: "configured" | "confirmed" | "blocked" | "favorite" | "executed" | "workspace";
  label: string;
  detail?: string;
}

export interface ManagerExecutedRelationCounters {
  observations: number;
  distinctDays: number;
  belowThreshold: boolean;
}

export interface ManagerExecutedObjectCounters {
  usage: {
    select: number;
    insert: number;
    update: number;
    delete: number;
  };
  observations: number;
  distinctDays: number;
  band?: number;
  belowThreshold: boolean;
}

export interface ManagerRelationRow {
  key: string;
  /** Canonical display pair, e.g. `USERS → ORDERS`. */
  tables: string;
  /** Predicate summary, e.g. `USERS.USER_ID = ORDERS.OWNER_ID`. */
  predicate: string;
  left: ManagerTableRef;
  right: ManagerTableRef;
  columns: ManagerColumnPair[];
  decision: RelationDecision;
  favorite: boolean;
  scoreAdjustment: number;
  /** Ranking prefix, e.g. `0_5_`; `blocked` and `below` are explicit labels. */
  tier: string;
  rankLabel: string;
  sources: ManagerRelationSource[];
  explanation: string[];
  workspace?: {
    observations: number;
    distinctFiles: number;
    distinctQueries: number;
    acceptedSelections: number;
    weightedQueries: number;
    belowThreshold: boolean;
  };
  executed?: ManagerExecutedRelationCounters;
  configured: boolean;
  overrideIds: {
    confirm?: string;
    block?: string;
    favorite?: string;
    score?: string;
  };
  updatedAt?: string;
}

export interface ManagerObjectRow {
  key: string;
  label: string;
  database?: string;
  schema?: string;
  name: string;
  kind: "pin" | "boost" | "demote" | "exclude" | "neutral" | "learned";
  band?: number;
  pinOrder?: number;
  tier: string;
  rankLabel: string;
  explanation: string[];
  usage?: {
    select: number;
    insert: number;
    update: number;
    delete: number;
    distinctFiles: number;
    distinctQueries: number;
    belowThreshold: boolean;
  };
  executed?: ManagerExecutedObjectCounters;
  overrideId?: string;
  updatedAt?: string;
}

export interface ManagerMeta {
  indexingEnabled: boolean;
  personalizeEnabled: boolean;
  truncated: boolean;
  gitMode: string;
  filesIndexed: number;
  lastIndexedAt?: string;
  lastError?: string;
  configuredCount: number;
  counts: {
    relations: number;
    confirmed: number;
    blocked: number;
    favorites: number;
    objects: number;
    pinned: number;
    excluded: number;
  };
  /** Successful-execution evidence; counters only, never SQL or fingerprints. */
  execution?: {
    relations: number;
    relationsBelowThreshold: number;
    objects: number;
    objectsBelowThreshold: number;
    truncated: boolean;
    observed?: number;
    recorded?: number;
    duplicates?: number;
    notDurable?: number;
    skipped?: Record<string, number>;
  };
}

export interface ManagerState {
  tab: JoinKnowledgeManagerTab;
  relations: ManagerRelationRow[];
  objects: ManagerObjectRow[];
  meta: ManagerMeta;
}

export interface ManagerManualRelationInput {
  leftDatabase?: string;
  leftSchema?: string;
  rightDatabase?: string;
  rightSchema?: string;
  leftTable: string;
  rightTable: string;
  /** One `left=right` pair per line, as typed in the form. */
  columns: string;
}

export type ManagerWebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "relationAction"; action: "confirm" | "block" | "favorite"; key: string }
  | { type: "relationScoreAction"; action: "increase" | "decrease" | "reset"; key: string }
  | { type: "objectAction"; action: "pin" | "boost" | "demote" | "exclude"; key: string; band?: number; pinOrder?: number }
  | { type: "revert"; kind: "relation" | "object" | "manual"; id: string }
  | { type: "deleteEvidence"; kind: "relation" | "object"; key: string }
  | { type: "deleteAcceptedEvidence"; key: string }
  | { type: "clearExecutedEvidence"; kind: "relation" | "object"; key: string }
  | { type: "clearAllExecutedEvidence" }
  | { type: "bulk"; action: "exclude" | "deleteEvidence"; keys: string[] }
  | { type: "saveManualRelation"; originalKey?: string; relation: ManagerManualRelationInput }
  | { type: "removeManualRelation"; key: string }
  | { type: "rebuildIndex" }
  | { type: "openSettings" };

/** Tab and filter to show when the manager is opened for a purpose. */
export interface JoinKnowledgeManagerFocus {
  tab: JoinKnowledgeManagerTab;
  filter: string;
}

const MANAGER_FILTERS = new Set(["all", "confirmed", "favorite", "blocked", "executed", "workspace", "below", "configured"]);

export function readJoinKnowledgeManagerFocus(value: unknown): JoinKnowledgeManagerFocus | undefined {
  const candidate = value as Partial<JoinKnowledgeManagerFocus> | undefined;
  if (
    !candidate
    || (candidate.tab !== "relations" && candidate.tab !== "objects")
    || typeof candidate.filter !== "string"
    || !MANAGER_FILTERS.has(candidate.filter)
  ) {
    return undefined;
  }
  return { tab: candidate.tab, filter: candidate.filter };
}

export type ManagerHostMessage =
  | { type: "state"; state: ManagerState; focus?: JoinKnowledgeManagerFocus }
  | {
      type: "actionResult";
      ok: boolean;
      message: string;
      undo?: { kind: "relation" | "object" | "manual"; id: string; label: string };
    }
  | { type: "error"; message: string };
