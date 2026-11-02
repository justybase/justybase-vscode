jest.unmock("chevrotain");

import {
  canonicalizeRelation,
  JoinKnowledgeStore,
  objectRefKey,
  type JoinKnowledgeState,
  type JoinRelationOverride,
  type ObjectPreferenceOverride,
  type WorkspaceIndexSnapshot,
  type WorkspaceObjectSnapshot,
  type WorkspaceRelationSnapshot,
} from "@justybase/sql-core/joinKnowledge";
import { readJoinKnowledgeManagerFocus } from "../../contracts/joinKnowledgeManager";
import { JoinKnowledgeService } from "../../knowledge/joinKnowledgeService";
import {
  buildManagerState,
  JoinKnowledgeManagerView,
  nextRelationScoreAdjustment,
  parseConfiguredRelations,
  RELATION_SCORE_ADJUSTMENT_LIMIT,
  validateManagerMessage,
} from "../../views/joinKnowledgeManagerView";

function relation(input: {
  left: string;
  right: string;
  leftColumn?: string;
  rightColumn?: string;
}) {
  const canonical = canonicalizeRelation(
    {
      left: { table: input.left },
      right: { table: input.right },
      columns: [{
        left: input.leftColumn ?? "ID",
        right: input.rightColumn ?? "PARENT_ID",
      }],
    },
    "netezza",
  );
  if (!canonical) {
    throw new Error("fixture relation is invalid");
  }
  return canonical;
}

function relationOverride(
  id: string,
  kind: JoinRelationOverride["kind"],
  identity = relation({ left: "USERS", right: "ORDERS", leftColumn: "USER_ID", rightColumn: "OWNER_ID" }),
  createdAt = "2026-10-25T10:00:00.000Z",
): JoinRelationOverride {
  return {
    id,
    relationKey: identity.key,
    kind,
    relation: identity,
    createdAt,
  };
}

function workspaceRelation(
  left: string,
  right: string,
  options: {
    belowThreshold?: boolean;
    files?: number;
    queries?: number;
    acceptedSelections?: number;
    leftColumn?: string;
    rightColumn?: string;
  } = {},
): WorkspaceRelationSnapshot {
  const identity = relation({
    left,
    right,
    leftColumn: options.leftColumn,
    rightColumn: options.rightColumn,
  });
  return {
    key: identity.key,
    relation: identity,
    observations: options.files ?? 2,
    distinctFiles: options.files ?? 2,
    distinctQueries: options.queries ?? 2,
    ...(options.acceptedSelections !== undefined
      ? {
          acceptedSelections: options.acceptedSelections,
          weightedQueries: (options.queries ?? 2) + options.acceptedSelections * 0.5,
        }
      : {}),
    belowThreshold: options.belowThreshold === true,
    firstSeenAt: "2026-10-25T09:00:00.000Z",
    lastSeenAt: "2026-10-25T10:00:00.000Z",
  };
}

function workspaceObject(
  name: string,
  options: { belowThreshold?: boolean; band?: number; select?: number } = {},
): WorkspaceObjectSnapshot {
  return {
    key: `\u0000\u0000${name}`,
    object: { name },
    usage: { select: options.select ?? 3, insert: 0, update: 0, delete: 0 },
    distinctFiles: 2,
    distinctQueries: 2,
    belowThreshold: options.belowThreshold === true,
    ...(options.band !== undefined ? { band: options.band } : {}),
    firstSeenAt: "2026-10-25T09:00:00.000Z",
    lastSeenAt: "2026-10-25T10:00:00.000Z",
  };
}

function snapshot(input: {
  relations?: WorkspaceRelationSnapshot[];
  objects?: WorkspaceObjectSnapshot[];
}): WorkspaceIndexSnapshot {
  return {
    version: 1,
    relations: input.relations ?? [],
    objects: input.objects ?? [],
    truncated: false,
    generatedAt: "2026-10-25T10:00:00.000Z",
  };
}

describe("JOIN knowledge manager state", () => {
  it("combines configured, confirmed, favorite and workspace sources with canonical ranks", () => {
    const configured = [{
      left: { table: "CUSTOMERS" },
      right: { table: "ORDERS" },
      columns: [{ left: "CUSTOMER_ID", right: "CUSTOMER_ID" }],
    }];
    const confirmed = relationOverride("rel-confirm", "confirm");
    const favorite = relationOverride(
      "rel-fav",
      "favorite",
      relation({ left: "PRODUCTS", right: "SUPPLIERS" }),
    );
    const scoreOverride = {
      id: "score-confirmed",
      relationKey: confirmed.relationKey,
      relation: confirmed.relation,
      adjustment: 2,
      createdAt: "2026-10-25T10:00:00.000Z",
    };
    const state = buildManagerState({
      relationOverrides: [confirmed, favorite],
      relationScoreOverrides: [scoreOverride],
      objectOverrides: [],
      configured,
      workspaceSnapshot: snapshot({
        relations: [workspaceRelation("PRODUCTS", "ORDERS")],
      }),
      status: {
        enabled: true,
        running: false,
        filesSelected: 2,
        filesIndexed: 2,
        relations: { total: 1, eligible: 1, belowThreshold: 0 },
        objects: { total: 0, eligible: 0, belowThreshold: 0 },
        skipped: {},
        truncated: false,
        truncationReasons: [],
        git: { mode: "all", windowDays: 0, dirty: 0, untracked: 0, open: 0 },
      },
      personalizeEnabled: true,
    });

    const configuredRow = state.relations.find((row) => row.configured);
    expect(configuredRow?.tier).toBe("0_0_");
    expect(configuredRow?.rankLabel).toContain("0_0_");

    const confirmedRow = state.relations.find((row) => row.key === confirmed.relationKey);
    expect(confirmedRow?.decision).toBe("confirmed");
    expect(confirmedRow?.tier).toBe("0_1_");
    expect(confirmedRow?.sources.map((source) => source.kind)).toContain("confirmed");
    expect(confirmedRow?.scoreAdjustment).toBe(2);
    expect(confirmedRow?.overrideIds.score).toBe(scoreOverride.id);
    expect(confirmedRow?.rankLabel).toContain("+2");

    const favoriteRow = state.relations.find((row) => row.key === favorite.relationKey);
    expect(favoriteRow?.decision).toBe("favorite");
    expect(favoriteRow?.tier).toBe("0_3_");

    const workspaceRow = state.relations.find((row) =>
      row.tables.includes("PRODUCTS") && row.tables.includes("ORDERS"),
    );
    expect(workspaceRow?.tier).toBe("0_5_");
    expect(workspaceRow?.workspace?.distinctFiles).toBe(2);
    expect(workspaceRow?.sources.map((source) => source.kind)).toContain("workspace");
    expect(workspaceRow?.explanation.join(" ")).toContain("eligible");

    expect(state.meta.counts.confirmed).toBe(1);
    expect(state.meta.counts.favorites).toBe(1);
    expect(state.meta.counts.relations).toBe(4);
    expect(state.meta.indexingEnabled).toBe(true);
  });

  it("keeps blocked rows out of ranking while retaining favorite history", () => {
    const identity = relation({ left: "USERS", right: "ORDERS" });
    const favorite = relationOverride("rel-fav", "favorite", identity, "2026-10-25T10:00:00.000Z");
    const block = relationOverride("rel-block", "block", identity, "2026-10-25T10:05:00.000Z");
    const state = buildManagerState({
      relationOverrides: [favorite, block],
      objectOverrides: [],
      configured: [],
      workspaceSnapshot: snapshot({
        relations: [workspaceRelation("USERS", "ORDERS")],
      }),
      personalizeEnabled: true,
    });
    const row = state.relations.find((entry) => entry.key === identity.key);
    expect(row?.decision).toBe("blocked");
    expect(row?.favorite).toBe(false);
    expect(row?.tier).toBe("blocked");
    expect(row?.rankLabel).toContain("Blocked");
    expect(row?.overrideIds.block).toBe("rel-block");
    expect(row?.overrideIds.favorite).toBe("rel-fav");
    expect(state.meta.counts.blocked).toBe(1);
    expect(state.meta.counts.favorites).toBe(0);
  });

  it("marks below-threshold workspace relations and objects explicitly", () => {
    const state = buildManagerState({
      relationOverrides: [],
      objectOverrides: [],
      configured: [],
      workspaceSnapshot: snapshot({
        relations: [workspaceRelation("A", "B", { belowThreshold: true, files: 1, queries: 1 })],
        objects: [workspaceObject("SINGLE", { belowThreshold: true, select: 1 })],
      }),
      personalizeEnabled: true,
    });

    expect(state.relations[0].tier).toBe("below");
    expect(state.relations[0].rankLabel).toContain("Below threshold");
    expect(state.relations[0].workspace?.belowThreshold).toBe(true);
    expect(state.objects[0].kind).toBe("neutral");
    expect(state.objects[0].rankLabel).toContain("Below threshold");
  });

  it("shows accepted selections and their half-weight in the manager", () => {
    const state = buildManagerState({
      relationOverrides: [],
      objectOverrides: [],
      configured: [],
      workspaceSnapshot: snapshot({
        relations: [workspaceRelation("A", "B", {
          files: 0,
          queries: 0,
          acceptedSelections: 6,
        })],
      }),
      personalizeEnabled: true,
    });
    expect(state.relations[0].workspace).toMatchObject({
      acceptedSelections: 6,
      weightedQueries: 3,
    });
    expect(state.relations[0].explanation.join(" ")).toContain("6 accepted selection(s)");
  });

  it("renders object pin, boost and exclude decisions with their bands", () => {
    const objectOverride = (
      id: string,
      kind: ObjectPreferenceOverride["kind"],
      extra: Partial<ObjectPreferenceOverride> = {},
    ): ObjectPreferenceOverride => ({
      id,
      objectKey: "\u0000\u0000CUSTOMERS",
      object: { name: "CUSTOMERS" },
      kind,
      createdAt: "2026-10-25T10:00:00.000Z",
      ...extra,
    });
    const state = buildManagerState({
      relationOverrides: [],
      objectOverrides: [
        objectOverride("pin-1", "pin", { pinOrder: 3 }),
        objectOverride("boost-1", "boost", { band: 7, objectKey: "\u0000\u0000PRODUCTS", object: { name: "PRODUCTS" } }),
        objectOverride("exclude-1", "exclude", { objectKey: "\u0000\u0000BAD", object: { name: "BAD" } }),
      ],
      configured: [],
      workspaceSnapshot: snapshot({
        objects: [
          workspaceObject("CUSTOMERS"),
          workspaceObject("LEARNED", { band: 12, select: 5 }),
        ],
      }),
      personalizeEnabled: true,
    });
    const pin = state.objects.find((row) => row.kind === "pin");
    expect(pin?.rankLabel).toContain("Pinned at 3");
    const boost = state.objects.find((row) => row.kind === "boost");
    expect(boost?.rankLabel).toContain("band 07");
    const exclude = state.objects.find((row) => row.kind === "exclude");
    expect(exclude?.rankLabel).toContain("Excluded");
    const learned = state.objects.find((row) => row.label === "LEARNED");
    expect(learned?.kind).toBe("learned");
    expect(learned?.band).toBe(12);
    expect(state.meta.counts.pinned).toBe(1);
    expect(state.meta.counts.excluded).toBe(1);
  });

  it("retains a score-only relation so it can be found without a suggestion source", () => {
    const identity = relation({
      left: "ARCHIVE",
      right: "AUDIT",
      leftColumn: "ARCHIVE_ID",
      rightColumn: "ARCHIVE_ID",
    });
    const state = buildManagerState({
      relationOverrides: [],
      relationScoreOverrides: [
        {
          id: "score-old",
          relationKey: identity.key,
          relation: identity,
          adjustment: 1,
          createdAt: "2026-10-25T09:00:00.000Z",
          revertedAt: "2026-10-25T09:30:00.000Z",
        },
        {
          id: "score-active",
          relationKey: identity.key,
          relation: identity,
          adjustment: -2,
          createdAt: "2026-10-25T10:00:00.000Z",
        },
      ],
      objectOverrides: [],
      configured: [],
      personalizeEnabled: true,
    });

    const row = state.relations.find((entry) => entry.key === identity.key);
    expect(row).toMatchObject({
      scoreAdjustment: -2,
      tier: "below",
      configured: false,
    });
    expect(row?.overrideIds.score).toBe("score-active");
    expect(row?.rankLabel).toContain("score retained");
    expect(row?.explanation.join(" ")).toContain("user score adjustment: -2");
  });

  it("renders eligible executed relations and objects without creating overrides", () => {
    const identity = relation({
      left: "USERS",
      right: "ORDERS",
      leftColumn: "USER_ID",
      rightColumn: "OWNER_ID",
    });
    const object = { name: "ORDERS" };
    const store = new JoinKnowledgeStore();
    for (const day of ["2026-10-25", "2026-10-26"]) {
      store.recordExecutedStatement({
        executionKey: `exec-${day}`,
        databaseKind: "netezza",
        relations: [identity],
        objects: [{ object, kind: "select" }],
        now: `${day}T10:00:00.000Z`,
      });
    }
    const state = buildManagerState({
      relationOverrides: [],
      objectOverrides: [],
      executedSnapshot: store.buildSnapshot().executed,
      configured: [],
      execution: {
        relations: 1,
        relationsBelowThreshold: 0,
        objects: 1,
        objectsBelowThreshold: 0,
        truncated: false,
        observed: 2,
        recorded: 2,
        duplicates: 0,
        notDurable: 0,
        skipped: {},
      },
      personalizeEnabled: true,
    });

    const relationRow = state.relations.find((entry) => entry.key === identity.key);
    expect(relationRow).toMatchObject({
      tier: "0_4_",
      decision: "none",
      executed: {
        observations: 2,
        distinctDays: 2,
        belowThreshold: false,
      },
    });
    expect(relationRow?.sources.some((source) => source.kind === "executed")).toBe(true);
    expect(relationRow?.explanation.join(" ")).toContain("not semantic confirmation");
    expect(state.relations.filter((entry) => entry.decision !== "none")).toHaveLength(0);

    const objectRow = state.objects.find((entry) => entry.name === "ORDERS");
    expect(objectRow).toMatchObject({
      kind: "learned",
      executed: {
        observations: 2,
        distinctDays: 2,
        usage: { select: 2, insert: 0, update: 0, delete: 0 },
        belowThreshold: false,
      },
    });
    expect(state.meta.execution).toMatchObject({
      relations: 1,
      objects: 1,
      observed: 2,
      recorded: 2,
      notDurable: 0,
    });
  });

  it("bounds score steps and rejects unknown webview actions", () => {
    expect(nextRelationScoreAdjustment(0, "increase")).toBe(1);
    expect(nextRelationScoreAdjustment(0, "decrease")).toBe(-1);
    expect(nextRelationScoreAdjustment(RELATION_SCORE_ADJUSTMENT_LIMIT, "increase"))
      .toBe(RELATION_SCORE_ADJUSTMENT_LIMIT);
    expect(nextRelationScoreAdjustment(-RELATION_SCORE_ADJUSTMENT_LIMIT, "decrease"))
      .toBe(-RELATION_SCORE_ADJUSTMENT_LIMIT);
    expect(nextRelationScoreAdjustment(4, "reset")).toBe(0);
    expect(nextRelationScoreAdjustment(Number.NaN, "increase")).toBe(1);
    expect(nextRelationScoreAdjustment(2, "explode")).toBeUndefined();
    expect(nextRelationScoreAdjustment(2, undefined)).toBeUndefined();
  });

  it("rejects unknown or malformed webview messages before any mutation", () => {
    expect(validateManagerMessage(undefined)).toBeDefined();
    expect(validateManagerMessage({ type: "relationAction", action: "explode", key: "k" }))
      .toContain("relation action");
    expect(validateManagerMessage({ type: "relationAction", action: "favorite", key: " " }))
      .toContain("relation key");
    expect(validateManagerMessage({ type: "relationScoreAction", action: "explode", key: "k" }))
      .toContain("ranking action");
    expect(validateManagerMessage({ type: "objectAction", action: "explode", key: "k" }))
      .toContain("object action");
    expect(validateManagerMessage({ type: "revert", kind: "explode", id: "k" }))
      .toContain("revert kind");
    expect(validateManagerMessage({ type: "deleteEvidence", kind: "explode", key: "k" }))
      .toContain("evidence kind");
    expect(validateManagerMessage({ type: "deleteAcceptedEvidence", key: "" }))
      .toContain("relation key");
    expect(validateManagerMessage({ type: "clearExecutedEvidence", kind: "explode", key: "k" }))
      .toContain("executed-evidence kind");
    expect(validateManagerMessage({ type: "clearExecutedEvidence", kind: "relation", key: "" }))
      .toContain("executed-evidence key");
    expect(validateManagerMessage({ type: "bulk", action: "explode", keys: ["k"] }))
      .toContain("bulk action");
    expect(validateManagerMessage({ type: "bulk", action: "exclude", keys: [] }))
      .toContain("Bulk keys");
    expect(validateManagerMessage({ type: "saveManualRelation", relation: "x" }))
      .toContain("manual relation");
    expect(validateManagerMessage({ type: "removeManualRelation", key: "" }))
      .toContain("relation key");
    expect(validateManagerMessage({ type: "unknown" })).toContain("Unknown");

    for (const valid of [
      { type: "ready" },
      { type: "refresh" },
      { type: "relationAction", action: "confirm", key: "k" },
      { type: "relationScoreAction", action: "reset", key: "k" },
      { type: "objectAction", action: "exclude", key: "k" },
      { type: "revert", kind: "manual", id: "manual" },
      { type: "deleteEvidence", kind: "relation", key: "k" },
      { type: "deleteAcceptedEvidence", key: "k" },
      { type: "clearExecutedEvidence", kind: "relation", key: "k" },
      { type: "clearAllExecutedEvidence" },
      { type: "bulk", action: "deleteEvidence", keys: ["k"] },
      { type: "saveManualRelation", relation: { leftTable: "A" } },
      { type: "removeManualRelation", key: "k" },
      { type: "rebuildIndex" },
      { type: "openSettings" },
    ]) {
      expect(validateManagerMessage(valid)).toBeUndefined();
    }
  });

  it("never maps an unknown action onto favorite, exclude or object revert", async () => {
    const emptyState: JoinKnowledgeState = {
      version: 1,
      relationOverrides: [],
      objectOverrides: [],
      relationEvidence: [],
      objectEvidence: [],
    };
    const service = new JoinKnowledgeService({
      load: async () => emptyState,
      save: async () => undefined,
    }, { now: () => "2026-10-25T10:00:00.000Z" });
    await service.initialize();
    const objectInput = {
      object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
      databaseKind: "netezza",
      band: 3,
    };
    await service.boostObject(objectInput);
    const boost = service.getObjectOverrides()[0];
    expect(boost.objectKey).toBe(objectRefKey({
      database: "BAZA",
      schema: "ADMIN",
      name: "ORDERS",
    }));
    await service.confirmRelation({
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      databaseKind: "netezza",
    });
    const confirmedKey = service.getRelationOverrides()[0].relationKey;

    const view = new JoinKnowledgeManagerView(
      undefined as never,
      () => service,
      () => undefined,
    );
    const handleMessage = (
      view as unknown as { handleMessage(message: unknown): Promise<void> }
    ).handleMessage.bind(view);

    await handleMessage({ type: "objectAction", action: "explode", key: boost.objectKey });
    expect(service.getObjectOverrides()).toHaveLength(1);
    expect(service.getObjectOverrides()[0]).toMatchObject({ kind: "boost", id: boost.id });

    await handleMessage({ type: "relationAction", action: "explode", key: confirmedKey });
    expect(service.getSnapshot().relations[0].decision).toBe("confirmed");
    expect(service.getSnapshot().relations[0].favorite).toBeUndefined();

    await handleMessage({ type: "revert", kind: "explode", id: boost.id });
    expect(service.getObjectOverrides()[0].revertedAt).toBeUndefined();
  });

  it("opens on a requested tab and filter once, and validates the request", async () => {
    const service = new JoinKnowledgeService({
      load: async () => ({ version: 1, relationOverrides: [], objectOverrides: [], relationEvidence: [], objectEvidence: [] }),
      save: async () => undefined,
    });
    await service.initialize();
    const view = new JoinKnowledgeManagerView(undefined as never, () => service, () => undefined);
    const postMessage = jest.fn(async () => true);
    (view as unknown as { panel: unknown }).panel = { reveal: jest.fn(), webview: { postMessage } };

    view.openInEditor({ tab: "objects", filter: "executed" });
    view.openInEditor();

    const messages = postMessage.mock.calls.map((call) => (call as unknown[])[0] as { type: string; focus?: unknown });
    expect(messages.map((message) => message.focus)).toEqual([{ tab: "objects", filter: "executed" }, undefined]);
    expect(readJoinKnowledgeManagerFocus({ tab: "objects", filter: "executed" })).toEqual({ tab: "objects", filter: "executed" });
    expect(readJoinKnowledgeManagerFocus({ tab: "objects", filter: "<script>" })).toBeUndefined();
    expect(readJoinKnowledgeManagerFocus("relations")).toBeUndefined();
  });

  it("keeps the stored dialect when a manager action changes a non-Netezza relation", async () => {
    const emptyState: JoinKnowledgeState = {
      version: 1,
      relationOverrides: [],
      objectOverrides: [],
      relationEvidence: [],
      objectEvidence: [],
    };
    const service = new JoinKnowledgeService({
      load: async () => emptyState,
      save: async () => undefined,
    }, { now: () => "2026-10-25T10:00:00.000Z" });
    await service.initialize();
    const postgresRelation = {
      left: { database: "BAZA", schema: "public", table: "users" },
      right: { database: "BAZA", schema: "public", table: "orders" },
      columns: [{ left: "owner_id", right: "id" }],
      databaseKind: "postgresql",
    };
    await service.favoriteRelation(postgresRelation);
    const relationKey = service.getRelationOverrides()[0].relationKey;
    expect(service.getRelationOverrides()[0].databaseKind).toBe("postgresql");

    const view = new JoinKnowledgeManagerView(
      undefined as never,
      () => service,
      () => undefined,
    );
    const handleMessage = (
      view as unknown as { handleMessage(message: unknown): Promise<void> }
    ).handleMessage.bind(view);

    await handleMessage({
      type: "relationScoreAction",
      action: "increase",
      key: relationKey,
    });
    expect(service.getRelationScoreOverrides()).toMatchObject([{
      relationKey,
      databaseKind: "postgresql",
      adjustment: 1,
    }]);

    await handleMessage({ type: "relationAction", action: "confirm", key: relationKey });
    const overrides = service.getRelationOverrides();
    expect(overrides).toHaveLength(2);
    expect(overrides[1]).toMatchObject({
      relationKey,
      kind: "confirm",
      databaseKind: "postgresql",
    });
    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(service.getSnapshot().relations[0]).toMatchObject({
      key: relationKey,
      decision: "confirmed",
    });
  });

  it("parses configured relations defensively", () => {
    expect(parseConfiguredRelations(undefined)).toEqual([]);
    expect(parseConfiguredRelations([{ left: { table: "" } }])).toEqual([]);
    expect(parseConfiguredRelations([{
      left: { database: "PROD", schema: "ADMIN", table: "USERS" },
      right: { table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }, { left: "", right: "X" }],
    }])).toEqual([{
      left: { database: "PROD", schema: "ADMIN", table: "USERS" },
      right: { table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    }]);
  });
});
