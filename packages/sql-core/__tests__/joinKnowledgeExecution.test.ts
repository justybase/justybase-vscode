import {
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  executedObjectBandForUsage,
  JOIN_TARGET_TIERS,
  JoinKnowledgeStore,
  mergeJoinKnowledgeIndexDelta,
  objectRefKey,
  OBJECT_BANDS,
  OBJECT_RANKING_MODEL,
  parseJoinKnowledgeState,
  resolveJoinTargetTier,
  type JoinKnowledgeSnapshot,
  type ObjectRef,
  type RelationIdentity,
  type RelationInput,
} from "../src/joinKnowledge";

const usersOrders: RelationInput = {
  left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "OWNER_ID" }],
};

const ordersUsersReversed: RelationInput = {
  left: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  columns: [{ left: "OWNER_ID", right: "USER_ID" }],
};

const products: RelationInput = {
  left: { database: "BAZA", schema: "ADMIN", table: "PRODUCTS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "ID", right: "PRODUCT_ID" }],
};

function identity(input: RelationInput): RelationIdentity {
  const relation = canonicalizeRelation(input, "netezza");
  if (!relation) {
    throw new Error("invalid test relation");
  }
  return relation;
}

const orders: ObjectRef = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };

function day(date: string): string {
  return `${date}T10:00:00.000Z`;
}

/** Records one successful execution of `relations` and `objects`. */
function execute(
  store: JoinKnowledgeStore,
  key: string,
  at: string,
  relations: RelationInput[] = [usersOrders],
  objects: Array<{ object: ObjectRef; kind: "select" | "insert" | "update" | "delete" }> = [
    { object: orders, kind: "select" },
  ],
) {
  return store.recordExecutedStatement({
    executionKey: key,
    databaseKind: "netezza",
    relations: relations.map(identity),
    objects,
    now: at,
  });
}

describe("executed evidence (0_4_)", () => {
  it("keeps a single successful execution below threshold and out of the index", () => {
    const store = new JoinKnowledgeStore();
    expect(execute(store, "e1", day("2026-10-25"))).toBe("recorded");

    const [record] = store.getExecutedRelationEvidence();
    expect(record).toMatchObject({ observations: 1, distinctDays: 1, belowThreshold: true });
    expect(buildJoinKnowledgeIndex(store.buildSnapshot()).executedRelations.size).toBe(0);
    expect(store.describe().executed.relationsBelowThreshold).toBe(1);
  });

  it("makes a relation eligible after two executions on one day", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "e1", day("2026-10-25"));
    execute(store, "e2", day("2026-10-25"));

    const [record] = store.getExecutedRelationEvidence();
    expect(record).toMatchObject({ observations: 2, distinctDays: 1, belowThreshold: false });
    const index = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(index.executedRelations.get(identity(usersOrders).key)).toBeDefined();
  });

  it("counts distinct UTC days, so one execution per day is also eligible", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "e1", day("2026-10-24"));
    execute(store, "e2", day("2026-10-25"));

    const [record] = store.getExecutedRelationEvidence();
    expect(record).toMatchObject({ observations: 2, distinctDays: 2, belowThreshold: false });
  });

  it("ignores a repeated delivery of the same execution key", () => {
    const store = new JoinKnowledgeStore();
    expect(execute(store, "same", day("2026-10-25"))).toBe("recorded");
    expect(execute(store, "same", day("2026-10-25"))).toBe("duplicate");
    expect(execute(store, "same", day("2026-10-26"))).toBe("duplicate");

    const [record] = store.getExecutedRelationEvidence();
    expect(record).toMatchObject({ observations: 1, distinctDays: 1, belowThreshold: true });
    expect(store.getExecutedObjectEvidence()[0].usage.select).toBe(1);
  });

  it("does not forget execution keys after clearing executed evidence", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "once", day("2026-10-25"));
    store.clearExecutedEvidence();

    expect(execute(store, "once", day("2026-10-25"))).toBe("duplicate");
    expect(store.getExecutedRelationEvidence()).toHaveLength(0);
  });

  it("counts a relation once per execution even when the input repeats it", () => {
    const store = new JoinKnowledgeStore();
    store.recordExecutedStatement({
      executionKey: "dup-input",
      databaseKind: "netezza",
      relations: [identity(usersOrders), identity(ordersUsersReversed)],
      objects: [],
      now: day("2026-10-25"),
    });

    expect(store.getExecutedRelationEvidence()[0].observations).toBe(1);
  });

  it("reports an empty statement without writing evidence", () => {
    const store = new JoinKnowledgeStore();
    expect(store.recordExecutedStatement({
      executionKey: "empty",
      databaseKind: "netezza",
      relations: [],
      objects: [],
      now: day("2026-10-25"),
    })).toBe("empty");
    expect(store.getState().relationEvidence).toHaveLength(0);
  });

  it("canonicalizes both JOIN directions to one executed record", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "forward", day("2026-10-25"), [usersOrders]);
    execute(store, "reverse", day("2026-10-26"), [ordersUsersReversed]);

    const records = store.getExecutedRelationEvidence();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ observations: 2, distinctDays: 2, belowThreshold: false });
  });

  it("keeps composite relations as one identity regardless of AND order", () => {
    const composite: RelationInput = {
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [
        { left: "USER_ID", right: "OWNER_ID" },
        { left: "TENANT_ID", right: "TENANT_KEY" },
      ],
    };
    const permuted: RelationInput = {
      ...composite,
      columns: [...composite.columns].reverse(),
    };
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"), [composite]);
    execute(store, "b", day("2026-10-26"), [permuted]);

    expect(store.getExecutedRelationEvidence()).toHaveLength(1);
    expect(store.getExecutedRelationEvidence()[0].observations).toBe(2);
  });

  it("keeps separate relations separate", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"), [usersOrders, products]);
    execute(store, "b", day("2026-10-26"), [usersOrders]);

    const byKey = new Map(store.getExecutedRelationEvidence().map((entry) => [entry.relationKey, entry]));
    expect(byKey.get(identity(usersOrders).key)?.observations).toBe(2);
    expect(byKey.get(identity(products).key)?.observations).toBe(1);
  });

  it("counts object usage per kind and never sums usage across kinds", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "sel", day("2026-10-25"), [usersOrders], [{ object: orders, kind: "select" }]);
    execute(store, "ins", day("2026-10-26"), [usersOrders], [{ object: orders, kind: "insert" }]);

    const [record] = store.getExecutedObjectEvidence();
    expect(record.usage).toEqual({ select: 1, insert: 1, update: 0, delete: 0 });
    expect(record).toMatchObject({ observations: 2, distinctDays: 2 });
  });
});

describe("executed object bands", () => {
  it("is unavailable below the executed threshold", () => {
    expect(executedObjectBandForUsage({ select: 1 }, 1, 1)).toBeUndefined();
  });

  it("keeps the select band inside the learned range and reaches its cap with broad use", () => {
    const broad = executedObjectBandForUsage({ select: 32 }, 32, 16);
    expect(broad).toBe(OBJECT_RANKING_MODEL.bestBandCaps.select);
    const narrow = executedObjectBandForUsage({ select: 2 }, 2, 1);
    expect(narrow).toBeGreaterThan(OBJECT_BANDS.learnedMin);
    expect(narrow).toBeLessThanOrEqual(OBJECT_BANDS.learnedMax);
  });

  it("never lets insert-only or delete-only usage reach the select band", () => {
    const insertOnly = executedObjectBandForUsage({ insert: 9 }, 9, 5);
    const deleteOnly = executedObjectBandForUsage({ delete: 9 }, 9, 5);
    expect(insertOnly).toBeGreaterThanOrEqual(OBJECT_RANKING_MODEL.bestBandCaps.insert);
    expect(deleteOnly).toBeGreaterThanOrEqual(OBJECT_RANKING_MODEL.bestBandCaps.delete);
  });

  it("publishes an eligible executed band and never a below-threshold one", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"), [usersOrders], [{ object: orders, kind: "select" }]);
    const single = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(single.executedObjectBands.size).toBe(0);

    execute(store, "b", day("2026-10-26"), [usersOrders], [{ object: orders, kind: "select" }]);
    const index = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(index.executedObjectBands.get(objectRefKey(orders))).toBeDefined();
    expect(index.hasObjectPreferences).toBe(true);
  });
});

describe("executed evidence in the index", () => {
  it("excludes blocked and confirmed relations from executed ranking", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"));
    execute(store, "b", day("2026-10-26"));
    store.appendRelationOverride({
      kind: "block",
      relation: usersOrders,
      databaseKind: "netezza",
      now: day("2026-10-27"),
      id: "block-1",
    });
    expect(buildJoinKnowledgeIndex(store.buildSnapshot()).executedRelations.size).toBe(0);
  });

  it("does not let an executed record override the manual block after restart", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"));
    execute(store, "b", day("2026-10-26"));
    store.appendRelationOverride({
      kind: "block",
      relation: usersOrders,
      databaseKind: "netezza",
      now: day("2026-10-27"),
      id: "block-1",
    });
    const restored = JoinKnowledgeStore.fromState(
      JSON.parse(JSON.stringify(store.getState())),
      "netezza",
    );
    const index = buildJoinKnowledgeIndex(restored.buildSnapshot());
    expect(index.blockedRelations.has(identity(usersOrders).key)).toBe(true);
    expect(index.executedRelations.size).toBe(0);
  });

  it("ranks executed evidence at 0_4_, above workspace 0_5_ and below catalog FK 0_2_", () => {
    expect(resolveJoinTargetTier({ executed: true, workspace: true })).toMatchObject({
      ranked: true,
      tier: JOIN_TARGET_TIERS.executed,
      source: "executed",
    });
    expect(resolveJoinTargetTier({ executed: true, catalogFk: true })).toMatchObject({
      tier: JOIN_TARGET_TIERS.catalogFk,
      source: "catalogFk",
    });
    expect(resolveJoinTargetTier({ executed: true, blocked: true })).toEqual({
      ranked: false,
      reason: "blocked",
      suppressed: [],
    });
  });

  it("never promotes an executed relation above a manual or confirmed one", () => {
    expect(resolveJoinTargetTier({ executed: true, manual: true })).toMatchObject({ tier: JOIN_TARGET_TIERS.manual });
    expect(resolveJoinTargetTier({ executed: true, confirmed: true })).toMatchObject({ tier: JOIN_TARGET_TIERS.confirmed });
  });

  it("keeps manual decisions when executed evidence is cleared", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"));
    execute(store, "b", day("2026-10-26"));
    store.appendRelationOverride({
      kind: "confirm",
      relation: products,
      databaseKind: "netezza",
      now: day("2026-10-26"),
      id: "confirm-1",
    });
    store.appendRelationOverride({
      kind: "favorite",
      relation: usersOrders,
      databaseKind: "netezza",
      now: day("2026-10-26"),
      id: "favorite-1",
    });
    store.upsertRelationEvidence({
      relationKey: identity(products).key,
      relation: identity(products),
      source: "workspace",
      observations: 2,
      distinctDays: 0,
      distinctFiles: 2,
      distinctQueries: 2,
      firstSeenAt: day("2026-10-20"),
      lastSeenAt: day("2026-10-20"),
      belowThreshold: false,
    });

    expect(store.clearExecutedEvidence()).toEqual({ relations: 1, objects: 1, columns: 0 });

    const state = store.getState();
    expect(state.relationOverrides.map((entry) => entry.kind).sort()).toEqual(["confirm", "favorite"]);
    expect(state.relationEvidence.map((entry) => entry.source)).toEqual(["workspace"]);
    expect(store.getExecutedObjectEvidence()).toHaveLength(0);
  });

  it("keeps executed evidence through an incremental workspace delta", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"));
    execute(store, "b", day("2026-10-26"));
    const snapshot: JoinKnowledgeSnapshot = store.buildSnapshot();

    const merged = mergeJoinKnowledgeIndexDelta(snapshot, {
      relationsUpsert: [],
      relationsRemove: [identity(usersOrders).key],
      objectsUpsert: [],
      objectsRemove: [],
      generatedAt: day("2026-10-27"),
    });

    expect(merged.executed?.relations).toHaveLength(1);
    expect(buildJoinKnowledgeIndex(merged).executedRelations.size).toBe(1);
  });
});

describe("executed evidence persistence and privacy", () => {
  it("round-trips counters, days and object observations through persisted state", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"), [usersOrders], [{ object: orders, kind: "select" }]);
    execute(store, "b", day("2026-10-26"), [usersOrders], [{ object: orders, kind: "select" }]);

    const state = parseJoinKnowledgeState(JSON.parse(JSON.stringify(store.getState())), "netezza");
    const restored = new JoinKnowledgeStore(state);
    const [relation] = restored.getExecutedRelationEvidence();
    expect(relation).toMatchObject({ observations: 2, distinctDays: 2, belowThreshold: false });
    const [object] = restored.getExecutedObjectEvidence();
    expect(object).toMatchObject({ observations: 2, distinctDays: 2, usage: { select: 2, insert: 0, update: 0, delete: 0 } });
  });

  it("continues counting days after a restart without double-counting the same day", () => {
    const first = new JoinKnowledgeStore();
    execute(first, "a", day("2026-10-25"));
    const restored = new JoinKnowledgeStore(
      parseJoinKnowledgeState(JSON.parse(JSON.stringify(first.getState())), "netezza"),
    );
    execute(restored, "b", day("2026-10-25"));

    expect(restored.getExecutedRelationEvidence()[0]).toMatchObject({ observations: 2, distinctDays: 1 });
  });

  it("stores and publishes identifiers and counters only, never SQL-like payloads", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"));
    const serialized = JSON.stringify({ state: store.getState(), snapshot: store.buildSnapshot() });

    // Usage counters use lower-case keys; the SQL keywords are upper-case only.
    expect(serialized).not.toMatch(/SELECT |JOIN |WHERE |secret/);
    expect(serialized).not.toContain("executionKey");
  });
});

describe("executed evidence diagnostics", () => {
  it("reports eligible and below-threshold counts without identifiers", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-25"), [usersOrders, products], [{ object: orders, kind: "select" }]);
    execute(store, "b", day("2026-10-26"), [usersOrders], [{ object: orders, kind: "select" }]);

    expect(store.describe().executed).toEqual({
      columnsEligible: 0,
      columnsBelowThreshold: 0,
      relationsEligible: 1,
      relationsBelowThreshold: 1,
      objectsEligible: 1,
      objectsBelowThreshold: 0,
      truncated: false,
    });
  });

  it("counts distinct days, not the last-day delta, when the clock moves backwards", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-24"));
    execute(store, "b", day("2026-10-25"));
    execute(store, "c", day("2026-10-24"));

    const [record] = store.getExecutedRelationEvidence();
    expect(record).toMatchObject({
      observations: 3,
      distinctDays: 2,
      days: ["2026-10-24", "2026-10-25"],
    });
  });

  it("rejects the same execution event after restoring persisted state", () => {
    const first = new JoinKnowledgeStore();
    execute(first, "same-event", day("2026-10-25"));
    const restored = new JoinKnowledgeStore(
      parseJoinKnowledgeState(JSON.parse(JSON.stringify(first.getState())), "netezza"),
    );

    expect(execute(restored, "same-event", day("2026-10-26"))).toBe("duplicate");
    expect(restored.getExecutedRelationEvidence()[0]).toMatchObject({
      observations: 1,
      distinctDays: 1,
      belowThreshold: true,
    });
  });

  it("stops at the configured record limits and reports truncation", () => {
    const store = new JoinKnowledgeStore(undefined, {
      limits: {
        maxRelationRecords: 1,
        maxObjectRecords: 1,
        maxDaysPerRecord: 2,
      },
    });
    const anotherObject: ObjectRef = { database: "BAZA", schema: "ADMIN", name: "PRODUCTS" };

    execute(store, "a", day("2026-10-24"), [usersOrders], [{ object: orders, kind: "select" }]);
    execute(store, "b", day("2026-10-25"), [products], [{ object: anotherObject, kind: "select" }]);
    execute(store, "c", day("2026-10-26"), [usersOrders], [{ object: orders, kind: "select" }]);

    expect(store.getExecutedRelationEvidence()).toHaveLength(1);
    expect(store.getExecutedObjectEvidence()).toHaveLength(1);
    expect(store.getExecutedRelationEvidence()[0].days).toEqual(["2026-10-24", "2026-10-26"]);
    expect(store.describe().executed.truncated).toBe(true);
  });

  it("deletes one executed record without touching the other source records", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-24"), [usersOrders, products], [{ object: orders, kind: "select" }]);
    execute(store, "b", day("2026-10-25"), [usersOrders], [{ object: orders, kind: "select" }]);

    expect(store.deleteExecutedRelationEvidence(identity(products).key)).toBe(true);
    expect(store.deleteExecutedRelationEvidence(identity(usersOrders).key)).toBe(true);
    expect(store.getExecutedRelationEvidence()).toHaveLength(0);
    expect(store.getExecutedObjectEvidence()).toHaveLength(1);
  });

  it("does not publish the local day set in the snapshot", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "a", day("2026-10-24"), [usersOrders], [{ object: orders, kind: "select" }]);
    execute(store, "b", day("2026-10-25"), [usersOrders], [{ object: orders, kind: "select" }]);
    const snapshot = store.buildSnapshot();

    for (const relation of snapshot.executed?.relations ?? []) {
      expect(relation).not.toHaveProperty("days");
    }
    for (const object of snapshot.executed?.objects ?? []) {
      expect(object).not.toHaveProperty("days");
    }
  });
});
