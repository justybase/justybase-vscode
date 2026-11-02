import {
  applyJoinKnowledgeImport,
  buildJoinKnowledgeExport,
  diffJoinKnowledgeImport,
  JoinKnowledgeStore,
  JOIN_KNOWLEDGE_EXPORT_FORMAT,
  parseJoinKnowledgeImport,
  serializeJoinKnowledgeExport,
} from "../src/joinKnowledge";

const NOW = "2026-10-26T12:00:00.000Z";
const LATER = "2026-10-27T08:00:00.000Z";

const usersOrders = {
  left: { database: "DWH", schema: "ADMIN", table: "USERS" },
  right: { database: "DWH", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "OWNER_ID" }],
};
const ordersItems = {
  left: { database: "DWH", schema: "ADMIN", table: "ORDERS" },
  right: { database: "DWH", schema: "ADMIN", table: "ORDER_ITEMS" },
  columns: [{ left: "ORDER_ID", right: "ORDER_ID" }],
};

function populatedStore(): JoinKnowledgeStore {
  const store = new JoinKnowledgeStore();
  store.appendRelationOverride({ kind: "confirm", relation: usersOrders, databaseKind: "netezza", now: NOW, id: "c1" });
  store.appendRelationOverride({ kind: "favorite", relation: ordersItems, databaseKind: "netezza", now: NOW, id: "f1" });
  store.appendRelationScoreOverride({ relation: ordersItems, databaseKind: "netezza", adjustment: 2, now: NOW, id: "s1" });
  store.appendObjectPreference({
    kind: "pin",
    object: { database: "DWH", schema: "ADMIN", name: "ORDERS" },
    databaseKind: "netezza",
    pinOrder: 1,
    now: NOW,
    id: "p1",
  });
  store.appendObjectPreference({
    kind: "boost",
    object: { database: "DWH", schema: "ADMIN", name: "CUSTOMERS" },
    databaseKind: "netezza",
    band: 3,
    now: NOW,
    id: "b1",
  });
  // A reverted decision and all observed evidence must never be exported.
  store.appendRelationOverride({ kind: "block", relation: ordersItems, databaseKind: "netezza", now: NOW, id: "x1" });
  store.revertRelationOverride("x1", NOW);
  store.recordExecutedStatement({
    executionKey: "exec-secret-key:0",
    databaseKind: "netezza",
    relations: [],
    objects: [{ object: { name: "PAYMENTS" }, kind: "select" }],
    columns: [{ object: { name: "PAYMENTS" }, column: "CARD_NUMBER" }],
    now: NOW,
  });
  store.recordAcceptedObject({ object: { name: "ACCEPTED_ONLY" }, databaseKind: "netezza", now: NOW });
  return store;
}

describe("JOIN knowledge export", () => {
  it("contains active manual decisions only, asserted on the exact bytes", () => {
    const text = serializeJoinKnowledgeExport(buildJoinKnowledgeExport(populatedStore(), LATER));
    const document = JSON.parse(text);
    expect(document.format).toBe(JOIN_KNOWLEDGE_EXPORT_FORMAT);
    expect(document.relations.map((entry: { kind: string }) => entry.kind).sort()).toEqual(["confirm", "favorite"]);
    expect(document.scores).toHaveLength(1);
    expect(document.objects).toHaveLength(2);

    for (const forbidden of [
      "SELECT", "exec-secret-key", "PAYMENTS", "CARD_NUMBER", "ACCEPTED_ONLY",
      "\"id\"", "createdAt", "revertedAt", "replacedBy", "fingerprint", "salt",
      "executedEvents", "evidence", "\"key\"", "observations", "host",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("is deterministic for the same state", () => {
    const store = populatedStore();
    expect(serializeJoinKnowledgeExport(buildJoinKnowledgeExport(store, LATER)))
      .toBe(serializeJoinKnowledgeExport(buildJoinKnowledgeExport(store, LATER)));
  });
});

describe("JOIN knowledge import validation", () => {
  const valid = (): string => serializeJoinKnowledgeExport(buildJoinKnowledgeExport(populatedStore(), LATER));

  it("rejects an unknown version, another format and invalid JSON", () => {
    const document = JSON.parse(valid());
    expect(parseJoinKnowledgeImport(JSON.stringify({ ...document, version: 2 })))
      .toEqual({ ok: false, error: expect.stringContaining("Unsupported export version 2") });
    expect(parseJoinKnowledgeImport(JSON.stringify({ ...document, format: "other" })).ok).toBe(false);
    expect(parseJoinKnowledgeImport("{not json").ok).toBe(false);
  });

  it("rejects the whole file when one item is invalid", () => {
    const document = JSON.parse(valid());
    document.scores[0].adjustment = 9;
    expect(parseJoinKnowledgeImport(JSON.stringify(document)))
      .toEqual({ ok: false, error: "Score adjustment #1 is invalid." });
    const sameTable = JSON.parse(valid());
    sameTable.relations[0].relation.right = sameTable.relations[0].relation.left;
    expect(parseJoinKnowledgeImport(JSON.stringify(sameTable)).ok).toBe(false);
    const badBoost = JSON.parse(valid());
    badBoost.objects.find((entry: { kind: string }) => entry.kind === "boost").band = 40;
    expect(parseJoinKnowledgeImport(JSON.stringify(badBoost)).ok).toBe(false);
  });
});

describe("JOIN knowledge import", () => {
  function exported() {
    const parsed = parseJoinKnowledgeImport(
      serializeJoinKnowledgeExport(buildJoinKnowledgeExport(populatedStore(), LATER)),
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.document;
  }

  it("round-trips into a clean profile with the same ranking decisions", () => {
    const source = populatedStore();
    const target = new JoinKnowledgeStore();
    const result = applyJoinKnowledgeImport(target, exported(), { now: LATER });
    expect(result).toEqual({ added: 5, replaced: 0, keptLocal: 0, unchanged: 0 });
    const decisions = (store: JoinKnowledgeStore) => {
      const snapshot = store.buildSnapshot();
      const byKey = <T extends { key: string }>(items: T[]): T[] =>
        [...items].sort((left, right) => left.key.localeCompare(right.key));
      return {
        relations: byKey(snapshot.relations),
        objectPreferences: byKey(snapshot.objectPreferences),
        scores: snapshot.relationScoreOverrides?.map((entry) => [entry.relationKey, entry.adjustment]),
      };
    };
    expect(decisions(target)).toEqual(decisions(source));
    // Evidence never travels.
    expect(target.buildSnapshot().executed).toBeUndefined();
    expect(target.buildSnapshot().acceptedObjects).toBeUndefined();
    // Re-importing the same file is a no-op.
    expect(diffJoinKnowledgeImport(target, exported())).toMatchObject({ added: 0, conflicts: 0, unchanged: 5 });
  });

  it("keeps local decisions on conflict by default and never concatenates histories", () => {
    const target = new JoinKnowledgeStore();
    target.appendRelationOverride({ kind: "block", relation: usersOrders, databaseKind: "netezza", now: NOW, id: "local-block" });
    target.appendObjectPreference({
      kind: "demote",
      object: { database: "DWH", schema: "ADMIN", name: "ORDERS" },
      databaseKind: "netezza",
      now: NOW,
      id: "local-demote",
    });
    const diff = diffJoinKnowledgeImport(target, exported());
    expect(diff.conflicts).toBe(2);
    expect(diff.items.filter((item) => item.status === "conflict").map((item) => [item.local, item.imported]))
      .toEqual(expect.arrayContaining([["block", "confirm"], ["demote", "pin 1"]]));

    const result = applyJoinKnowledgeImport(target, exported(), { now: LATER });
    expect(result).toMatchObject({ added: 3, replaced: 0, keptLocal: 2 });
    expect(target.buildSnapshot().relations.find((entry) => entry.decision === "blocked")).toBeDefined();
    const imported = target.getRelationOverrides().filter((entry) => entry.id.startsWith("import-"));
    expect(imported.every((entry) => entry.createdAt === LATER)).toBe(true);
    expect(target.getRelationOverrides().some((entry) => entry.id === "c1")).toBe(false);
  });

  it("replaces conflicts with keep-import or per selected item", () => {
    const keepImport = new JoinKnowledgeStore();
    keepImport.appendRelationOverride({ kind: "block", relation: usersOrders, databaseKind: "netezza", now: NOW, id: "local-block" });
    expect(applyJoinKnowledgeImport(keepImport, exported(), { now: LATER, strategy: "keep-import" }))
      .toMatchObject({ replaced: 1, keptLocal: 0 });
    const localBlock = keepImport.getRelationOverrides().find((entry) => entry.id === "local-block");
    expect(localBlock?.revertedAt).toBe(LATER);
    expect(localBlock?.replacedBy).toMatch(/^import-/u);

    const perItem = new JoinKnowledgeStore();
    perItem.appendRelationOverride({ kind: "block", relation: usersOrders, databaseKind: "netezza", now: NOW, id: "local-block" });
    perItem.appendObjectPreference({
      kind: "demote",
      object: { database: "DWH", schema: "ADMIN", name: "ORDERS" },
      databaseKind: "netezza",
      now: NOW,
      id: "local-demote",
    });
    const objectConflict = diffJoinKnowledgeImport(perItem, exported()).items
      .find((item) => item.status === "conflict" && item.domain === "object");
    expect(applyJoinKnowledgeImport(perItem, exported(), {
      now: LATER,
      takeImported: new Set([objectConflict!.id]),
    })).toMatchObject({ replaced: 1, keptLocal: 1 });
    expect(perItem.getActiveObjectPreference("DWH\u0000ADMIN\u0000ORDERS")?.kind).toBe("pin");
    expect(perItem.buildSnapshot().relations.find((entry) => entry.decision === "blocked")).toBeDefined();
  });
});
