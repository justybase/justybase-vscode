import { randomUUID } from "node:crypto";
import type { DatabaseKind } from "../contracts/database";
import type {
  ExecutedStatementCommandInput,
  ExecutedStatementRecordResult,
  JoinKnowledgeService,
} from "./joinKnowledgeService";
import { createWorkspaceFingerprint } from "./workspaceIndexEngine";
import { extractWorkspaceSql } from "./workspaceSqlExtractor";

/** Same per-file cap as the workspace index; larger statements are skipped, not truncated. */
export const EXECUTION_CAPTURE_MAX_SQL_BYTES = 2 * 1024 * 1024;

/**
 * Dialects whose executed statements may contribute evidence. The workspace
 * index parses with the Netezza grammar, so other dialects are not captured:
 * this keeps executed evidence from mixing with differently folded identities.
 */
const CAPTURED_DIALECTS: ReadonlySet<DatabaseKind> = new Set<DatabaseKind>(["netezza"]);

export interface SuccessfulStatementEvent {
  sql: string;
  /** Resolved by the caller from the connection that executed the statement. */
  databaseKind?: DatabaseKind;
  /**
   * Identity of one successful execution (`executionId:statementIndex`). The
   * same key delivered twice is counted once.
   */
  executionKey?: string;
}

export interface JoinKnowledgeExecutionCaptureOptions {
  getService: () => JoinKnowledgeService | undefined;
  /** `justybase.sql.learnFromExecutedQueries`; capture is off unless enabled. */
  isEnabled: () => boolean;
}

export interface JoinKnowledgeExecutionCounters {
  /** Successful statements that reached the capture step while capture was enabled. */
  observed: number;
  /** Executions that added evidence. */
  recorded: number;
  /** Repeated deliveries of an already counted execution. */
  duplicates: number;
  /** Evidence counted in memory whose state write failed. */
  notDurable: number;
  /** Skip counts by reason; no SQL, names or values. */
  skipped: Record<string, number>;
}

/** One successful statement from the extension's query history. */
export interface HistoryBackfillEntry {
  id: string;
  sql: string;
  /** Epoch milliseconds of the execution. */
  timestamp: number;
  databaseKind?: DatabaseKind;
  status?: "success" | "error" | "cancelled";
  /** Present on failed entries written before `status` existed. */
  failed?: boolean;
}

export interface HistoryBackfillResult {
  /** History entries offered to the backfill. */
  scanned: number;
  /** Entries old enough and successful, so parsed. */
  eligible: number;
  recorded: number;
  duplicates: number;
  notDurable: number;
  /** Skip counts by reason; no SQL, names or values. */
  skipped: Record<string, number>;
  /** Stopped before all eligible entries were processed; a later run resumes. */
  cancelled?: boolean;
}

export interface HistoryBackfillOptions {
  batchSize?: number;
  yieldBetweenBatches?: () => Promise<void>;
  /** Eligible entries processed so far, after each batch. */
  onProgress?: (processed: number, total: number) => void;
  /** Checked between batches. */
  isCancelled?: () => boolean;
}

function addCount(target: Record<string, number>, reason: string, count = 1): void {
  if (count > 0) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function historyEntrySkipReason(entry: HistoryBackfillEntry): string | undefined {
  if (entry.status === "error" || entry.status === "cancelled" || entry.failed) {
    return "not-successful";
  }
  if (!Number.isFinite(entry.timestamp) || entry.timestamp <= 0) {
    return "no-timestamp";
  }
  if (!entry.sql.trim()) {
    return "no-evidence";
  }
  return undefined;
}

/**
 * Records successful user statements as executed JOIN and object evidence.
 *
 * It runs only from the batch success hook, so cancelled and failed statements
 * never reach it. Diagnostics hold counters only.
 */
export class JoinKnowledgeExecutionCapture {
  private readonly fingerprint = createWorkspaceFingerprint(randomUUID());
  private readonly counters: JoinKnowledgeExecutionCounters = {
    observed: 0,
    recorded: 0,
    duplicates: 0,
    notDurable: 0,
    skipped: {},
  };

  constructor(private readonly options: JoinKnowledgeExecutionCaptureOptions) {}

  getCounters(): JoinKnowledgeExecutionCounters {
    return { ...this.counters, skipped: { ...this.counters.skipped } };
  }

  /** Never throws: a capture failure must not change the result of the execution. */
  async captureSuccessfulStatement(event: SuccessfulStatementEvent): Promise<void> {
    if (!this.options.isEnabled()) {
      return;
    }
    const service = this.options.getService();
    if (!service) {
      this.skip("no-service");
      return;
    }
    try {
      const input = this.toExecutedInput(event, this.counters.skipped, true);
      if (!input) {
        return;
      }
      const [result] = await service.recordExecutedStatements([input]);
      this.count(result, this.counters);
    } catch {
      // The message may echo SQL or identifiers, so only the reason is kept.
      this.skip("capture-error");
    }
  }

  /**
   * Learn from statements that ran before capture existed (the extension's
   * query history). Only entries older than the oldest executed evidence are
   * replayed: newer statements were already captured live, and anything
   * older that produced evidence is now the oldest record, so a repeated run
   * adds nothing. Entries are recorded oldest first, in batches with one
   * state write each. Never throws; counters only, no SQL.
   */
  async backfillFromHistory(
    entries: readonly HistoryBackfillEntry[],
    options: HistoryBackfillOptions = {},
  ): Promise<HistoryBackfillResult> {
    const result: HistoryBackfillResult = {
      scanned: entries.length,
      eligible: 0,
      recorded: 0,
      duplicates: 0,
      notDurable: 0,
      skipped: {},
    };
    if (!this.options.isEnabled()) {
      result.skipped.disabled = entries.length;
      return result;
    }
    const service = this.options.getService();
    if (!service) {
      result.skipped["no-service"] = entries.length;
      return result;
    }
    const before = service.getEarliestExecutedAt();
    const candidates: Array<{ entry: HistoryBackfillEntry; executedAt: string }> = [];
    for (const entry of entries) {
      const skip = historyEntrySkipReason(entry);
      if (skip) {
        addCount(result.skipped, skip);
        continue;
      }
      const executedAt = new Date(entry.timestamp).toISOString();
      if (before !== undefined && executedAt >= before) {
        addCount(result.skipped, "already-captured");
        continue;
      }
      candidates.push({ entry, executedAt });
    }
    // Newest first: an interrupted run leaves its oldest processed entry as
    // the earliest executed evidence, so the next run resumes with older ones.
    candidates.sort((left, right) => right.executedAt.localeCompare(left.executedAt));
    result.eligible = candidates.length;

    const batchSize = Math.max(1, options.batchSize ?? 50);
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      if (options.isCancelled?.()) {
        result.cancelled = true;
        break;
      }
      const inputs: ExecutedStatementCommandInput[] = [];
      for (const { entry, executedAt } of candidates.slice(offset, offset + batchSize)) {
        try {
          const input = this.toExecutedInput({
            sql: entry.sql,
            databaseKind: entry.databaseKind,
            executionKey: `history:${entry.id}`,
          }, result.skipped, false);
          if (input) {
            inputs.push({ ...input, executedAt });
          }
        } catch {
          addCount(result.skipped, "capture-error");
        }
      }
      if (inputs.length > 0) {
        try {
          for (const recorded of await service.recordExecutedStatements(inputs)) {
            this.count(recorded, result);
          }
        } catch {
          addCount(result.skipped, "capture-error", inputs.length);
        }
      }
      options.onProgress?.(Math.min(offset + batchSize, candidates.length), candidates.length);
      await options.yieldBetweenBatches?.();
    }
    return result;
  }

  /** Extract identifiers from one statement, or count why it has none. */
  private toExecutedInput(
    event: SuccessfulStatementEvent,
    skipped: Record<string, number>,
    live: boolean,
  ): ExecutedStatementCommandInput | undefined {
    const databaseKind = event.databaseKind;
    if (!databaseKind || !CAPTURED_DIALECTS.has(databaseKind)) {
      addCount(skipped, "unsupported-dialect");
      return undefined;
    }
    if (live) {
      this.counters.observed += 1;
    }
    if (Buffer.byteLength(event.sql, "utf8") > EXECUTION_CAPTURE_MAX_SQL_BYTES) {
      addCount(skipped, "too-large");
      return undefined;
    }
    const extraction = extractWorkspaceSql(event.sql, {
      databaseKind,
      fingerprint: this.fingerprint,
    });
    for (const [reason, count] of Object.entries(extraction.skipped)) {
      addCount(skipped, reason, count ?? 0);
    }
    const relations = extraction.relations.map((entry) => entry.relation);
    const objects = extraction.objects.map((entry) => ({ object: entry.object, kind: entry.kind }));
    const columns = extraction.columns.map((entry) => ({ object: entry.object, column: entry.column }));
    if (relations.length === 0 && objects.length === 0 && columns.length === 0) {
      addCount(skipped, "no-evidence");
      return undefined;
    }
    return {
      executionKey: event.executionKey ?? randomUUID(),
      databaseKind,
      relations,
      objects,
      columns,
    };
  }

  private count(
    result: ExecutedStatementRecordResult,
    target: Pick<JoinKnowledgeExecutionCounters, "recorded" | "duplicates" | "notDurable" | "skipped">,
  ): void {
    if (result.outcome === "duplicate") {
      target.duplicates += 1;
      return;
    }
    if (result.truncated) {
      addCount(target.skipped, "capacity");
    }
    if (result.outcome === "empty") {
      if (!result.truncated) {
        addCount(target.skipped, "no-evidence");
      }
      return;
    }
    target.recorded += 1;
    if (!result.persisted) {
      target.notDurable += 1;
    }
  }

  private skip(reason: string, count = 1): void {
    addCount(this.counters.skipped, reason, count);
  }

}
