import {
  buildJoinKnowledgeIndex,
  buildJoinSortText,
  buildObjectSortText,
  canonicalizeRelation,
  explainObjectPreference,
  explainRelationDecision,
  isExecutedEvidenceEligible,
  isWorkspaceEvidenceEligible,
  JOIN_KNOWLEDGE_THRESHOLDS,
  JOIN_TARGET_TIERS,
  JoinKnowledgeStore,
  normalizeObjectRef,
  normalizeSqlForFingerprint,
  objectRefKey,
  parseJoinKnowledgeState,
  resolveJoinPredicateTier,
  resolveJoinTargetTier,
  OBJECT_BANDS,
  OBJECT_RANKING_MODEL,
  verifyRelationIdentity,
  type JoinKnowledgeState,
  type RelationInput,
} from "../src/joinKnowledge";
import { createHash } from "node:crypto";

const now = "2026-10-25T10:00:00.000Z";

const usersOrders: RelationInput = {
  left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [
    { left: "USER_ID", right: "OWNER_ID" },
    { left: "TENANT_ID", right: "TENANT_KEY" },
  ],
};

function identity(input: RelationInput, kind = "netezza") {
  const relation = canonicalizeRelation(input, kind);
  expect(relation).toBeDefined();
  return relation!;
}

describe("relation identity canonicalization", () => {
  it("produces one key for both JOIN directions", () => {
    const forward = identity(usersOrders);
    const reverse = identity({
      left: usersOrders.right,
      right: usersOrders.left,
      columns: usersOrders.columns.map((pair) => ({ left: pair.right, right: pair.left })),
    });

    expect(reverse.key).toBe(forward.key);
    expect(reverse.columnPairs).toEqual(forward.columnPairs);
    expect(forward.display.left.table).toBe("USERS");
    expect(reverse.display.left.table).toBe("ORDERS");
    expect(forward.tables.map((table) => table.table)).toEqual(["ORDERS", "USERS"]);
  });

  it("produces one key for composite pairs written in any AND order", () => {
    const first = identity(usersOrders);
    const second = identity({
      ...usersOrders,
      columns: [...usersOrders.columns].reverse(),
    });

    expect(second.key).toBe(first.key);
    expect(first.columnPairs).toHaveLength(2);
  });

  it("binds each column to its own table and never sorts columns independently", () => {
    const relation = identity(usersOrders);
    for (const pair of relation.columnPairs) {
      if (pair.leftColumn === "USER_ID") {
        expect(pair.leftTable.table).toBe("ORDERS");
        expect(pair.rightColumn).toBe("OWNER_ID");
        expect(pair.rightTable.table).toBe("USERS");
      }
    }
    const wrongShape = identity({
      left: usersOrders.left,
      right: usersOrders.right,
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    });
    const swappedColumnsOnly = identity({
      left: usersOrders.left,
      right: usersOrders.right,
      columns: [{ left: "OWNER_ID", right: "USER_ID" }],
    });
    expect(swappedColumnsOnly.key).not.toBe(wrongShape.key);
  });

  it("normalizes DB..TABLE and DB.SCHEMA.TABLE with the same effective schema", () => {
    const doubleDot = identity({
      left: { database: "BAZA", table: "USERS" },
      right: { database: "BAZA", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "ID" }],
    });
    const threePart = identity({
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "ID" }],
    });
    // Without a default schema the two spellings are different objects.
    expect(doubleDot.key).not.toBe(threePart.key);

    const withDefault = canonicalizeRelation(
      {
        left: { database: "BAZA", table: "USERS" },
        right: { database: "BAZA", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "ID" }],
      },
      "netezza",
      { schema: "ADMIN" },
    );
    expect(withDefault?.key).toBe(threePart.key);
  });

  it("keeps quoted identifiers byte-exact and distinct from folded names", () => {
    const unquoted = identity({
      left: { database: "BAZA", schema: "ADMIN", table: "users" },
      right: { database: "BAZA", schema: "ADMIN", table: "orders" },
      columns: [{ left: "user_id", right: "id" }],
    });
    const upper = identity({
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "ID" }],
    });
    const quoted = identity({
      left: { database: "BAZA", schema: "ADMIN", table: '"users"' },
      right: { database: "BAZA", schema: "ADMIN", table: '"orders"' },
      columns: [{ left: '"user_id"', right: '"id"' }],
    });

    expect(unquoted.key).toBe(upper.key);
    expect(quoted.key).not.toBe(upper.key);
    expect(quoted.tables[0].table).toBe("orders");
  });

  it("rejects self, incomplete and unbound identities", () => {
    expect(canonicalizeRelation({
      left: { table: "T" },
      right: { table: "T" },
      columns: [{ left: "ID", right: "ID" }],
    }, "netezza")).toBeUndefined();
    expect(canonicalizeRelation({
      left: { table: "A" },
      right: { table: "B" },
      columns: [],
    }, "netezza")).toBeUndefined();
    expect(canonicalizeRelation({
      left: { table: "A" },
      right: { table: "B" },
      columns: [{ left: "", right: "ID" }],
    }, "netezza")).toBeUndefined();
  });
});

describe("JOIN tier model", () => {
  it("orders manual, confirmation and FK exactly", () => {
    const manual = resolveJoinTargetTier({ manual: true, confirmed: true, catalogFk: true });
    expect(manual).toMatchObject({
      ranked: true,
      tier: "0_0_",
      source: "manual",
    });
    expect(manual.ranked && manual.suppressed).toEqual(["confirmed", "catalogFk"]);
    expect(manual.ranked && manual.suppressedBy).toBe("manual");

    const confirmed = resolveJoinTargetTier({ confirmed: true, catalogFk: true });
    expect(confirmed).toMatchObject({ tier: "0_1_", source: "confirmed" });
    const fk = resolveJoinTargetTier({ catalogFk: true, executed: true, workspace: true });
    expect(fk).toMatchObject({ tier: "0_2_", source: "catalogFk" });
    expect(fk.ranked && fk.suppressed).toEqual(["executed", "workspace"]);
  });

  it("never lets observed evidence outrank FK and allows confirmation above it", () => {
    expect(resolveJoinTargetTier({ executed: true })).toMatchObject({ tier: "0_4_" });
    expect(resolveJoinTargetTier({ workspace: true })).toMatchObject({ tier: "0_5_" });
    expect(resolveJoinTargetTier({})).toMatchObject({ tier: "2_", source: "heuristic" });
    expect(resolveJoinPredicateTier({ cachedKey: true })).toMatchObject({ tier: "0_6_" });
    expect(resolveJoinPredicateTier({ nameMatch: true })).toMatchObject({ tier: "0_7_" });
  });

  it("applies block before tiering", () => {
    expect(resolveJoinTargetTier({ blocked: true, manual: true })).toEqual({
      ranked: false,
      reason: "blocked",
      suppressed: [],
    });
  });

  it("formats bounded two-digit scores without crossing tiers", () => {
    expect(buildJoinSortText("0_2_", "orders", 7)).toBe("0_2_07_ORDERS");
    expect(buildJoinSortText("0_2_", "orders", 700)).toBe("0_2_99_ORDERS");
    expect(buildJoinSortText("0_2_", "orders")).toBe("0_2_ORDERS");
  });

  it("never lets a bounded score cross a tier boundary", () => {
    const manualLowest = buildJoinSortText(JOIN_TARGET_TIERS.manual, "Z", 99);
    const confirmedHighest = buildJoinSortText(JOIN_TARGET_TIERS.confirmed, "A", 0);
    const confirmedLowest = buildJoinSortText(JOIN_TARGET_TIERS.confirmed, "Z", 99);
    const fkHighest = buildJoinSortText(JOIN_TARGET_TIERS.catalogFk, "A", 0);
    const fkLowest = buildJoinSortText(JOIN_TARGET_TIERS.catalogFk, "Z", 99);
    const favoriteHighest = buildJoinSortText(JOIN_TARGET_TIERS.favorite, "A", 0);
    const workspaceHighest = buildJoinSortText(JOIN_TARGET_TIERS.workspace, "A", 0);
    const heuristic = buildJoinSortText(JOIN_TARGET_TIERS.heuristic, "A", 0);

    expect(manualLowest < confirmedHighest).toBe(true);
    expect(confirmedLowest < fkHighest).toBe(true);
    expect(fkLowest < favoriteHighest).toBe(true);
    expect(favoriteHighest < workspaceHighest).toBe(true);
    expect(workspaceHighest < heuristic).toBe(true);
  });

  it("keeps evidence thresholds at their documented boundaries", () => {
    expect(isExecutedEvidenceEligible(
      JOIN_KNOWLEDGE_THRESHOLDS.minExecutions - 1,
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctDays - 1,
    )).toBe(false);
    expect(isExecutedEvidenceEligible(
      JOIN_KNOWLEDGE_THRESHOLDS.minExecutions,
      0,
    )).toBe(true);
    expect(isExecutedEvidenceEligible(
      0,
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctDays,
    )).toBe(true);
    expect(isWorkspaceEvidenceEligible(
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctFiles - 1,
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctQueries - 1,
    )).toBe(false);
    expect(isWorkspaceEvidenceEligible(
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctFiles,
      0,
    )).toBe(true);
    expect(isWorkspaceEvidenceEligible(
      1,
      JOIN_KNOWLEDGE_THRESHOLDS.minDistinctQueries,
    )).toBe(true);
    expect(isWorkspaceEvidenceEligible(0, 0, 3)).toBe(true);
    expect(isWorkspaceEvidenceEligible(0, 0, 2.5)).toBe(false);
  });

  it("exposes one object ranking model with bounded caps", () => {
    expect(OBJECT_RANKING_MODEL.usageWeights.select).toBe(1);
    expect(OBJECT_RANKING_MODEL.usageWeights.insert).toBe(0.5);
    expect(OBJECT_RANKING_MODEL.bestBandCaps.select).toBe(OBJECT_BANDS.learnedMin);
    expect(OBJECT_RANKING_MODEL.bestBandCaps.insert).toBeLessThanOrEqual(OBJECT_BANDS.learnedMax);
    expect(OBJECT_RANKING_MODEL.thresholds).toBe(JOIN_KNOWLEDGE_THRESHOLDS);
  });
});

describe("object sortText grammar", () => {
  it("preserves the legacy grammar with empty knowledge", () => {
    expect(buildObjectSortText({
      scope: "0",
      kind: "00",
      matchRank: 0,
      name: "EMPLOYEES",
    })).toBe("3_000_EMPLOYEES");
    expect(buildObjectSortText({
      scope: "1",
      kind: "10",
      matchRank: 2,
      name: "EMPLOYEES_MV",
    })).toBe("3_110_2_EMPLOYEES_MV");
  });

  it("emits match rank before a neutral band when object knowledge is active", () => {
    expect(buildObjectSortText({
      scope: "0",
      kind: "00",
      matchRank: 0,
      name: "EMPLOYEES",
      emitNeutralBand: true,
    })).toBe("3_000_050_EMPLOYEES");
    expect(buildObjectSortText({
      scope: "0",
      kind: "00",
      matchRank: 2,
      name: "EMPLOYEES",
      emitNeutralBand: true,
    })).toBe("3_000_250_EMPLOYEES");
  });

  it("never lets a boost or demote cross match rank, scope or kind", () => {
    const neutralDirect = buildObjectSortText({
      scope: "0", kind: "00", matchRank: 0, name: "A", emitNeutralBand: true,
    });
    const boostedWeak = buildObjectSortText({
      scope: "0", kind: "00", matchRank: 2, name: "Z", band: 0, emitNeutralBand: true,
    });
    const boostedOtherSchema = buildObjectSortText({
      scope: "1", kind: "00", matchRank: 0, name: "A", band: 0, emitNeutralBand: true,
    });
    const neutralEffectiveView = buildObjectSortText({
      scope: "0", kind: "10", matchRank: 0, name: "A", emitNeutralBand: true,
    });
    const demotedDirect = buildObjectSortText({
      scope: "0", kind: "00", matchRank: 0, name: "A", band: OBJECT_BANDS.demote, emitNeutralBand: true,
    });

    expect(neutralDirect < boostedWeak).toBe(true);
    expect(neutralDirect < boostedOtherSchema).toBe(true);
    expect(neutralEffectiveView < boostedOtherSchema).toBe(true);
    expect(demotedDirect > neutralDirect).toBe(true);
    expect(neutralDirect < demotedDirect).toBe(true);
  });

  it("lets only pin cross scope and kind, and always includes match rank", () => {
    const pinnedOtherSchema = buildObjectSortText({
      scope: "1", kind: "00", matchRank: 0, name: "ORDERS", pinOrder: 1,
    });
    const neutralEffective = buildObjectSortText({
      scope: "0", kind: "00", matchRank: 0, name: "EMPLOYEES", emitNeutralBand: true,
    });
    const pinnedWeakMatch = buildObjectSortText({
      scope: "0", kind: "00", matchRank: 3, name: "ORDERS", pinOrder: 2,
    });

    expect(pinnedOtherSchema).toBe("2_010_ORDERS");
    expect(pinnedOtherSchema < neutralEffective).toBe(true);
    expect(pinnedWeakMatch).toBe("2_023_ORDERS");
  });
});

describe("JoinKnowledgeStore", () => {
  function storeWith(
    state?: JoinKnowledgeState,
  ): JoinKnowledgeStore {
    return new JoinKnowledgeStore(state);
  }

  it("appends confirmations and supports a reversible confirmation", () => {
    const store = storeWith();
    const confirmed = store.appendRelationOverride({
      kind: "confirm",
      relation: usersOrders,
      databaseKind: "netezza",
      now,
      id: "r1",
    });
    expect(store.getRelationDecision(confirmed.relationKey)).toBe("confirmed");
    expect(store.buildSnapshot().relations).toHaveLength(1);

    expect(store.revertRelationOverride("r1", "2026-10-25T11:00:00.000Z")).toBe(true);
    expect(store.getRelationDecision(confirmed.relationKey)).toBeUndefined();
    expect(store.getRelationOverrides()).toHaveLength(1);
    expect(store.getRelationOverrides()[0].revertedAt).toBe("2026-10-25T11:00:00.000Z");
    expect(store.revertRelationOverride("r1", now)).toBe(false);
  });

  it("treats block as the winner and keeps both records as history", () => {
    const store = storeWith();
    const confirmed = store.appendRelationOverride({
      kind: "confirm", relation: usersOrders, databaseKind: "netezza", now, id: "r1",
    });
    const blocked = store.appendRelationOverride({
      kind: "block", relation: usersOrders, databaseKind: "netezza", now, id: "r2",
    });

    expect(confirmed.relationKey).toBe(blocked.relationKey);
    expect(store.getRelationDecision(blocked.relationKey)).toBe("blocked");
    const snapshot = store.buildSnapshot();
    expect(snapshot.relations).toHaveLength(1);
    expect(snapshot.relations[0].decision).toBe("blocked");
    expect(store.getRelationOverrides().map((entry) => entry.id)).toEqual(["r1", "r2"]);
    expect(store.getRelationOverrides()[0].replacedBy).toBe("r2");
  });

  it("keeps at most one active object preference and records replacement", () => {
    const object = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };
    const store = storeWith();
    const boosted = store.appendObjectPreference({
      kind: "boost", object, band: 3, now, id: "o1", databaseKind: "netezza",
    });
    const pinned = store.appendObjectPreference({
      kind: "pin", object, pinOrder: 4, now: "2026-10-25T12:00:00.000Z", id: "o2", databaseKind: "netezza",
    });

    expect(store.getActiveObjectPreference(boosted.objectKey)?.id).toBe("o2");
    expect(store.getObjectOverrides()[0].replacedBy).toBe("o2");
    expect(store.getActiveObjectPreferences()).toHaveLength(1);
    expect(store.buildSnapshot().objectPreferences).toEqual([{
      key: pinned.objectKey,
      kind: "pin",
      object,
      pinOrder: 4,
    }]);

    store.revertObjectPreference("o2", "2026-10-25T13:00:00.000Z");
    expect(store.getActiveObjectPreference(boosted.objectKey)).toBeUndefined();
    expect(store.getObjectOverrides()[1].revertedAt).toBe("2026-10-25T13:00:00.000Z");
  });

  it("keys object preferences by database, schema and name", () => {
    const admin = normalizeObjectRef({ database: "BAZA", schema: "ADMIN", name: "ORDERS_" }, "netezza")!;
    const publicSchema = normalizeObjectRef({ database: "BAZA", schema: "PUBLIC", name: "ORDERS_" }, "netezza")!;
    expect(objectRefKey(admin)).not.toBe(objectRefKey(publicSchema));
  });

  it("captures the effective schema before a DB.. relation is persisted", () => {
    const doubleDot: RelationInput = {
      left: { database: "BAZA", table: "USERS" },
      right: { database: "BAZA", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    };
    const threePart: RelationInput = {
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    };
    const expected = canonicalizeRelation(threePart, "netezza")!;
    const store = new JoinKnowledgeStore();
    const override = store.appendRelationOverride({
      kind: "confirm",
      relation: doubleDot,
      databaseKind: "netezza",
      defaults: { schema: "ADMIN" },
      now,
      id: "r-defaults",
    });

    expect(override.relationKey).toBe(expected.key);
    expect(override.relation.display.left).toEqual({
      database: "BAZA",
      schema: "ADMIN",
      table: "USERS",
    });

    const parsed = parseJoinKnowledgeState(
      JSON.parse(JSON.stringify(store.getState(now))),
    );
    expect(parsed.relationOverrides).toHaveLength(1);
    expect(parsed.relationOverrides[0].relationKey).toBe(expected.key);
    expect(parsed.relationOverrides[0].relation).toEqual(expected);
  });

  it("round-trips unqualified relations without inventing a schema", () => {
    const relation: RelationInput = {
      left: { table: "A" },
      right: { table: "B" },
      columns: [{ left: "ID", right: "A_ID" }],
    };
    const expected = canonicalizeRelation(relation, "netezza")!;
    const store = new JoinKnowledgeStore();
    store.appendRelationOverride({
      kind: "confirm",
      relation,
      databaseKind: "netezza",
      now,
      id: "r-unqualified",
    });

    const parsed = parseJoinKnowledgeState(
      JSON.parse(JSON.stringify(store.getState(now))),
    );
    expect(parsed.relationOverrides[0].relationKey).toBe(expected.key);
    expect(parsed.relationOverrides[0].relation.display.left).toEqual({ table: "A" });
    expect(parsed.relationOverrides[0].relation).toEqual(expected);
  });

  it("does not accept a key that was computed with a scope missing from display", () => {
    const relation: RelationInput = {
      left: { database: "BAZA", table: "USERS" },
      right: { database: "BAZA", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    };
    const withDefaults = canonicalizeRelation(relation, "netezza", { schema: "ADMIN" })!;
    const withoutDefaults = canonicalizeRelation(relation, "netezza")!;

    expect(verifyRelationIdentity({
      ...withDefaults,
      display: withoutDefaults.display,
    }, "netezza")).toBeUndefined();
  });

  it("captures effective object scope before a preference is persisted", () => {
    const store = new JoinKnowledgeStore();
    const override = store.appendObjectPreference({
      kind: "pin",
      object: { name: "ORDERS" },
      databaseKind: "netezza",
      defaults: { database: "BAZA", schema: "ADMIN" },
      now,
      id: "o-defaults",
    });

    expect(override.object).toEqual({
      database: "BAZA",
      schema: "ADMIN",
      name: "ORDERS",
    });
    expect(override.objectKey).toBe(objectRefKey(override.object));

    const parsed = parseJoinKnowledgeState(
      JSON.parse(JSON.stringify(store.getState(now))),
    );
    expect(parsed.objectOverrides[0].object).toEqual(override.object);
    expect(parsed.objectOverrides[0].objectKey).toBe(override.objectKey);
  });

  it("lets exclude win if an older state persisted competing preferences", () => {
    const object = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };
    const base = {
      objectKey: objectRefKey(object),
      object,
      databaseKind: "netezza",
      createdAt: now,
    };
    const store = new JoinKnowledgeStore({
      version: 1,
      relationOverrides: [],
      relationEvidence: [],
      objectEvidence: [],
      objectOverrides: [
        { ...base, id: "o1", kind: "pin", pinOrder: 1 },
        { ...base, id: "o2", kind: "exclude" },
      ],
    });
    expect(store.getActiveObjectPreference(base.objectKey)?.kind).toBe("exclude");
    expect(store.buildSnapshot().objectPreferences).toEqual([{
      key: base.objectKey,
      kind: "exclude",
      object,
    }]);
  });

  it("builds lookup maps and explanations", () => {
    const store = storeWith();
    const relation = store.appendRelationOverride({
      kind: "confirm", relation: usersOrders, databaseKind: "netezza", now, id: "r1",
    });
    store.appendObjectPreference({
      kind: "exclude",
      object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
      now,
      id: "o1",
      databaseKind: "netezza",
    });
    const index = buildJoinKnowledgeIndex(store.buildSnapshot());

    expect(index.confirmedRelations.has(relation.relationKey)).toBe(true);
    expect(index.hasObjectPreferences).toBe(true);
    expect(explainRelationDecision(index, relation.relationKey)).toMatchObject({
      decision: "confirmed",
    });
    expect(explainObjectPreference(index, index.objectPreferences.keys().next().value!)).toMatchObject({
      kind: "exclude",
    });
  });

  it("applies only the latest active score adjustment and ignores reverted records", () => {
    const store = storeWith();
    const relation = store.appendRelationOverride({
      kind: "confirm", relation: usersOrders, databaseKind: "netezza", now, id: "r1",
    });
    store.appendRelationScoreOverride({
      relation: usersOrders, databaseKind: "netezza", adjustment: 3, now, id: "s1",
    });
    let index = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(index.relationScoreAdjustments.get(relation.relationKey)).toBe(3);

    // A newer zero record is the active reset and removes the score.
    store.appendRelationScoreOverride({
      relation: usersOrders, databaseKind: "netezza", adjustment: 0, now, id: "s2",
    });
    index = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(index.relationScoreAdjustments.has(relation.relationKey)).toBe(false);

    const snapshot = store.buildSnapshot();
    const score = snapshot.relationScoreOverrides![0];
    // Raw snapshots may still contain reverted or multiple active records:
    // the latest active record wins, and a reverted one never resurrects.
    index = buildJoinKnowledgeIndex({
      ...snapshot,
      relationScoreOverrides: [
        { ...score, id: "s-old", adjustment: 4, revertedAt: now },
        { ...score, id: "s-active", adjustment: -2 },
      ],
    });
    expect(index.relationScoreAdjustments.get(relation.relationKey)).toBe(-2);

    index = buildJoinKnowledgeIndex({
      ...snapshot,
      relationScoreOverrides: [
        { ...score, id: "s-older", adjustment: 4 },
        { ...score, id: "s-latest", adjustment: 0 },
      ],
    });
    expect(index.relationScoreAdjustments.has(relation.relationKey)).toBe(false);
  });

  it("never serializes SQL text or unknown payload fields", () => {
    const store = storeWith();
    store.appendRelationOverride({
      kind: "confirm",
      relation: {
        ...usersOrders,
        // @ts-expect-error deliberately smuggled field must be dropped
        sql: "SELECT secret FROM T WHERE password = 'hunter2'",
      },
      databaseKind: "netezza",
      now,
      id: "r1",
    });
    store.appendObjectPreference({
      kind: "boost",
      object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
      band: 2,
      now,
      id: "o1",
      databaseKind: "netezza",
    });
    const payload = JSON.stringify(store.getState(now));
    expect(payload).not.toContain("hunter2");
    expect(payload).not.toContain("SELECT");
    expect(payload).not.toContain("password");
  });

  it("rejects unknown state versions and drops corrupt records", () => {
    expect(parseJoinKnowledgeState({ version: 2, relationOverrides: [] })).toMatchObject({
      version: 1,
      relationOverrides: [],
      objectOverrides: [],
    });
    expect(parseJoinKnowledgeState({
      version: 1,
      relationOverrides: [
        { id: "bad", kind: "confirm" },
        { id: "bad2", kind: "confirm", relation: { key: "x", display: { columns: [] } }, createdAt: now },
      ],
      objectOverrides: [{ id: "x", kind: "pin" }],
    })).toMatchObject({ relationOverrides: [], objectOverrides: [] });
    expect(() => storeWith().appendRelationOverride({
      kind: "confirm",
      relation: { left: { table: "A" }, right: { table: "A" }, columns: [{ left: "X", right: "Y" }] },
      now,
    })).toThrow(/invalid relation identity/u);
  });

  it("describes counts without leaking payloads", () => {
    const store = storeWith();
    store.appendRelationOverride({
      kind: "confirm", relation: usersOrders, databaseKind: "netezza", now, id: "r1",
    });
    store.appendObjectPreference({
      kind: "boost",
      object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
      band: 1,
      now,
      id: "o1",
      databaseKind: "netezza",
    });
    expect(store.describe()).toEqual({
      relationOverrides: { active: 1, reverted: 0, confirmed: 1, blocked: 0, favorites: 0 },
      objectOverrides: { active: 1, reverted: 0, pinned: 0, boosted: 1, demoted: 0, excluded: 0 },
      relationEvidence: 0,
      objectEvidence: 0,
      executed: {
        relationsEligible: 0,
        relationsBelowThreshold: 0,
        objectsEligible: 0,
        objectsBelowThreshold: 0,
        columnsEligible: 0,
        columnsBelowThreshold: 0,
        truncated: false,
      },
    });
  });
});

describe("fingerprint normalization", () => {
  it("collapses whitespace, comments, case and literals", () => {
    const variants = [
      "SELECT * FROM T WHERE A = 'x' AND B = 42",
      "select *\nfrom T -- note\nwhere a = 'y' and b = 7",
      "SELECT /* block */ * FROM T WHERE A = 'z' AND B = 3.5e2",
    ];
    const normalized = variants.map(normalizeSqlForFingerprint);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("SELECT * FROM T WHERE A = ? AND B = ?");
  });

  it("keeps quoted identifier bytes and treats alias rename as a distinct statement", () => {
    expect(normalizeSqlForFingerprint('SELECT "Mixed Case" FROM T'))
      .toBe('SELECT "Mixed Case" FROM T');
    expect(normalizeSqlForFingerprint("SELECT A AS X FROM T"))
      .not.toBe(normalizeSqlForFingerprint("SELECT A AS Y FROM T"));
  });

  it("replaces typed date/time literals with one placeholder", () => {
    expect(normalizeSqlForFingerprint("SELECT * FROM T WHERE D = DATE '2024-01-01'"))
      .toBe("SELECT * FROM T WHERE D = ?");
    expect(normalizeSqlForFingerprint("SELECT * FROM T WHERE D = TIMESTAMP '2024-01-01 10:00:00'"))
      .toBe("SELECT * FROM T WHERE D = ?");
  });

  it("is stable enough to hash deterministically", () => {
    const fingerprint = createHash("sha256")
      .update("salt")
      .update(normalizeSqlForFingerprint("SELECT 1 FROM T"))
      .digest("hex");
    expect(fingerprint).toHaveLength(64);
  });

  it("does not treat comment markers inside literals or quoted identifiers as comments", () => {
    expect(normalizeSqlForFingerprint(
      "SELECT '--x', '/*y*/' FROM T",
    )).toBe("SELECT ?, ? FROM T");
    expect(normalizeSqlForFingerprint(
      'SELECT "--x", "/*y*/", [--z], `/*w*/` FROM T',
    )).toBe('SELECT "--x", "/*y*/", [--z], `/*w*/` FROM T');
  });

  it("does not treat quotes inside comments as literals", () => {
    expect(normalizeSqlForFingerprint("SELECT 1 -- 'unterminated"))
      .toBe("SELECT ?");
    expect(normalizeSqlForFingerprint("SELECT 1 /* 'unterminated */ + 2"))
      .toBe("SELECT ? + ?");
    expect(normalizeSqlForFingerprint("SELECT 1 /* unterminated"))
      .toBe("SELECT ?");
    expect(normalizeSqlForFingerprint("SELECT 1 -- unterminated"))
      .toBe("SELECT ?");
  });

  it("keeps doubled delimiters inside quoted identifiers byte-exact", () => {
    expect(normalizeSqlForFingerprint('SELECT "a""b" FROM T'))
      .toBe('SELECT "a""b" FROM T');
    expect(normalizeSqlForFingerprint("SELECT [a]]b] FROM T"))
      .toBe("SELECT [a]]b] FROM T");
    expect(normalizeSqlForFingerprint("SELECT `a``b` FROM T"))
      .toBe("SELECT `a``b` FROM T");
  });

  it("is deterministic for unterminated quoted tokens", () => {
    expect(normalizeSqlForFingerprint("SELECT 'abc"))
      .toBe("SELECT ?");
    expect(normalizeSqlForFingerprint('SELECT "abc'))
      .toBe('SELECT "abc');
    expect(normalizeSqlForFingerprint("SELECT [abc"))
      .toBe("SELECT [abc");
    expect(normalizeSqlForFingerprint("SELECT `abc"))
      .toBe("SELECT `abc");
  });

  it("collapses every Netezza typed literal form", () => {
    const variants = [
      "SELECT DATE '2024-01-01'",
      "SELECT TIME '10:00:00'",
      "SELECT TIMESTAMP '2024-01-01 10:00:00'",
      "SELECT INTERVAL '1 day'",
      "SELECT N'text'",
      "SELECT E'text'",
      "SELECT X'AB'",
      "SELECT B'101'",
    ];
    for (const variant of variants) {
      expect(normalizeSqlForFingerprint(variant)).toBe("SELECT ?");
    }
  });

  it("collapses radix and dollar-quoted literals across dialects", () => {
    expect(normalizeSqlForFingerprint(
      "SELECT 0x1F, 0x2F, 0b101, 0b111",
    )).toBe("SELECT ?, ?, ?, ?");
    expect(normalizeSqlForFingerprint(
      "SELECT $$a'b$$, $tag$--x$tag$",
    )).toBe("SELECT ?, ?");
    // An unclosed tag is not guessed as a dollar quote.
    expect(normalizeSqlForFingerprint("SELECT $tag$"))
      .toBe("SELECT $TAG$");
  });
});
