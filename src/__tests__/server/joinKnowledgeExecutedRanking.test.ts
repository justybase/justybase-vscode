import {
  canonicalizeRelation,
  JoinKnowledgeStore,
  objectRefKey,
  type RelationInput,
} from "@justybase/sql-core/joinKnowledge";
import {
  __TEST_ONLY_resetJoinKnowledge,
  getObservedRelations,
  getWorkspaceObjectBand,
  setJoinKnowledgeSnapshot,
} from "../../server/joinKnowledgeRanking";

const usersOrders: RelationInput = {
  left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "OWNER_ID" }],
};

const orders = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };

/** Two successful executions on different days make the relation eligible. */
function executeTwice(store: JoinKnowledgeStore, kinds: Array<"select" | "insert"> = ["select"]) {
  const days = ["2026-10-25", "2026-10-26"];
  days.forEach((date, index) => {
    const relation = canonicalRelation();
    store.recordExecutedStatement({
      executionKey: `run-${index}`,
      databaseKind: "netezza",
      relations: [relation],
      objects: kinds.map((kind) => ({ object: orders, kind })),
      now: `${date}T10:00:00.000Z`,
    });
  });
}

function canonicalRelation() {
  const relation = canonicalizeRelation(usersOrders, "netezza");
  if (!relation) {
    throw new Error("invalid fixture relation");
  }
  return relation;
}

describe("language-server executed JOIN ranking", () => {
  beforeEach(() => __TEST_ONLY_resetJoinKnowledge());

  it("prefers executed evidence over workspace evidence for the same relation", () => {
    const store = new JoinKnowledgeStore();
    executeTwice(store);
    const key = canonicalRelation().key;
    setJoinKnowledgeSnapshot({
      ...store.buildSnapshot(),
      workspace: {
        version: 1,
        relations: [{
          key,
          relation: canonicalRelation(),
          observations: 3,
          distinctFiles: 3,
          distinctQueries: 3,
          belowThreshold: false,
          firstSeenAt: "2026-10-20T10:00:00.000Z",
          lastSeenAt: "2026-10-20T10:00:00.000Z",
        }],
        objects: [],
        truncated: false,
        generatedAt: "2026-10-27T10:00:00.000Z",
      },
    });

    const observed = getObservedRelations("netezza");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      key,
      source: "executed",
      // Executed owns the tier; the label also shows the merged workspace breadth.
      breadth: "2 execution(s), 2 day(s); 3 file(s)",
    });
  });

  it("falls back to workspace evidence when executed evidence is below threshold", () => {
    const store = new JoinKnowledgeStore();
    store.recordExecutedStatement({
      executionKey: "solo",
      databaseKind: "netezza",
      relations: [canonicalRelation()],
      objects: [],
      now: "2026-10-25T10:00:00.000Z",
    });
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    expect(getObservedRelations("netezza")).toEqual([]);
  });

  it("does not show Netezza execution evidence to another dialect", () => {
    const store = new JoinKnowledgeStore();
    executeTwice(store);
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    expect(getObservedRelations("netezza")).toHaveLength(1);
    expect(getObservedRelations("postgresql")).toEqual([]);
  });

  it("merges executed and workspace object bands by the better band, never by summing", () => {
    const store = new JoinKnowledgeStore();
    executeTwice(store, ["insert"]);
    const snapshot = store.buildSnapshot();
    const key = objectRefKey(orders);
    setJoinKnowledgeSnapshot({
      ...snapshot,
      workspace: {
        version: 1,
        relations: [],
        objects: [{
          key,
          object: orders,
          usage: { select: 3, insert: 0, update: 0, delete: 0 },
          distinctFiles: 4,
          distinctQueries: 8,
          belowThreshold: false,
          band: 10,
          firstSeenAt: "2026-10-20T10:00:00.000Z",
          lastSeenAt: "2026-10-20T10:00:00.000Z",
        }],
        truncated: false,
        generatedAt: "2026-10-27T10:00:00.000Z",
      },
    });

    // Workspace select usage keeps the best band; insert-only executed usage cannot beat it.
    expect(getWorkspaceObjectBand(orders, "netezza")).toBe(10);
  });

  it("uses executed object bands for Netezza only", () => {
    const store = new JoinKnowledgeStore();
    executeTwice(store, ["select"]);
    setJoinKnowledgeSnapshot(store.buildSnapshot());

    expect(getWorkspaceObjectBand(orders, "netezza")).toBeDefined();
    expect(getWorkspaceObjectBand(orders, "postgresql")).toBeUndefined();
  });
});
