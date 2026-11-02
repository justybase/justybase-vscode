import {
  canonicalizeRelation,
  JoinKnowledgeStore,
  objectRefKey,
} from "@justybase/sql-core/joinKnowledge";
import {
  __TEST_ONLY_resetJoinKnowledge,
  applyJoinKnowledgeIndexDelta,
  getFavoriteRelations,
  getObjectPreference,
  getRelationDecision,
  getWorkspaceObjectBand,
  getWorkspaceRelations,
  hasObjectPreferences,
  hasWorkspaceObjectEvidence,
  isObjectPersonalizationEnabled,
  setJoinKnowledgeSnapshot,
} from "../../server/joinKnowledgeRanking";

const usersOrders = {
  left: { database: "BAZA", schema: "PUBLIC", table: "USERS" },
  right: { database: "BAZA", schema: "PUBLIC", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "ID" }],
};

describe("language-server JOIN knowledge ranking", () => {
  beforeEach(() => __TEST_ONLY_resetJoinKnowledge());

  it("publishes confirmed and blocked decisions with block precedence", () => {
    const store = new JoinKnowledgeStore();
    const confirmed = store.appendRelationOverride({
      kind: "confirm",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T10:00:00.000Z",
      id: "r1",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    expect(getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    )).toMatchObject({ decision: "confirmed" });

    store.appendRelationOverride({
      kind: "block",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T11:00:00.000Z",
      id: "r2",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    const blocked = getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    );
    expect(blocked.decision).toBe("blocked");
    expect(blocked.key).toBe(confirmed.relationKey);
  });

  it("keeps the completion path free of unknown relations", () => {
    setJoinKnowledgeSnapshot(undefined);
    expect(getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    )).toMatchObject({ decision: "none" });
  });

  it("normalizes object keys with effective defaults and respects the master switch", () => {
    const store = new JoinKnowledgeStore();
    store.appendObjectPreference({
      kind: "pin",
      object: { database: "BAZA", schema: "PUBLIC", name: "ORDERS" },
      pinOrder: 2,
      databaseKind: "postgresql",
      now: "2026-10-25T10:00:00.000Z",
      id: "o1",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot(), {
      personalizeFromObjects: true,
    });

    expect(getObjectPreference(
      { name: "orders" },
      "postgresql",
      { database: "baza", schema: "public" },
    )).toMatchObject({ kind: "pin", pinOrder: 2 });
    expect(hasObjectPreferences()).toBe(true);

    setJoinKnowledgeSnapshot(store.buildSnapshot(), {
      personalizeFromObjects: false,
    });
    expect(isObjectPersonalizationEnabled()).toBe(false);
    expect(getObjectPreference(
      { database: "BAZA", schema: "PUBLIC", name: "ORDERS" },
      "postgresql",
    )).toBeUndefined();
    expect(hasObjectPreferences()).toBe(false);
  });

  it("publishes favorites at the preference tier and removes them on block", () => {
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "favorite",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T10:00:00.000Z",
      id: "favorite-1",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    expect(getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    )).toMatchObject({ decision: "favorite" });
    expect([...getFavoriteRelations()]).toHaveLength(1);

    store.appendRelationOverride({
      kind: "block",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T11:00:00.000Z",
      id: "block-1",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot());
    expect(getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    )).toMatchObject({ decision: "blocked" });
    expect([...getFavoriteRelations()]).toHaveLength(0);
  });

  it("applies workspace upserts without touching manual decisions", () => {
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "confirm",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T10:00:00.000Z",
      id: "confirm-1",
    });
    const relation = canonicalizeRelation({
      left: { database: "BAZA", schema: "PUBLIC", table: "CUSTOMERS" },
      right: { database: "BAZA", schema: "PUBLIC", table: "ORDERS" },
      columns: [{ left: "CUSTOMER_ID", right: "ID" }],
    }, "postgresql")!;
    const object = { database: "baza", schema: "public", name: "orders" };
    setJoinKnowledgeSnapshot({
      ...store.buildSnapshot(),
      workspace: {
        version: 1,
        relations: [{
          key: relation.key,
          relation,
          observations: 2,
          distinctFiles: 2,
          distinctQueries: 2,
          belowThreshold: false,
          firstSeenAt: "2026-10-25T10:00:00.000Z",
          lastSeenAt: "2026-10-25T10:00:00.000Z",
        }],
        objects: [{
          key: objectRefKey(object),
          object,
          usage: { select: 3, insert: 0, update: 0, delete: 0 },
          distinctFiles: 3,
          distinctQueries: 6,
          belowThreshold: false,
          band: 10,
          firstSeenAt: "2026-10-25T10:00:00.000Z",
          lastSeenAt: "2026-10-25T10:00:00.000Z",
        }],
        truncated: false,
        generatedAt: "2026-10-25T10:00:00.000Z",
      },
    }, { personalizeFromObjects: true });

    expect([...getWorkspaceRelations()]).toHaveLength(1);
    expect(getWorkspaceObjectBand(object, "postgresql")).toBe(10);
    expect(hasWorkspaceObjectEvidence()).toBe(true);

    applyJoinKnowledgeIndexDelta({
      version: 1,
      relationsUpsert: [],
      relationsRemove: [relation.key],
      objectsUpsert: [],
      objectsRemove: [objectRefKey(object)],
    });
    expect([...getWorkspaceRelations()]).toHaveLength(0);
    expect(getWorkspaceObjectBand(object, "postgresql")).toBeUndefined();
    expect(getRelationDecision(
      usersOrders.left,
      usersOrders.right,
      usersOrders.columns,
      "postgresql",
    )).toMatchObject({ decision: "confirmed" });
  });

  it("does not leak SQL text through the snapshot payload", () => {
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "confirm",
      relation: usersOrders,
      databaseKind: "postgresql",
      now: "2026-10-25T10:00:00.000Z",
      id: "r1",
    });
    const payload = JSON.stringify(store.buildSnapshot());
    expect(payload).not.toContain("SELECT");
    expect(payload).not.toContain("password");
    expect(payload).not.toContain("host");
  });
});
