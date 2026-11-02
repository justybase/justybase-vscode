import type { QueryHistoryEntry } from "../core/history/types";
import type { DatabaseKind } from "../contracts/database";
import type { JoinKnowledgeDiagnostics } from "@justybase/sql-core/joinKnowledge";
import type {
  HistoryBackfillEntry,
  HistoryBackfillOptions,
  HistoryBackfillResult,
  JoinKnowledgeExecutionCapture,
} from "./joinKnowledgeExecution";

/** Workspace-state flag: the automatic one-time backfill already ran here. */
export const HISTORY_BACKFILL_DONE_KEY = "justybase.joinKnowledge.historyBackfillDone";
/** Global-state flag: the user was told once that the history was learned from. */
export const HISTORY_LEARNING_ANNOUNCED_KEY = "justybase.joinKnowledge.historyLearningAnnounced";

/** JOINs and FROM sources that rank from executed evidence (above the threshold). */
export interface LearnedKnowledgeCounts {
  joins: number;
  tables: number;
}

export function learnedKnowledgeCounts(diagnostics: Pick<JoinKnowledgeDiagnostics, "executed">): LearnedKnowledgeCounts {
  return {
    joins: diagnostics.executed.relationsEligible,
    tables: diagnostics.executed.objectsEligible,
  };
}

/** What a history run added, never negative. */
export function learnedKnowledgeGain(
  before: LearnedKnowledgeCounts,
  after: LearnedKnowledgeCounts,
): LearnedKnowledgeCounts {
  return {
    joins: Math.max(0, after.joins - before.joins),
    tables: Math.max(0, after.tables - before.tables),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** User-facing outcome of learning from the query history; counts only. */
export function formatHistoryLearningMessage(
  result: HistoryBackfillResult,
  gain: LearnedKnowledgeCounts,
): string {
  const queries = plural(result.eligible, "past query", "past queries");
  const learned = [
    gain.joins > 0 ? plural(gain.joins, "JOIN", "JOINs") : "",
    gain.tables > 0 ? plural(gain.tables, "table", "tables") : "",
  ].filter(Boolean);
  const stopped = result.cancelled ? " Stopped early; run it again to continue." : "";
  if (learned.length === 0) {
    return result.eligible === 0
      ? `Your query history has nothing new to learn from.${stopped}`
      : `Checked ${queries}; no JOINs or tables were used often enough to rank higher yet.${stopped}`;
  }
  const verb = gain.joins + gain.tables === 1 ? "ranks" : "rank";
  return `Learned from ${queries}: ${learned.join(" and ")} you use repeatedly now ${verb} higher in suggestions.${stopped}`;
}

export interface HistoryBackfillDependencies {
  capture: JoinKnowledgeExecutionCapture | undefined;
  /** Active and archived history entries. */
  loadHistory: () => Promise<readonly QueryHistoryEntry[]>;
  getConnectionDatabaseKind: (connectionName?: string) => DatabaseKind | undefined;
}

/**
 * Map history entries to backfill input. The dialect comes from the saved
 * connection; an entry whose connection no longer exists has no dialect and
 * is skipped by the capture.
 */
export function toHistoryBackfillEntries(
  entries: readonly QueryHistoryEntry[],
  getConnectionDatabaseKind: HistoryBackfillDependencies["getConnectionDatabaseKind"],
): HistoryBackfillEntry[] {
  const kinds = new Map<string, DatabaseKind | undefined>();
  return entries.map((entry) => {
    const connectionName = entry.connectionName ?? "";
    if (!kinds.has(connectionName)) {
      kinds.set(
        connectionName,
        connectionName ? getConnectionDatabaseKind(connectionName) : undefined,
      );
    }
    return {
      id: entry.id,
      sql: entry.query ?? "",
      timestamp: entry.timestamp,
      databaseKind: kinds.get(connectionName),
      status: entry.status,
      failed: entry.status === undefined && Boolean(entry.errorMessage),
    };
  });
}

/** Replay the query history into executed evidence. Never throws. */
export async function backfillJoinKnowledgeFromHistory(
  dependencies: HistoryBackfillDependencies,
  options: Pick<HistoryBackfillOptions, "onProgress" | "isCancelled"> = {},
): Promise<HistoryBackfillResult | undefined> {
  if (!dependencies.capture) {
    return undefined;
  }
  let history: readonly QueryHistoryEntry[];
  try {
    history = await dependencies.loadHistory();
  } catch {
    return undefined;
  }
  return dependencies.capture.backfillFromHistory(
    toHistoryBackfillEntries(history, dependencies.getConnectionDatabaseKind),
    { ...options, yieldBetweenBatches: () => new Promise((resolve) => setImmediate(resolve)) },
  );
}

/** One line for notifications and logs; counters only. */
export function formatHistoryBackfillResult(result: HistoryBackfillResult): string {
  const skipped = Object.entries(result.skipped)
    .filter(([, count]) => count > 0)
    .sort((left, right) => left[0].localeCompare(right[0], "en"))
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return `Query history: ${result.scanned} scanned, ${result.eligible} eligible, `
    + `${result.recorded} learned, ${result.duplicates} duplicate`
    + `${result.notDurable ? `, ${result.notDurable} not saved` : ""}`
    + `; skipped: ${skipped || "none"}`;
}
