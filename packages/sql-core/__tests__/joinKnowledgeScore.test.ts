import {
  acceptedObjectBand,
  buildJoinKnowledgeIndex,
  buildJoinSortText,
  canonicalizeRelation,
  JOIN_SCORE_MODEL,
  joinTargetGrain,
  JOIN_TARGET_TIERS,
  JoinKnowledgeStore,
  joinColumnPairExactness,
  joinEvidenceBreadth,
  joinEvidenceFreshness,
  joinTableSchemaAgreement,
  scoreJoinCandidate,
  type JoinKnowledgeSnapshot,
  type JoinRelationEvidenceRecord,
  type WorkspaceRelationSnapshot,
} from "../src/joinKnowledge";

const NOW = "2026-10-26T12:00:00.000Z";

function relation(right = "CUSTOMERS") {
  const identity = canonicalizeRelation({
    left: { table: "ORDERS" },
    right: { table: right },
    columns: [{ left: "CUSTOMER_ID", right: "CUSTOMER_ID" }],
  }, "netezza");
  if (!identity) {
    throw new Error("invalid fixture");
  }
  return identity;
}

function workspaceRecord(
  files: number,
  lastSeenAt: string,
  overrides: Partial<WorkspaceRelationSnapshot> = {},
): WorkspaceRelationSnapshot {
  const identity = relation();
  return {
    key: identity.key,
    relation: identity,
    observations: files,
    distinctFiles: files,
    distinctQueries: files,
    belowThreshold: false,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    ...overrides,
  };
}

function snapshotWith(
  relations: WorkspaceRelationSnapshot[],
  executed: JoinRelationEvidenceRecord[] = [],
): JoinKnowledgeSnapshot {
  return {
    version: 1,
    relations: [],
    objectPreferences: [],
    workspace: {
      version: 1,
      relations,
      objects: [],
      truncated: false,
      generatedAt: NOW,
    },
    executed: { relations: executed, objects: [] },
  };
}

describe("within-tier JOIN score model", () => {
  it("keeps the documented factor weights summing to one", () => {
    const total = Object.values(JOIN_SCORE_MODEL.factors).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("grades column-pair exactness", () => {
    expect(joinColumnPairExactness([{ left: "CUSTOMER_ID", right: "CUSTOMER_ID" }], "ORDERS", "CUSTOMERS"))
      .toBe(1);
    expect(joinColumnPairExactness([{ left: "CUSTOMER_ID", right: "ID" }], "ORDERS", "CUSTOMERS"))
      .toBe(0.85);
    expect(joinColumnPairExactness([{ left: "CATEGORY_ID", right: "ID" }], "PRODUCTS", "CATEGORIES"))
      .toBe(0.85);
    expect(joinColumnPairExactness([{ left: "BILL_CUSTOMER_ID", right: "CUSTOMER_ID" }], "ORDERS", "CUSTOMERS"))
      .toBe(0.6);
    expect(joinColumnPairExactness([{ left: "OWNER_ID", right: "ID" }], "USERS", "ORDERS"))
      .toBe(0.35);
    expect(joinColumnPairExactness([], "A", "B")).toBe(0);
  });

  it("grades database/schema agreement with the effective scope as fallback", () => {
    const defaults = { database: "DWH", schema: "ADMIN" };
    expect(joinTableSchemaAgreement({}, { database: "DWH", schema: "ADMIN" }, defaults)).toBe(1);
    expect(joinTableSchemaAgreement({}, { database: "DWH", schema: "STAGE" }, defaults)).toBe(0.5);
    expect(joinTableSchemaAgreement({}, { database: "OTHER" }, defaults)).toBe(0);
  });

  it("makes breadth monotonic beyond the eligibility threshold", () => {
    expect(joinEvidenceBreadth(0, 0)).toBe(0);
    expect(joinEvidenceBreadth(8, 8)).toBeGreaterThan(joinEvidenceBreadth(4, 4));
    expect(joinEvidenceBreadth(4, 4)).toBeGreaterThan(joinEvidenceBreadth(2, 2));
    expect(joinEvidenceBreadth(10_000, 10_000)).toBe(1);
  });

  it("halves freshness every 90 days and ignores invalid timestamps", () => {
    expect(joinEvidenceFreshness(NOW, NOW)).toBe(1);
    expect(joinEvidenceFreshness("2026-07-28T12:00:00.000Z", NOW)).toBeCloseTo(0.5, 5);
    expect(joinEvidenceFreshness("not a date", NOW)).toBe(0);
    expect(joinEvidenceFreshness(undefined, NOW)).toBe(0);
    // A future observation (clock skew) never exceeds 1.
    expect(joinEvidenceFreshness("2027-01-01T00:00:00.000Z", NOW)).toBe(1);
  });

  it("prefers a parent target, keeps unknown roles neutral and demotes a child", () => {
    const base = { columnPairExactness: 1, tableSchemaAgreement: 1, contextSimilarity: 1 };
    const parent = scoreJoinCandidate({ ...base, targetRole: "parent" });
    const peer = scoreJoinCandidate({ ...base, targetRole: "peer" });
    const unknown = scoreJoinCandidate(base);
    const child = scoreJoinCandidate({ ...base, targetRole: "child" });
    expect(joinTargetGrain("parent")).toBe(1);
    expect(joinTargetGrain(undefined)).toBe(0.5);
    expect(joinTargetGrain("child")).toBe(0);
    expect(unknown).toBe(peer);
    expect(parent).toBeLessThan(peer);
    expect(peer).toBeLessThan(child);
    // Grain separates roles by a few points only; it never outweighs
    // evidence breadth plus freshness.
    const evidencedChild = scoreJoinCandidate({
      ...base,
      targetRole: "child",
      evidence: { breadth: 1, freshness: 1 },
    });
    expect(evidencedChild).toBeLessThan(parent);
  });

  it("scores stronger candidates lower and stays inside two digits", () => {
    const weak = scoreJoinCandidate({
      columnPairExactness: 0.35,
      tableSchemaAgreement: 0,
      contextSimilarity: 0,
    });
    const strong = scoreJoinCandidate({
      evidence: { breadth: 1, freshness: 1 },
      columnPairExactness: 1,
      tableSchemaAgreement: 1,
      contextSimilarity: 1,
      targetRole: "parent",
    });
    expect(strong).toBeLessThan(weak);
    expect(strong).toBe(JOIN_SCORE_MODEL.scoreBase);
    for (const adjustment of [-99, -5, 0, 5, 99]) {
      for (const alreadyJoined of [false, true]) {
        const score = scoreJoinCandidate({
          columnPairExactness: 0,
          tableSchemaAgreement: 0,
          contextSimilarity: 0,
          userAdjustment: adjustment,
          alreadyJoined,
        });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(99);
      }
    }
  });

  it("applies the user adjustment and the already-joined penalty within the tier", () => {
    const base = { columnPairExactness: 1, tableSchemaAgreement: 1, contextSimilarity: 1 };
    const neutral = scoreJoinCandidate(base);
    expect(scoreJoinCandidate({ ...base, userAdjustment: 2 })).toBe(neutral - 20);
    expect(scoreJoinCandidate({ ...base, alreadyJoined: true }))
      .toBeGreaterThan(neutral + JOIN_SCORE_MODEL.alreadyJoinedPenalty);
  });

  it("never lets a score promote across tiers", () => {
    const worstExecuted = buildJoinSortText(JOIN_TARGET_TIERS.executed, "A", 99);
    const bestWorkspace = buildJoinSortText(JOIN_TARGET_TIERS.workspace, "A", 0);
    expect(worstExecuted < bestWorkspace).toBe(true);
    const worstFk = buildJoinSortText(JOIN_TARGET_TIERS.catalogFk, "Z", 99);
    const bestFavorite = buildJoinSortText(JOIN_TARGET_TIERS.favorite, "A", 0);
    expect(worstFk < bestFavorite).toBe(true);
  });
});

describe("relation evidence strength in the ranking index", () => {
  it("precomputes breadth and freshness for eligible workspace evidence", () => {
    const recent = buildJoinKnowledgeIndex(snapshotWith([workspaceRecord(8, "2026-10-20T00:00:00.000Z")]), { now: NOW });
    const stale = buildJoinKnowledgeIndex(snapshotWith([workspaceRecord(2, "2025-06-01T00:00:00.000Z")]), { now: NOW });
    const key = relation().key;
    const strong = recent.relationEvidenceStrength.get(key);
    const weak = stale.relationEvidenceStrength.get(key);
    expect(strong).toBeDefined();
    expect(weak).toBeDefined();
    expect(strong!.breadth).toBeGreaterThan(weak!.breadth);
    expect(strong!.freshness).toBeGreaterThan(weak!.freshness);
  });

  it("ignores below-threshold and blocked evidence", () => {
    const below = buildJoinKnowledgeIndex(snapshotWith([
      workspaceRecord(1, NOW, { belowThreshold: true }),
    ]), { now: NOW });
    expect(below.relationEvidenceStrength.size).toBe(0);

    const identity = relation();
    const blocked = buildJoinKnowledgeIndex({
      ...snapshotWith([workspaceRecord(4, NOW)]),
      relations: [{ key: identity.key, decision: "blocked", relation: identity }],
    }, { now: NOW });
    expect(blocked.relationEvidenceStrength.size).toBe(0);
  });

  it("merges workspace and executed evidence by the stronger value, never summing", () => {
    const identity = relation();
    const executed: JoinRelationEvidenceRecord = {
      relationKey: identity.key,
      relation: identity,
      databaseKind: "netezza",
      source: "executed",
      observations: 3,
      distinctDays: 2,
      firstSeenAt: "2026-10-25T00:00:00.000Z",
      lastSeenAt: "2026-10-26T00:00:00.000Z",
      belowThreshold: false,
    };
    const workspaceOnly = buildJoinKnowledgeIndex(
      snapshotWith([workspaceRecord(8, "2025-06-01T00:00:00.000Z")]),
      { now: NOW },
    ).relationEvidenceStrength.get(identity.key)!;
    const executedOnly = buildJoinKnowledgeIndex(snapshotWith([], [executed]), { now: NOW })
      .relationEvidenceStrength.get(identity.key)!;
    const merged = buildJoinKnowledgeIndex(
      snapshotWith([workspaceRecord(8, "2025-06-01T00:00:00.000Z")], [executed]),
      { now: NOW },
    ).relationEvidenceStrength.get(identity.key)!;
    expect(merged.breadth).toBe(Math.max(workspaceOnly.breadth, executedOnly.breadth));
    expect(merged.freshness).toBe(Math.max(workspaceOnly.freshness, executedOnly.freshness));
  });
});

describe("accepted FROM selections", () => {
  it("needs six selections (three weighted queries) and stays inside the learned range", () => {
    expect(acceptedObjectBand(5)).toBeUndefined();
    const band = acceptedObjectBand(6);
    expect(band).toBeDefined();
    expect(band!).toBeGreaterThanOrEqual(10);
    expect(band!).toBeLessThanOrEqual(49);
    expect(acceptedObjectBand(40)!).toBeLessThanOrEqual(band!);
  });

  it("records selections as preference evidence that survives a round-trip", () => {
    const store = new JoinKnowledgeStore();
    for (let index = 0; index < 6; index += 1) {
      store.recordAcceptedObject({
        object: { name: "orders" },
        databaseKind: "netezza",
        defaults: { database: "DWH", schema: "ADMIN" },
        now: NOW,
      });
    }
    const restored = JoinKnowledgeStore.fromState(JSON.parse(JSON.stringify(store.getState())), "netezza");
    const snapshot = restored.buildSnapshot();
    expect(snapshot.acceptedObjects).toEqual([
      expect.objectContaining({
        object: { database: "DWH", schema: "ADMIN", name: "ORDERS" },
        observations: 6,
        belowThreshold: false,
      }),
    ]);
    // Acceptance is never a manual preference and never a relation.
    expect(snapshot.objectPreferences).toEqual([]);
    expect(snapshot.relations).toEqual([]);
    const index = buildJoinKnowledgeIndex(snapshot, { now: NOW });
    expect(index.acceptedObjectBands.get("DWH\u0000ADMIN\u0000ORDERS")).toBe(acceptedObjectBand(6));

    expect(restored.clearAcceptedObjectEvidence()).toBe(1);
    expect(restored.buildSnapshot().acceptedObjects).toBeUndefined();
  });
});
