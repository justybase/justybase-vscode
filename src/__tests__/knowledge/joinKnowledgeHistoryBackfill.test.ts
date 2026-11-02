jest.unmock("chevrotain");
jest.mock("vscode");

import {
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  type JoinKnowledgeState,
} from "@justybase/sql-core/joinKnowledge";
import type { QueryHistoryEntry } from "../../core/history/types";
import { JoinKnowledgeExecutionCapture } from "../../knowledge/joinKnowledgeExecution";
import {
  backfillJoinKnowledgeFromHistory,
  formatHistoryBackfillResult,
  formatHistoryLearningMessage,
  learnedKnowledgeGain,
  toHistoryBackfillEntries,
} from "../../knowledge/joinKnowledgeHistoryBackfill";
import {
  JoinKnowledgeService,
  type JoinKnowledgePersistence,
} from "../../knowledge/joinKnowledgeService";

class MemoryPersistence implements JoinKnowledgePersistence {
  public saves = 0;
  public state: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };

  async load(): Promise<JoinKnowledgeState> {
    return this.state;
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    this.saves += 1;
    this.state = JSON.parse(JSON.stringify(state));
  }
}

const JOIN_SQL = "SELECT U.USER_ID FROM BAZA.ADMIN.USERS U "
  + "JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID WHERE U.NAME = 'secret-literal';";
const USERS_ORDERS_KEY = canonicalizeRelation(
  {
    left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
    right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
    columns: [{ left: "USER_ID", right: "OWNER_ID" }],
  },
  "netezza",
)!.key;

const day = (date: string): number => Date.parse(`${date}T09:00:00.000Z`);

function entry(id: string, date: string, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
  return {
    id,
    host: "secret-host",
    database: "BAZA",
    schema: "ADMIN",
    query: JOIN_SQL,
    timestamp: day(date),
    connectionName: "DEV",
    status: "success",
    ...overrides,
  };
}

function setup(options: { enabled?: boolean } = {}) {
  let clock = "2026-10-27T10:00:00.000Z";
  const persistence = new MemoryPersistence();
  const service = new JoinKnowledgeService(persistence, { now: () => clock });
  const capture = new JoinKnowledgeExecutionCapture({
    getService: () => service,
    isEnabled: () => options.enabled ?? true,
  });
  const run = (history: QueryHistoryEntry[]) => backfillJoinKnowledgeFromHistory({
    capture,
    loadHistory: async () => history,
    getConnectionDatabaseKind: (name) => (name === "DEV" ? "netezza" : name === "PG" ? "postgresql" : undefined),
  });
  return {
    service,
    capture,
    persistence,
    run,
    setClock: (iso: string) => {
      clock = iso;
    },
  };
}

describe("JOIN knowledge history backfill", () => {
  it("learns executed JOINs from successful history entries with their original days", async () => {
    const { service, run } = setup();
    await service.initialize();

    const result = await run([entry("b", "2026-10-02"), entry("a", "2026-10-01")]);

    expect(result).toMatchObject({ scanned: 2, eligible: 2, recorded: 2, duplicates: 0 });
    expect(buildJoinKnowledgeIndex(service.getSnapshot()).executedRelations.get(USERS_ORDERS_KEY)).toMatchObject({
      observations: 2,
      distinctDays: 2,
    });
    expect(service.getEarliestExecutedAt()).toBe("2026-10-01T09:00:00.000Z");
  });

  it("skips failed, cancelled, unknown-connection and other-dialect entries", async () => {
    const { service, run } = setup();
    await service.initialize();

    const result = await run([
      entry("ok", "2026-10-01"),
      entry("error", "2026-10-02", { status: "error" }),
      entry("cancelled", "2026-10-03", { status: "cancelled" }),
      entry("legacy-failed", "2026-10-04", { status: undefined, errorMessage: "boom" }),
      entry("gone", "2026-10-05", { connectionName: "REMOVED" }),
      entry("pg", "2026-10-06", { connectionName: "PG" }),
    ]);

    expect(result).toMatchObject({ scanned: 6, eligible: 3, recorded: 1 });
    expect(result?.skipped).toMatchObject({ "not-successful": 3, "unsupported-dialect": 2 });
  });

  it("adds nothing when run again and never double counts live-captured executions", async () => {
    const { service, capture, run, setClock } = setup();
    await service.initialize();

    // Live capture started on Oct 10; the same statement is also in history.
    setClock("2026-10-10T12:00:00.000Z");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "live-1:0" });
    const history = [
      entry("old", "2026-10-01"),
      entry("live-copy", "2026-10-10", { timestamp: Date.parse("2026-10-10T12:00:00.000Z") }),
    ];

    const first = await run(history);
    expect(first).toMatchObject({ eligible: 1, recorded: 1 });
    expect(first?.skipped["already-captured"]).toBe(1);

    const second = await run(history);
    expect(second).toMatchObject({ eligible: 0, recorded: 0 });

    const record = buildJoinKnowledgeIndex(service.getSnapshot()).executedRelations.get(USERS_ORDERS_KEY);
    expect(record).toMatchObject({ observations: 2, distinctDays: 2 });
  });

  it("keeps the seen range widening when older statements arrive after newer ones", async () => {
    const { service, capture, persistence, run, setClock } = setup();
    await service.initialize();
    setClock("2026-10-20T12:00:00.000Z");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "live-1:0" });

    await run([entry("old", "2026-10-01")]);

    const evidence = persistence.state.relationEvidence.find(
      (record) => record.relationKey === USERS_ORDERS_KEY && record.source === "executed",
    );
    expect(evidence).toMatchObject({
      firstSeenAt: "2026-10-01T09:00:00.000Z",
      lastSeenAt: "2026-10-20T12:00:00.000Z",
    });
  });

  it("writes state once per batch rather than once per statement", async () => {
    const { service, persistence, capture } = setup();
    await service.initialize();
    const entries = toHistoryBackfillEntries(
      Array.from({ length: 30 }, (_, index) => entry(`e${index}`, `2026-09-${String(index + 1).padStart(2, "0")}`)),
      () => "netezza",
    );
    const saves = persistence.saves;

    const result = await capture.backfillFromHistory(entries, { batchSize: 10 });

    expect(result.recorded).toBe(30);
    expect(persistence.saves - saves).toBe(3);
  });

  it("reports progress and resumes a cancelled run with the older entries", async () => {
    const { service, capture } = setup();
    await service.initialize();
    const entries = toHistoryBackfillEntries(
      Array.from({ length: 30 }, (_, index) => entry(`e${index}`, `2026-09-${String(index + 1).padStart(2, "0")}`)),
      () => "netezza",
    );
    const progress: Array<[number, number]> = [];
    let batches = 0;

    const first = await capture.backfillFromHistory(entries, {
      batchSize: 10,
      onProgress: (processed, total) => {
        progress.push([processed, total]);
        batches += 1;
      },
      isCancelled: () => batches >= 1,
    });
    expect(first).toMatchObject({ eligible: 30, recorded: 10, cancelled: true });
    expect(progress).toEqual([[10, 30]]);
    // The newest ten were learned first.
    expect(service.getEarliestExecutedAt()).toBe("2026-09-21T09:00:00.000Z");

    const second = await capture.backfillFromHistory(entries, { batchSize: 10 });
    expect(second).toMatchObject({ eligible: 20, recorded: 20 });
    expect(second.cancelled).toBeUndefined();
    expect(buildJoinKnowledgeIndex(service.getSnapshot()).executedRelations.get(USERS_ORDERS_KEY))
      .toMatchObject({ observations: 30, distinctDays: 30 });
  });

  it("tells the user what was learned in plain words", () => {
    const result = { scanned: 400, eligible: 349, recorded: 300, duplicates: 0, notDurable: 0, skipped: {} };
    expect(formatHistoryLearningMessage(result, learnedKnowledgeGain({ joins: 1, tables: 2 }, { joins: 13, tables: 36 })))
      .toBe("Learned from 349 past queries: 12 JOINs and 34 tables you use repeatedly now rank higher in suggestions.");
    expect(formatHistoryLearningMessage(result, { joins: 0, tables: 1 }))
      .toBe("Learned from 349 past queries: 1 table you use repeatedly now ranks higher in suggestions.");
    expect(formatHistoryLearningMessage(result, { joins: 0, tables: 0 }))
      .toBe("Checked 349 past queries; no JOINs or tables were used often enough to rank higher yet.");
    expect(formatHistoryLearningMessage({ ...result, eligible: 0 }, { joins: 0, tables: 0 }))
      .toBe("Your query history has nothing new to learn from.");
    expect(formatHistoryLearningMessage({ ...result, cancelled: true }, { joins: 0, tables: 0 }))
      .toContain("Stopped early; run it again to continue.");
  });

  it("does nothing while execution learning is off", async () => {
    const { service, run } = setup({ enabled: false });
    await service.initialize();

    const result = await run([entry("a", "2026-10-01")]);

    expect(result).toMatchObject({ recorded: 0, skipped: { disabled: 1 } });
    expect(service.getEarliestExecutedAt()).toBeUndefined();
  });

  it("keeps SQL text, literals, hosts and connection names out of state and the summary", async () => {
    const { service, persistence, run } = setup();
    await service.initialize();

    const result = await run([entry("a", "2026-10-01"), entry("b", "2026-10-02", { status: "error" })]);

    const persisted = JSON.stringify(persistence.state);
    const summary = formatHistoryBackfillResult(result!);
    for (const text of [persisted, summary]) {
      expect(text).not.toContain("secret-literal");
      expect(text).not.toContain("secret-host");
      expect(text).not.toContain("DEV");
      expect(text).not.toContain("SELECT");
    }
    expect(summary).toBe(
      "Query history: 2 scanned, 1 eligible, 1 learned, 0 duplicate; skipped: not-successful 1",
    );
  });
});
