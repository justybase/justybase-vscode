jest.unmock("chevrotain");
jest.mock("vscode");

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  type JoinKnowledgeState,
} from "@justybase/sql-core/joinKnowledge";
import {
  EXECUTION_CAPTURE_MAX_SQL_BYTES,
  JoinKnowledgeExecutionCapture,
} from "../../knowledge/joinKnowledgeExecution";
import { FileJoinKnowledgePersistence } from "../../knowledge/joinKnowledgeFilePersistence";
import {
  JoinKnowledgeService,
  type JoinKnowledgePersistence,
} from "../../knowledge/joinKnowledgeService";

class MemoryPersistence implements JoinKnowledgePersistence {
  public state: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };
  public failSave = false;

  async load(): Promise<JoinKnowledgeState> {
    return this.state;
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    if (this.failSave) {
      throw new Error("disk full at /secret/path");
    }
    this.state = JSON.parse(JSON.stringify(state));
  }
}

const JOIN_SQL = "SELECT U.USER_ID FROM BAZA.ADMIN.USERS U "
  + "JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID;";
const USERS_ORDERS_KEY = canonicalizeRelation(
  {
    left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
    right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
    columns: [{ left: "USER_ID", right: "OWNER_ID" }],
  },
  "netezza",
)!.key;

function setup(options: { enabled?: boolean; persistence?: JoinKnowledgePersistence } = {}) {
  let clock = "2026-10-25T10:00:00.000Z";
  const persistence = options.persistence ?? new MemoryPersistence();
  const service = new JoinKnowledgeService(persistence, { now: () => clock });
  const capture = new JoinKnowledgeExecutionCapture({
    getService: () => service,
    isEnabled: () => options.enabled ?? true,
  });
  return {
    service,
    capture,
    persistence,
    setDay: (date: string) => {
      clock = `${date}T10:00:00.000Z`;
    },
  };
}

describe("JoinKnowledgeExecutionCapture", () => {
  it("counts a successful netezza join only after two executions", async () => {
    const { service, capture, setDay } = setup();
    await service.initialize();

    setDay("2026-10-24");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "run-1:0" });
    expect(buildJoinKnowledgeIndex(service.getSnapshot()).executedRelations.size).toBe(0);

    setDay("2026-10-25");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "run-2:0" });

    const snapshot = service.getSnapshot();
    expect(buildJoinKnowledgeIndex(snapshot).executedRelations.get(USERS_ORDERS_KEY)).toMatchObject({
      observations: 2,
      distinctDays: 2,
    });
    expect(capture.getCounters()).toMatchObject({ observed: 2, recorded: 2, duplicates: 0, notDurable: 0 });
  });

  it("counts a repeated delivery of the same execution once", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "same:0" });
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "same:0" });

    expect(service.getDiagnostics().executed.relationsBelowThreshold).toBe(1);
    expect(capture.getCounters()).toMatchObject({ recorded: 1, duplicates: 1 });
  });

  it("records nothing while the workspace index switch is off", async () => {
    const { service, capture } = setup({ enabled: false });
    await service.initialize();

    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "off:0" });

    expect(service.getRelationEvidence()).toHaveLength(0);
    expect(capture.getCounters().observed).toBe(0);
  });

  it("skips dialects that are not captured, without recording evidence", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "sqlite", executionKey: "sqlite:0" });
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, executionKey: "unknown:0" });

    expect(service.getRelationEvidence()).toHaveLength(0);
    expect(capture.getCounters().skipped).toEqual({ "unsupported-dialect": 2 });
  });

  it("does not treat DDL as a data source", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({
      sql: "CREATE TABLE BAZA.ADMIN.AUDIT AS SELECT * FROM BAZA.ADMIN.USERS;",
      databaseKind: "netezza",
      executionKey: "ddl:0",
    });

    expect(service.getRelationEvidence()).toHaveLength(0);
    expect(capture.getCounters().recorded).toBe(0);
  });

  it("counts an INSERT target as its own usage and never as a SELECT source", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({
      sql: "INSERT INTO BAZA.ADMIN.ORDERS SELECT U.USER_ID FROM BAZA.ADMIN.USERS U;",
      databaseKind: "netezza",
      executionKey: "insert:0",
    });

    const objects = service.getSnapshot().executed?.objects ?? [];
    const orders = objects.find((entry) => entry.object.name === "ORDERS");
    const users = objects.find((entry) => entry.object.name === "USERS");
    expect(orders?.usage).toEqual({ select: 0, insert: 1, update: 0, delete: 0 });
    expect(users?.usage.select).toBe(1);
  });

  it("reports a failed state write as not durable while keeping the count in memory", async () => {
    const persistence = new MemoryPersistence();
    const { service, capture, setDay } = setup({ persistence });
    await service.initialize();
    persistence.failSave = true;

    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "io:0" });

    expect(capture.getCounters()).toMatchObject({ recorded: 1, notDurable: 1 });
    expect(service.getDiagnostics().executed.relationsBelowThreshold).toBe(1);

    persistence.failSave = false;
    setDay("2026-10-26");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "io:1" });
    expect(capture.getCounters().notDurable).toBe(1);
    expect(persistence.state.relationEvidence[0]).toMatchObject({ observations: 2, distinctDays: 2 });
  });

  it("never throws into the execution and reports only the reason", async () => {
    const capture = new JoinKnowledgeExecutionCapture({
      getService: () => ({
        recordExecutedStatement: jest.fn().mockRejectedValue(new Error("BAZA.ADMIN.SECRET leaked")),
      }) as unknown as JoinKnowledgeService,
      isEnabled: () => true,
    });

    await expect(capture.captureSuccessfulStatement({
      sql: JOIN_SQL,
      databaseKind: "netezza",
      executionKey: "boom:0",
    })).resolves.toBeUndefined();
    expect(capture.getCounters().skipped).toEqual({ "capture-error": 1 });
    expect(JSON.stringify(capture.getCounters())).not.toContain("SECRET");
  });

  it("skips statements above the per-statement byte cap", async () => {
    const { service, capture } = setup();
    await service.initialize();
    const oversized = `SELECT 1 /*${"x".repeat(EXECUTION_CAPTURE_MAX_SQL_BYTES)}*/`;

    await capture.captureSuccessfulStatement({ sql: oversized, databaseKind: "netezza", executionKey: "big:0" });

    expect(capture.getCounters().skipped).toEqual({ "too-large": 1 });
    expect(service.getRelationEvidence()).toHaveLength(0);
  });

  it("keeps SQL text, literals and connection names out of persisted state and diagnostics", async () => {
    const persistence = new MemoryPersistence();
    const { service, capture } = setup({ persistence });
    await service.initialize();
    const sql = "SELECT U.USER_ID FROM BAZA.ADMIN.USERS U "
      + "JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID WHERE U.NAME = 'PII-LITERAL-9911';";

    await capture.captureSuccessfulStatement({ sql, databaseKind: "netezza", executionKey: "priv:0" });

    const serialized = JSON.stringify({
      state: persistence.state,
      snapshot: service.getSnapshot(),
      counters: capture.getCounters(),
    });
    expect(serialized).not.toContain("PII-LITERAL-9911");
    expect(serialized).not.toContain("WHERE");
    expect(serialized).not.toContain("PROD-HOST-01");
  });

  it("survives a restart and keeps counting on a new day", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-execution-capture-"));
    try {
      const first = setup({ persistence: new FileJoinKnowledgePersistence(directory) });
      await first.service.initialize();
      first.setDay("2026-10-25");
      await first.capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "r1:0" });

      const restarted = setup({ persistence: new FileJoinKnowledgePersistence(directory) });
      await restarted.service.initialize();
      expect(restarted.service.getRelationEvidence()[0]).toMatchObject({
        observations: 1,
        belowThreshold: true,
      });

      restarted.setDay("2026-10-26");
      await restarted.capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "r2:0" });

      expect(buildJoinKnowledgeIndex(restarted.service.getSnapshot()).executedRelations.get(USERS_ORDERS_KEY))
        .toMatchObject({ observations: 2, distinctDays: 2 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("clears executed evidence without touching manual decisions", async () => {
    const { service, capture, setDay } = setup();
    await service.initialize();
    await service.confirmRelation({
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      databaseKind: "netezza",
    });
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "c1:0" });
    setDay("2026-10-26");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "c2:0" });

    await expect(service.clearExecutedEvidence()).resolves.toEqual({ relations: 1, objects: 1, columns: 2 });

    expect(service.getRelationOverrides().filter((entry) => !entry.revertedAt)).toHaveLength(1);
    expect(service.getSnapshot().executed).toBeUndefined();
    expect(service.getDiagnostics().relationOverrides.confirmed).toBe(1);
  });

  it("rejects the same execution event after a restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-execution-restart-"));
    try {
      const first = setup({ persistence: new FileJoinKnowledgePersistence(directory) });
      await first.service.initialize();
      first.setDay("2026-10-25");
      await first.capture.captureSuccessfulStatement({
        sql: JOIN_SQL,
        databaseKind: "netezza",
        executionKey: "same-event:0",
      });

      const restarted = setup({ persistence: new FileJoinKnowledgePersistence(directory) });
      await restarted.service.initialize();
      restarted.setDay("2026-10-26");
      await restarted.capture.captureSuccessfulStatement({
        sql: JOIN_SQL,
        databaseKind: "netezza",
        executionKey: "same-event:0",
      });

      expect(restarted.service.getRelationEvidence()[0]).toMatchObject({
        observations: 1,
        distinctDays: 1,
        belowThreshold: true,
      });
      expect(restarted.capture.getCounters()).toMatchObject({ recorded: 0, duplicates: 1 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("records each statement in a multi-statement execution separately", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({
      sql: "SELECT U.USER_ID FROM BAZA.ADMIN.USERS U JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID;",
      databaseKind: "netezza",
      executionKey: "multi:0",
    });
    await capture.captureSuccessfulStatement({
      sql: "SELECT P.PRODUCT_ID FROM BAZA.ADMIN.PRODUCTS P JOIN BAZA.ADMIN.ORDERS O2 ON P.PRODUCT_ID = O2.PRODUCT_ID;",
      databaseKind: "netezza",
      executionKey: "multi:1",
    });

    const relations = service.getSnapshot().executed?.relations ?? [];
    expect(relations).toHaveLength(2);
    expect(relations.map((entry) => entry.relationKey)).toEqual(
      expect.arrayContaining([USERS_ORDERS_KEY]),
    );
    const objects = service.getSnapshot().executed?.objects ?? [];
    // FROM sources only: USERS and PRODUCTS; the joined ORDERS is not a source.
    expect(objects.map((entry) => entry.object.name).sort()).toEqual(["PRODUCTS", "USERS"]);
  });

  it("skips ambiguous joins and parse errors with explicit reasons", async () => {
    const { service, capture } = setup();
    await service.initialize();

    await capture.captureSuccessfulStatement({
      sql: "SELECT * FROM BAZA.ADMIN.USERS U JOIN BAZA.ADMIN.ORDERS O USING (USER_ID);",
      databaseKind: "netezza",
      executionKey: "using:0",
    });
    await capture.captureSuccessfulStatement({
      sql: "SELECT * FROM BAZA.ADMIN.USERS U JOIN BAZA.ADMIN.ORDERS O ON U.USER_ID = O.OWNER_ID OR U.USER_ID = O.PRODUCT_ID;",
      databaseKind: "netezza",
      executionKey: "or:0",
    });
    await capture.captureSuccessfulStatement({
      sql: "SELECT * FROM BROKEN WHERE",
      databaseKind: "netezza",
      executionKey: "broken:0",
    });

    expect(service.getRelationEvidence()).toHaveLength(0);
    expect(capture.getCounters().skipped).toMatchObject({
      using: 1,
      or: 1,
      "parse-error": 1,
    });
  });

  it("keeps executed evidence when the workspace snapshot or branch evidence changes", async () => {
    const { service, capture, setDay } = setup();
    await service.initialize();
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "w1:0" });
    setDay("2026-10-26");
    await capture.captureSuccessfulStatement({ sql: JOIN_SQL, databaseKind: "netezza", executionKey: "w2:0" });

    const workspace = {
      version: 1 as const,
      relations: [],
      objects: [],
      truncated: false,
      generatedAt: "2026-10-26T10:00:00.000Z",
    };
    expect(service.getSnapshot(workspace).executed?.relations).toHaveLength(1);
    expect(service.getSnapshot({ ...workspace, generatedAt: "2026-10-27T10:00:00.000Z" })
      .executed?.relations).toHaveLength(1);
  });

  it("isolates executed evidence between workspace storage roots", async () => {
    const firstDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-exec-a-"));
    const secondDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-exec-b-"));
    try {
      const first = setup({ persistence: new FileJoinKnowledgePersistence(firstDirectory) });
      await first.service.initialize();
      await first.capture.captureSuccessfulStatement({
        sql: JOIN_SQL,
        databaseKind: "netezza",
        executionKey: "iso:0",
      });

      const second = setup({ persistence: new FileJoinKnowledgePersistence(secondDirectory) });
      await second.service.initialize();
      expect(second.service.getRelationEvidence()).toHaveLength(0);
      expect(second.service.getSnapshot().executed).toBeUndefined();
    } finally {
      await fs.rm(firstDirectory, { recursive: true, force: true });
      await fs.rm(secondDirectory, { recursive: true, force: true });
    }
  });
});
