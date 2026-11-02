import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JoinKnowledgeStore } from "@justybase/sql-core/joinKnowledge";
import { FileJoinKnowledgePersistence } from "../../knowledge/joinKnowledgeFilePersistence";

describe("FileJoinKnowledgePersistence", () => {
  let directory: string;
  let persistence: FileJoinKnowledgePersistence;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-join-knowledge-"));
    persistence = new FileJoinKnowledgePersistence(directory);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("round-trips relation decisions and object preferences", async () => {
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "confirm",
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now: "2026-10-25T10:00:00.000Z",
      id: "r1",
    });
    store.appendObjectPreference({
      kind: "pin",
      object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
      pinOrder: 1,
      databaseKind: "netezza",
      now: "2026-10-25T10:00:00.000Z",
      id: "o1",
    });
    const relation = store.getRelationOverrides()[0].relation;
    store.appendRelationScoreOverride({
      relation: relation.display,
      databaseKind: "netezza",
      adjustment: 2,
      now: "2026-10-25T10:00:00.000Z",
      id: "score-1",
    });
    store.upsertRelationEvidence({
      relationKey: relation.key,
      relation,
      source: "accepted",
      observations: 2,
      distinctDays: 1,
      distinctQueries: 0,
      firstSeenAt: "2026-10-25T10:00:00.000Z",
      lastSeenAt: "2026-10-25T10:00:00.000Z",
      belowThreshold: true,
    });
    await persistence.save(store.getState("2026-10-25T10:00:00.000Z"));

    const loaded = await persistence.load();
    expect(loaded.relationOverrides).toHaveLength(1);
    expect(loaded.objectOverrides).toHaveLength(1);
    expect(loaded.relationScoreOverrides).toMatchObject([
      { id: "score-1", adjustment: 2 },
    ]);
    expect(loaded.relationEvidence).toMatchObject([
      { relationKey: relation.key, source: "accepted", observations: 2 },
    ]);
    expect(loaded.relationOverrides[0].relationKey).toBe(
      store.buildSnapshot().relations[0].key,
    );
    expect(loaded.objectOverrides[0].object).toEqual({
      database: "BAZA",
      schema: "ADMIN",
      name: "ORDERS",
    });
  });

  it("round-trips non-Netezza scores and accepted evidence through the real files", async () => {
    const store = new JoinKnowledgeStore();
    const relationInput = {
      left: { database: "BAZA", schema: "public", table: "users" },
      right: { database: "BAZA", schema: "public", table: "orders" },
      columns: [{ left: "owner_id", right: "id" }],
    };
    const score = store.appendRelationScoreOverride({
      relation: relationInput,
      databaseKind: "postgresql",
      adjustment: 3,
      now: "2026-10-25T10:00:00.000Z",
      id: "score-pg",
    });
    const relation = score.relation;
    store.upsertRelationEvidence({
      relationKey: relation.key,
      relation,
      databaseKind: "postgresql",
      source: "accepted",
      observations: 6,
      distinctDays: 1,
      distinctQueries: 0,
      firstSeenAt: "2026-10-25T10:00:00.000Z",
      lastSeenAt: "2026-10-25T10:00:00.000Z",
      belowThreshold: false,
    });
    await persistence.save(store.getState("2026-10-25T10:00:00.000Z"));

    const loaded = await persistence.load();
    expect(loaded.relationScoreOverrides).toMatchObject([
      { id: "score-pg", relationKey: relation.key, adjustment: 3 },
    ]);
    expect(loaded.relationEvidence).toMatchObject([
      { relationKey: relation.key, source: "accepted", observations: 6 },
    ]);
  });

  it("ignores corrupt files and unknown versions without throwing", async () => {
    await fs.writeFile(path.join(directory, "overrides.json"), "{not json", "utf8");
    await fs.writeFile(
      path.join(directory, "object-overrides.json"),
      JSON.stringify({ version: 99, objectOverrides: [{ id: "x" }] }),
      "utf8",
    );

    const corrupt = await persistence.load();
    expect(corrupt.relationOverrides).toEqual([]);
    expect(corrupt.objectOverrides).toEqual([]);

    await fs.writeFile(path.join(directory, "overrides.json"), JSON.stringify({ version: 2 }), "utf8");
    const loaded = await persistence.load();
    expect(loaded.relationOverrides).toEqual([]);
    expect(loaded.objectOverrides).toEqual([]);
  });

  it("writes identifiers only, never SQL or literals", async () => {
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "confirm",
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now: "2026-10-25T10:00:00.000Z",
      id: "r1",
    });
    await persistence.save(store.getState("2026-10-25T10:00:00.000Z"));

    const payload = [
      await fs.readFile(path.join(directory, "overrides.json"), "utf8"),
      await fs.readFile(path.join(directory, "object-overrides.json"), "utf8"),
    ].join("\n");
    expect(payload).not.toContain("SELECT");
    expect(payload).not.toContain("hunter2");
    expect(payload).not.toContain("host");
  });

  it("keeps separate workspace directories isolated", async () => {
    const otherDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "justybase-join-knowledge-other-"),
    );
    try {
      const other = new FileJoinKnowledgePersistence(otherDirectory);
      const store = new JoinKnowledgeStore();
      store.appendRelationOverride({
        kind: "confirm",
        relation: {
          left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
          right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
          columns: [{ left: "USER_ID", right: "OWNER_ID" }],
        },
        databaseKind: "netezza",
        now: "2026-10-25T10:00:00.000Z",
        id: "r1",
      });
      await persistence.save(store.getState("2026-10-25T10:00:00.000Z"));

      expect((await other.load()).relationOverrides).toEqual([]);
      expect((await persistence.load()).relationOverrides).toHaveLength(1);
    } finally {
      await fs.rm(otherDirectory, { recursive: true, force: true });
    }
  });
});
