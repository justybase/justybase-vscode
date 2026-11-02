import { describe, expect, it } from "@jest/globals";
import {
  aggregateWorkspaceIndex,
  buildJoinKnowledgeIndex,
  canonicalizeRelation,
  createWorkspaceIndexSnapshot,
  diffWorkspaceIndex,
  getJoinTierScore,
  JOIN_TARGET_TIERS,
  JoinKnowledgeStore,
  mergeJoinKnowledgeIndexDelta,
  objectBandForUsage,
  OBJECT_BANDS,
  OBJECT_RANKING_MODEL,
  resolveJoinTargetTier,
  type ObjectUsageKind,
  type WorkspaceFileIndexRecord,
  type WorkspaceFileRelationContribution,
} from "../src/joinKnowledge";

const now = "2026-10-25T10:00:00.000Z";

function relation(
  left: string,
  right: string,
  columns: Array<[string, string]> = [["ID", "PARENT_ID"]],
) {
  const canonical = canonicalizeRelation(
    {
      left: { database: "BAZA", schema: "ADMIN", table: left },
      right: { database: "BAZA", schema: "ADMIN", table: right },
      columns: columns.map(([leftColumn, rightColumn]) => ({
        left: leftColumn,
        right: rightColumn,
      })),
    },
    "netezza",
  );
  if (!canonical) {
    throw new Error("test relation is not canonical");
  }
  return canonical;
}

function file(
  relPath: string,
  relations: WorkspaceFileRelationContribution[],
  objects: Array<{
    name: string;
    kind: ObjectUsageKind;
    fingerprint: string;
  }> = [],
): WorkspaceFileIndexRecord {
  return {
    relPath,
    size: 100,
    mtimeMs: Date.parse(now),
    contentHash: `hash-${relPath}`,
    dirty: false,
    open: false,
    fingerprints: [...new Set(relations.map((entry) => entry.fingerprint))],
    relations,
    objects: objects.map((entry) => ({
      object: { database: "BAZA", schema: "ADMIN", name: entry.name },
      kind: entry.kind,
      fingerprint: entry.fingerprint,
      confidence: "exact",
    })),
    skipped: {},
  };
}

describe("favorite preference", () => {
  it("ranks in the shared 0_3_ preference band, below FK and above workspace", () => {
    const result = resolveJoinTargetTier({ favorite: true });
    expect(result.ranked).toBe(true);
    if (result.ranked) {
      expect(result.source).toBe("favorite");
      expect(result.tier).toBe(JOIN_TARGET_TIERS.favorite);
      expect(JOIN_TARGET_TIERS.favorite).toBe("0_3_");
    }
    expect(getJoinTierScore("favorite")).toBe(0);
    expect(JOIN_TARGET_TIERS.catalogFk < JOIN_TARGET_TIERS.favorite).toBe(true);
    expect(JOIN_TARGET_TIERS.favorite < JOIN_TARGET_TIERS.workspace).toBe(true);
  });

  it("is suppressed by confirmation and removed by a block", () => {
    const confirmed = resolveJoinTargetTier({ confirmed: true, favorite: true });
    expect(confirmed.ranked).toBe(true);
    if (confirmed.ranked) {
      expect(confirmed.source).toBe("confirmed");
      expect(confirmed.suppressed).toContain("favorite");
    }
    expect(resolveJoinTargetTier({ blocked: true, favorite: true })).toEqual({
      ranked: false,
      reason: "blocked",
      suppressed: [],
    });
  });

  it("survives a block revert and never becomes a confirmation", () => {
    const store = new JoinKnowledgeStore();
    const input = {
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now,
    };
    const favorite = store.appendRelationOverride({
      ...input,
      kind: "favorite",
      id: "favorite-1",
    });
    expect(store.getRelationDecision(favorite.relationKey)).toBe("favorite");
    expect(store.buildSnapshot().relations[0]).toMatchObject({
      decision: "favorite",
      favorite: true,
    });

    const block = store.appendRelationOverride({
      ...input,
      kind: "block",
      id: "block-1",
    });
    expect(store.getRelationDecision(block.relationKey)).toBe("blocked");
    expect(store.getActiveFavorite(block.relationKey)?.id).toBe("favorite-1");

    expect(store.revertRelationOverride(block.id, now)).toBe(true);
    expect(store.getRelationDecision(block.relationKey)).toBe("favorite");
  });

  it("keeps a favorite alongside confirmation and restores it on confirmation revert", () => {
    const store = new JoinKnowledgeStore();
    const input = {
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now,
    };
    const favorite = store.appendRelationOverride({
      ...input,
      kind: "favorite",
      id: "favorite-1",
    });
    const confirmation = store.appendRelationOverride({
      ...input,
      kind: "confirm",
      id: "confirm-1",
    });
    expect(store.buildSnapshot().relations).toHaveLength(1);
    expect(store.buildSnapshot().relations[0]).toMatchObject({
      decision: "confirmed",
      favorite: true,
    });
    expect(store.getActiveFavorite(favorite.relationKey)?.id).toBe("favorite-1");

    expect(store.revertRelationOverride(confirmation.id, now)).toBe(true);
    expect(store.getRelationDecision(favorite.relationKey)).toBe("favorite");
  });

  it("exposes favorites to the completion index only when not blocked", () => {
    const store = new JoinKnowledgeStore();
    const input = {
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now,
    };
    store.appendRelationOverride({ ...input, kind: "favorite", id: "favorite-1" });
    const index = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect([...index.favoriteRelations.keys()]).toHaveLength(1);

    store.appendRelationOverride({ ...input, kind: "block", id: "block-1" });
    const blocked = buildJoinKnowledgeIndex(store.buildSnapshot());
    expect(blocked.favoriteRelations.size).toBe(0);
  });
});

describe("workspace aggregation", () => {
  it("merges the same composite relation from opposite directions into one key", () => {
    const forward = relation("USERS", "ORDERS", [
      ["USER_ID", "OWNER_ID"],
      ["TENANT_ID", "TENANT_ID"],
    ]);
    const reverse = relation("ORDERS", "USERS", [
      ["OWNER_ID", "USER_ID"],
      ["TENANT_ID", "TENANT_ID"],
    ]);
    expect(forward.key).toBe(reverse.key);

    const aggregate = aggregateWorkspaceIndex([
      file("a.sql", [{ relation: forward, fingerprint: "q1" }]),
      file("b.sql", [{ relation: reverse, fingerprint: "q2" }]),
    ], { now });

    expect(aggregate.relations).toHaveLength(1);
    expect(aggregate.relations[0]).toMatchObject({
      distinctFiles: 2,
      distinctQueries: 2,
      belowThreshold: false,
    });
    expect(aggregate.relations[0].relation.display.left.table).toBe("ORDERS");
    expect(aggregate.relations[0].relation.display.right.table).toBe("USERS");
  });

  it("requires two files or three independent queries", () => {
    const oneObservation = aggregateWorkspaceIndex([
      file("a.sql", [{ relation: relation("USERS", "ORDERS"), fingerprint: "q1" }]),
    ], { now });
    expect(oneObservation.relations[0].belowThreshold).toBe(true);

    const threeQueries = aggregateWorkspaceIndex([
      file("a.sql", [
        { relation: relation("USERS", "ORDERS"), fingerprint: "q1" },
        { relation: relation("USERS", "ORDERS"), fingerprint: "q2" },
        { relation: relation("USERS", "ORDERS"), fingerprint: "q3" },
      ]),
    ], { now });
    expect(threeQueries.relations[0]).toMatchObject({
      distinctFiles: 1,
      distinctQueries: 3,
      belowThreshold: false,
    });
  });

  it("computes per-kind object usage and respects best-band caps", () => {
    const broad = aggregateWorkspaceIndex([
      file("a.sql", [], [
        { name: "USERS", kind: "select", fingerprint: "q1" },
        { name: "USERS", kind: "select", fingerprint: "q2" },
        { name: "USERS", kind: "insert", fingerprint: "q3" },
      ]),
      file("b.sql", [], [
        { name: "USERS", kind: "select", fingerprint: "q4" },
        { name: "USERS", kind: "update", fingerprint: "q5" },
      ]),
      file("c.sql", [], [
        { name: "USERS", kind: "delete", fingerprint: "q6" },
      ]),
    ], { now });
    expect(broad.objects).toHaveLength(1);
    expect(broad.objects[0].usage).toEqual({
      select: 3,
      insert: 1,
      update: 1,
      delete: 1,
    });
    // Three files and six queries: learned, but far from the saturated cap.
    expect(broad.objects[0].band).toBeGreaterThan(OBJECT_BANDS.learnedMin);
    expect(broad.objects[0].band).toBeLessThan(OBJECT_BANDS.learnedMax);
    expect(broad.objects[0].belowThreshold).toBe(false);

    const insertOnly = objectBandForUsage({ insert: 5 }, 16, 32);
    const updateOnly = objectBandForUsage({ update: 5 }, 16, 32);
    const deleteOnly = objectBandForUsage({ delete: 5 }, 16, 32);
    expect(insertOnly).toBe(OBJECT_RANKING_MODEL.bestBandCaps.insert);
    expect(updateOnly).toBe(OBJECT_RANKING_MODEL.bestBandCaps.update);
    expect(deleteOnly).toBe(OBJECT_RANKING_MODEL.bestBandCaps.delete);
    expect(objectBandForUsage({ select: 1 }, 1, 1)).toBeUndefined();
  });

  it("keeps separating objects above the old 4-file saturation point", () => {
    const bands = [[3, 3], [4, 7], [9, 12], [16, 32]].map(([files, queries]) =>
      objectBandForUsage({ select: queries }, files, queries));
    expect(bands).toEqual([...bands].sort((left, right) => (right ?? 0) - (left ?? 0)));
    expect(new Set(bands).size).toBe(bands.length);
    expect(bands[3]).toBe(OBJECT_RANKING_MODEL.bestBandCaps.select);
  });

  it("is deterministic and diffs affected keys for incremental publication", () => {
    const usersOrders = relation("USERS", "ORDERS");
    const first = aggregateWorkspaceIndex([
      file("b.sql", [{ relation: usersOrders, fingerprint: "q2" }]),
      file("a.sql", [{ relation: usersOrders, fingerprint: "q1" }]),
    ], { now });
    const second = aggregateWorkspaceIndex([
      file("b.sql", [{ relation: usersOrders, fingerprint: "q2" }]),
      file("a.sql", [{ relation: usersOrders, fingerprint: "q1" }]),
    ], { now });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const next = aggregateWorkspaceIndex([
      file("b.sql", [{ relation: usersOrders, fingerprint: "q2" }]),
    ], { now });
    const delta = diffWorkspaceIndex(first, next, {
      generatedAt: now,
      truncated: false,
    });
    expect(delta.relationsUpsert).toHaveLength(1);
    expect(delta.relationsUpsert[0].distinctFiles).toBe(1);
    expect(delta.relationsRemove).toEqual([]);

    const empty = aggregateWorkspaceIndex([], { now });
    const removal = diffWorkspaceIndex(next, empty, {
      generatedAt: now,
      truncated: false,
    });
    expect(removal.relationsRemove).toHaveLength(1);
  });

  it("merges an incremental delta without touching manual decisions", () => {
    const store = new JoinKnowledgeStore();
    const input = {
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now,
    };
    store.appendRelationOverride({ ...input, kind: "confirm", id: "confirm-1" });
    const snapshot = store.buildSnapshot();
    const aggregate = aggregateWorkspaceIndex([
      file("a.sql", [{ relation: relation("USERS", "ORDERS"), fingerprint: "q1" }]),
      file("b.sql", [{ relation: relation("USERS", "ORDERS"), fingerprint: "q2" }]),
    ], { now });
    const workspace = createWorkspaceIndexSnapshot(aggregate, {
      generatedAt: now,
      truncated: false,
    });
    const merged = mergeJoinKnowledgeIndexDelta(
      { ...snapshot, workspace },
      {
        version: 1,
        relationsUpsert: [],
        relationsRemove: [aggregate.relations[0].key],
        objectsUpsert: [],
        objectsRemove: [],
      },
    );
    expect(merged.relations).toHaveLength(1);
    expect(merged.relations[0].decision).toBe("confirmed");
    expect(merged.workspace?.relations).toEqual([]);

    const index = buildJoinKnowledgeIndex(merged);
    expect(index.confirmedRelations.size).toBe(1);
    expect(index.workspaceRelations.size).toBe(0);
  });

  it("preserves half-weight accepted evidence across workspace index deltas", () => {
    const aggregate = aggregateWorkspaceIndex([
      file("a.sql", [{ relation: relation("USERS", "ORDERS"), fingerprint: "q1" }]),
    ], { now });
    const workspace = createWorkspaceIndexSnapshot(aggregate, {
      generatedAt: now,
      truncated: false,
    });
    const accepted = {
      ...workspace.relations[0],
      acceptedSelections: 4,
      weightedQueries: 3,
      belowThreshold: false,
    };
    const snapshot = {
      version: 1 as const,
      relations: [],
      objectPreferences: [],
      workspace: { ...workspace, relations: [accepted] },
    };
    const updated = mergeJoinKnowledgeIndexDelta(snapshot, {
      version: 1,
      relationsUpsert: [{
        ...workspace.relations[0],
        distinctQueries: 2,
        belowThreshold: true,
      }],
      relationsRemove: [],
      objectsUpsert: [],
      objectsRemove: [],
    });
    expect(updated.workspace?.relations[0]).toMatchObject({
      distinctQueries: 2,
      acceptedSelections: 4,
      weightedQueries: 4,
      belowThreshold: false,
    });

    const removed = mergeJoinKnowledgeIndexDelta(updated, {
      version: 1,
      relationsUpsert: [],
      relationsRemove: [accepted.key],
      objectsUpsert: [],
      objectsRemove: [],
    });
    expect(removed.workspace?.relations[0]).toMatchObject({
      distinctFiles: 0,
      distinctQueries: 0,
      acceptedSelections: 4,
      weightedQueries: 2,
      belowThreshold: true,
    });
  });
});
