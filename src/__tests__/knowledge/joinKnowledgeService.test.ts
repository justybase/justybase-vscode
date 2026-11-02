import * as vscode from "vscode";
import {
  canonicalizeRelation,
  objectRefKey,
  type JoinKnowledgeState,
} from "@justybase/sql-core/joinKnowledge";
import {
  JoinKnowledgeService,
  type JoinKnowledgePersistence,
} from "../../knowledge/joinKnowledgeService";

jest.mock("vscode");

class MemoryPersistence implements JoinKnowledgePersistence {
  public state: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };
  public saves = 0;
  public failSave = false;

  async load(): Promise<JoinKnowledgeState> {
    return this.state;
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    if (this.failSave) {
      throw new Error("disk full");
    }
    this.state = state;
    this.saves += 1;
  }
}

const relation = {
  left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "OWNER_ID" }],
  databaseKind: "netezza",
};

const object = {
  object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
  databaseKind: "netezza",
};

describe("JoinKnowledgeService", () => {
  it("loads state, persists confirmations and emits once per mutation", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();
    const listener = jest.fn();
    service.onDidChange(listener);

    const id = await service.confirmRelation(relation);

    expect(id).toMatch(/^rel-/u);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(persistence.saves).toBe(1);
    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(service.getDiagnostics().relationOverrides.confirmed).toBe(1);
  });

  it("blocks a previously confirmed relation and keeps the history", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();
    const confirmId = await service.confirmRelation(relation);
    await service.blockRelation(relation);

    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(service.getSnapshot().relations[0].decision).toBe("blocked");
    expect(service.getRelationOverrides().find((entry) => entry.id === confirmId)?.replacedBy)
      .toBeDefined();
  });

  it("toggles a favorite without turning it into a confirmation", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    const first = await service.toggleFavoriteRelation(relation);
    expect(first).toMatchObject({
      favorited: true,
      blocked: false,
      confirmed: false,
    });
    expect(service.getSnapshot().relations[0]).toMatchObject({
      decision: "favorite",
      favorite: true,
    });
    expect(service.getDiagnostics().relationOverrides.favorites).toBe(1);

    const restarted = new JoinKnowledgeService(persistence);
    await restarted.initialize();
    expect(restarted.getSnapshot().relations[0]).toMatchObject({
      decision: "favorite",
      favorite: true,
    });

    const second = await restarted.toggleFavoriteRelation(relation);
    expect(second.favorited).toBe(false);
    expect(restarted.getSnapshot().relations).toHaveLength(0);
  });

  it("records each accepted JOIN as half-weight workspace evidence, not a favorite", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    await expect(service.recordAcceptedRelation(relation)).resolves.toBe(true);
    await expect(service.recordAcceptedRelation(relation)).resolves.toBe(true);
    expect(persistence.saves).toBe(2);
    expect(service.getSnapshot().relations).toHaveLength(0);
    expect(service.getRelationEvidence()[0]).toMatchObject({
      source: "accepted",
      observations: 2,
      belowThreshold: true,
    });
    expect(service.getDiagnostics().relationOverrides.favorites).toBe(0);
    for (let count = 2; count < 6; count += 1) {
      await service.recordAcceptedRelation(relation);
    }
    expect(service.getSnapshot().workspace?.relations[0]).toMatchObject({
      acceptedSelections: 6,
      weightedQueries: 3,
      belowThreshold: false,
    });
    expect(service.getSnapshot().relations).toHaveLength(0);
    const relationKey = service.getRelationEvidence()[0].relationKey;
    await expect(service.deleteAcceptedRelationEvidence(relationKey)).resolves.toBe(true);
    expect(service.getRelationEvidence()).toEqual([]);
    expect(service.getSnapshot().workspace?.relations ?? []).toEqual([]);
  });

  it("persists bounded manual within-tier relation score adjustments", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    const scoreId = await service.setRelationScoreAdjustment(relation, 2);
    expect(service.getRelationScoreOverrides()).toMatchObject([
      { id: scoreId, adjustment: 2 },
    ]);
    expect(service.getSnapshot().relationScoreOverrides).toMatchObject([
      { id: scoreId, adjustment: 2 },
    ]);
    await expect(service.setRelationScoreAdjustment(relation, 6))
      .rejects.toThrow(/integer from -5 to 5/u);
    expect(await service.revertRelationScoreOverride(scoreId)).toBe(true);
    expect(service.getSnapshot().relationScoreOverrides ?? []).toEqual([]);
  });

  it("keeps the canonicalizing dialect on score and accepted records for non-Netezza hosts", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();
    const postgresRelation = {
      left: { database: "BAZA", schema: "public", table: "users" },
      right: { database: "BAZA", schema: "public", table: "orders" },
      columns: [{ left: "owner_id", right: "id" }],
      databaseKind: "postgresql",
    };

    await service.setRelationScoreAdjustment(postgresRelation, 3);
    await service.recordAcceptedRelation(postgresRelation);

    expect(service.getRelationScoreOverrides()[0]).toMatchObject({
      adjustment: 3,
      databaseKind: "postgresql",
    });
    expect(service.getRelationEvidence()[0]).toMatchObject({
      source: "accepted",
      databaseKind: "postgresql",
    });
    expect(persistence.state.relationScoreOverrides?.[0].databaseKind).toBe("postgresql");
    expect(persistence.state.relationEvidence[0].databaseKind).toBe("postgresql");
  });

  it("persists a score across restart and resolves the reversed relation to the same key", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();
    const reversed = {
      left: relation.right,
      right: relation.left,
      columns: [{ left: "OWNER_ID", right: "USER_ID" }],
      databaseKind: "netezza",
    };
    const id = await service.setRelationScoreAdjustment(reversed, 3);
    const forwardKey = canonicalizeRelation(
      { left: relation.left, right: relation.right, columns: relation.columns },
      "netezza",
    )!.key;
    expect(service.getRelationScoreOverrides()[0]).toMatchObject({
      id,
      relationKey: forwardKey,
      adjustment: 3,
    });

    const restarted = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:05:00.000Z",
    });
    await restarted.initialize();
    expect(restarted.getSnapshot().relationScoreOverrides).toMatchObject([
      { id, relationKey: forwardKey, adjustment: 3 },
    ]);
    expect(await restarted.clearRelationScoreAdjustment(relation)).toBe(true);
    expect(restarted.getSnapshot().relationScoreOverrides ?? []).toEqual([]);
  });

  it("keeps score adjustments separate from confirmation, favorite and block decisions", async () => {
    const service = new JoinKnowledgeService(new MemoryPersistence(), {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    await service.setRelationScoreAdjustment(relation, 2);
    expect(service.getSnapshot().relations).toEqual([]);

    await service.confirmRelation(relation);
    await service.setRelationScoreAdjustment(relation, 4);
    expect(service.getSnapshot().relations[0]).toMatchObject({ decision: "confirmed" });

    const favorite = await service.toggleFavoriteRelation(relation);
    expect(favorite.favorited).toBe(true);
    await service.setRelationScoreAdjustment(relation, -3);
    expect(service.getSnapshot().relations[0]).toMatchObject({
      decision: "confirmed",
      favorite: true,
    });

    await service.blockRelation(relation);
    await service.setRelationScoreAdjustment(relation, 5);
    expect(service.getSnapshot().relations[0].decision).toBe("blocked");
  });

  it("clears a changed or zero score and restores the unadjusted snapshot", async () => {
    const service = new JoinKnowledgeService(new MemoryPersistence(), {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    await service.setRelationScoreAdjustment(relation, 3);
    await service.setRelationScoreAdjustment(relation, -4);
    expect(service.getSnapshot().relationScoreOverrides).toMatchObject([
      { adjustment: -4 },
    ]);
    expect(await service.clearRelationScoreAdjustment(relation)).toBe(true);
    expect(service.getSnapshot().relationScoreOverrides ?? []).toEqual([]);
    expect(
      service.getRelationScoreOverrides().every((entry) => entry.revertedAt !== undefined),
    ).toBe(true);

    const zero = await service.setRelationScoreAdjustment(relation, 0);
    expect(service.getSnapshot().relationScoreOverrides).toMatchObject([
      { id: zero, adjustment: 0 },
    ]);
    expect(await service.clearRelationScoreAdjustment(relation)).toBe(true);
    expect(service.getSnapshot().relationScoreOverrides ?? []).toEqual([]);
    expect(await service.clearRelationScoreAdjustment(relation)).toBe(false);
  });

  it("clears every legacy active score record when Reset runs", async () => {
    const identity = canonicalizeRelation(
      { left: relation.left, right: relation.right, columns: relation.columns },
      "netezza",
    )!;
    const persistence = new MemoryPersistence();
    persistence.state = {
      version: 1,
      relationOverrides: [],
      objectOverrides: [],
      relationEvidence: [],
      objectEvidence: [],
      relationScoreOverrides: [
        {
          id: "score-legacy-old",
          relationKey: identity.key,
          relation: identity,
          adjustment: 2,
          createdAt: "2026-10-25T09:00:00.000Z",
        },
        {
          id: "score-legacy-new",
          relationKey: identity.key,
          relation: identity,
          adjustment: -3,
          createdAt: "2026-10-25T10:00:00.000Z",
        },
      ],
    };
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T11:00:00.000Z",
    });
    await service.initialize();
    expect(service.getSnapshot().relationScoreOverrides?.map((entry) => entry.id))
      .toEqual(["score-legacy-old", "score-legacy-new"]);

    expect(await service.clearRelationScoreAdjustment(relation)).toBe(true);
    expect(service.getSnapshot().relationScoreOverrides ?? []).toEqual([]);
    expect(service.getRelationScoreOverrides().every((entry) => entry.revertedAt !== undefined))
      .toBe(true);
    expect(persistence.state.relationScoreOverrides?.every((entry) => entry.revertedAt !== undefined))
      .toBe(true);
  });

  it("keeps favorite and confirmation independent and lets block win", async () => {
    const service = new JoinKnowledgeService(new MemoryPersistence(), {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    await service.favoriteRelation(relation);
    const confirmId = await service.confirmRelation(relation);
    expect(service.getSnapshot().relations[0]).toMatchObject({
      decision: "confirmed",
      favorite: true,
    });

    await service.blockRelation(relation);
    expect(service.getSnapshot().relations[0].decision).toBe("blocked");
    const favorite = service.getSnapshot().relations[0].favorite;
    expect(favorite).toBe(true);

    await service.revertRelationOverride(confirmId);
    const afterBlock = service.getSnapshot().relations[0];
    expect(afterBlock.decision).toBe("blocked");
    expect(afterBlock.favorite).toBe(true);

    const blockId = service.getRelationOverrides()
      .find((entry) => entry.kind === "block" && !entry.revertedAt)?.id;
    expect(blockId).toBeDefined();
    await service.revertRelationOverride(blockId!);
    expect(service.getSnapshot().relations[0]).toMatchObject({
      decision: "favorite",
      favorite: true,
    });
  });

  it("reverts relation decisions and reports unknown ids", async () => {
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const id = await service.confirmRelation(relation);
    expect(await service.revertRelationOverride(id)).toBe(true);
    expect(service.getSnapshot().relations).toHaveLength(0);
    expect(await service.revertRelationOverride(id)).toBe(false);
  });

  it("assigns increasing pin orders and validates boost bands", async () => {
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const secondObject = {
      ...object,
      object: { ...object.object, name: "CUSTOMERS" },
    };

    await service.pinObject(object);
    await service.pinObject(secondObject);

    const pins = service.getObjectOverrides().filter((entry) => entry.kind === "pin");
    expect(pins.map((entry) => entry.pinOrder)).toEqual([1, 2]);
    await expect(service.boostObject({ ...object, band: 99 })).rejects.toThrow(/band/u);
  });

  it("captures the effective scope before snapshot and persistence", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();

    await service.confirmRelation({
      left: { database: "BAZA", table: "USERS" },
      right: { database: "BAZA", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      databaseKind: "netezza",
      effectiveSchema: "ADMIN",
    });
    await service.pinObject({
      object: { name: "ORDERS" },
      databaseKind: "netezza",
      effectiveDatabase: "BAZA",
      effectiveSchema: "ADMIN",
    });

    const expectedRelationKey = canonicalizeRelation({
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
    }, "netezza")!.key;
    const expectedObjectKey = objectRefKey({
      database: "BAZA",
      schema: "ADMIN",
      name: "ORDERS",
    });

    expect(service.getSnapshot().relations[0].key).toBe(expectedRelationKey);
    expect(service.getSnapshot().objectPreferences[0].key).toBe(expectedObjectKey);
    expect(persistence.state.relationOverrides[0].relationKey).toBe(expectedRelationKey);
    expect(persistence.state.objectOverrides[0].objectKey).toBe(expectedObjectKey);

    // A fresh service reading the persisted state must keep the same identity.
    const restarted = new JoinKnowledgeService(persistence);
    await restarted.initialize();
    expect(restarted.getSnapshot().relations[0].key).toBe(expectedRelationKey);
    expect(restarted.getSnapshot().objectPreferences[0].key).toBe(expectedObjectKey);
  });

  it("persists identifier and counter payloads only", async () => {
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence);
    await service.initialize();
    await service.confirmRelation({
      ...relation,
      // @ts-expect-error unknown fields are ignored, never persisted
      sql: "SELECT * FROM USERS WHERE password = 'hunter2'",
    });
    await service.excludeObject(object);

    const payload = JSON.stringify(persistence.state);
    expect(payload).not.toContain("hunter2");
    expect(payload).not.toContain("password");
    expect(payload).not.toContain("SELECT");
  });

  it("keeps in-memory decisions when persistence fails", async () => {
    const persistence = new MemoryPersistence();
    persistence.failSave = true;
    const warn = jest.fn();
    const service = new JoinKnowledgeService(persistence, {
      logger: { info: jest.fn(), warn },
    });
    await service.initialize();

    await service.confirmRelation(relation);

    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be saved"));
  });

  it("rejects malformed command arguments before mutating state", async () => {
    const { registerJoinKnowledgeCommands } = await import(
      "../../commands/joinKnowledgeCommands"
    );
    const persistence = new MemoryPersistence();
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await service.initialize();
    const register = vscode.commands.registerCommand as jest.Mock;
    register.mockClear();
    registerJoinKnowledgeCommands(service);

    const handlerFor = (id: string): ((value?: unknown) => Promise<unknown>) => {
      const call = register.mock.calls.find((entry) => entry[0] === id);
      expect(call).toBeDefined();
      return call![1] as (value?: unknown) => Promise<unknown>;
    };
    const confirm = handlerFor("netezza.confirmJoinKnowledgeRelation");
    const block = handlerFor("netezza.blockJoinKnowledgeRelation");
    const pin = handlerFor("netezza.pinSqlObject");
    const boost = handlerFor("netezza.boostSqlObject");
    const revertRelation = handlerFor("netezza.revertJoinKnowledgeOverride");
    const revertObject = handlerFor("netezza.revertSqlObjectPreference");

    const validRelation = {
      left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
      right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
      columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      databaseKind: "netezza",
    };
    const invalidCalls: Array<{
      handler: (value?: unknown) => Promise<unknown>;
      value?: unknown;
      error: RegExp;
    }> = [
      { handler: confirm, error: /required/u },
      { handler: confirm, value: { ...validRelation, left: undefined }, error: /left/u },
      { handler: confirm, value: { ...validRelation, right: undefined }, error: /right/u },
      { handler: confirm, value: { ...validRelation, columns: [] }, error: /columns/u },
      {
        handler: confirm,
        value: { ...validRelation, columns: [{ left: "USER_ID" }] },
        error: /columns\[0\]\.right/u,
      },
      {
        handler: confirm,
        value: { ...validRelation, columns: [{ left: " ", right: "ID" }] },
        error: /columns\[0\]\.left/u,
      },
      {
        handler: confirm,
        value: {
          ...validRelation,
          right: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        },
        error: /different tables/u,
      },
      { handler: block, value: {}, error: /left/u },
      { handler: pin, error: /object/u },
      { handler: boost, value: { object: { name: " " } }, error: /object\.name/u },
      {
        handler: boost,
        value: {
          object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
          band: 99,
        },
        error: /band/u,
      },
      {
        handler: pin,
        value: {
          object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
          pinOrder: Number.NaN,
        },
        error: /pin order/u,
      },
      { handler: revertRelation, error: /override id/u },
      { handler: revertObject, value: { id: 5 }, error: /override id/u },
    ];

    for (const invalid of invalidCalls) {
      await expect(invalid.handler(invalid.value)).rejects.toThrow(invalid.error);
      expect(service.getSnapshot()).toEqual({
        version: 1,
        relations: [],
        objectPreferences: [],
      });
      expect(persistence.saves).toBe(0);
    }

    await expect(revertRelation({ id: "missing" })).resolves.toBe(false);
    await expect(revertObject("missing")).resolves.toBe(false);
    expect(persistence.saves).toBe(0);

    await confirm(validRelation);
    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(persistence.saves).toBe(1);
  });

  it("offers a confirmed action to add a suggestion to workspace manual relations", async () => {
    const { registerJoinKnowledgeCommands } = await import(
      "../../commands/joinKnowledgeCommands"
    );
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const relationSetting = {
      left: relation.left,
      right: relation.right,
      columns: relation.columns,
      databaseKind: "netezza",
    };
    const update = jest.fn().mockResolvedValue(undefined);
    const configuration = {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update,
    };
    const workspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "workspaceFolders");
    const activeEditorDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "activeTextEditor");
    const createQuickPickDescriptor = Object.getOwnPropertyDescriptor(vscode.window, "createQuickPick");
    jest.spyOn(vscode.workspace, "getConfiguration")
      .mockReturnValue(configuration as unknown as vscode.WorkspaceConfiguration);
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [{ uri: { fsPath: "/workspace" } }],
    });
    Object.defineProperty(vscode.window, "activeTextEditor", {
      configurable: true,
      value: {
        document: {
          uri: { toString: () => "file:///workspace/query.sql" },
          languageId: "sql",
        },
        selection: { active: { line: 0, character: 0 } },
      },
    });
    let triggerButton: ((event: {
      item: vscode.QuickPickItem;
      button: vscode.QuickInputButton;
    }) => void) | undefined;
    const quickPick = {
      title: "",
      placeholder: "",
      items: [] as Array<vscode.QuickPickItem & { relation?: unknown }>,
      onDidTriggerItemButton: jest.fn((handler: typeof triggerButton) => {
        triggerButton = handler;
        return { dispose: jest.fn() };
      }),
      onDidAccept: jest.fn(() => ({ dispose: jest.fn() })),
      onDidHide: jest.fn(() => ({ dispose: jest.fn() })),
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    };
    Object.defineProperty(vscode.window, "createQuickPick", {
      configurable: true,
      value: jest.fn(() => quickPick),
    });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue("Add relation");
    const register = vscode.commands.registerCommand as jest.Mock;
    register.mockClear();
    registerJoinKnowledgeCommands(service, {
      getJoinSuggestions: async () => [{
        label: "JUST_DATA..ORDERS O ON D.DATEKEY = O.DATEKEY",
        relation: relationSetting,
        favorite: false,
      }],
    });

    const command = register.mock.calls.find(
      (entry) => entry[0] === "netezza.favoriteJoinKnowledgeSuggestion",
    );
    await (command![1] as () => Promise<void>)();
    expect(quickPick.items[0].buttons).toHaveLength(2);
    const addButton = quickPick.items[0].buttons![1];
    expect(addButton.tooltip).toContain("Add to manual JOIN relations");
    await triggerButton?.({ item: quickPick.items[0], button: addButton });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Add"),
      expect.objectContaining({ modal: true }),
      "Add relation",
    );
    expect(update).toHaveBeenCalledWith(
      "joinRelations",
      [expect.objectContaining({
        left: relation.left,
        right: relation.right,
        columns: relation.columns,
      })],
      vscode.ConfigurationTarget.Workspace,
    );
    jest.restoreAllMocks();
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    for (const [target, key, descriptor] of [
      [vscode.workspace, "workspaceFolders", workspaceFoldersDescriptor],
      [vscode.window, "activeTextEditor", activeEditorDescriptor],
      [vscode.window, "createQuickPick", createQuickPickDescriptor],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else {
        Reflect.deleteProperty(target, key);
      }
    }
  });

  it("registers commands that validate their arguments", async () => {
    const { registerJoinKnowledgeCommands } = await import(
      "../../commands/joinKnowledgeCommands"
    );
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const register = vscode.commands.registerCommand as jest.Mock;
    register.mockClear();

    const disposables = registerJoinKnowledgeCommands(service);
    expect(disposables).toHaveLength(18);

    const handlerFor = (id: string): ((value?: unknown) => Promise<unknown>) => {
      const call = register.mock.calls.find((entry) => entry[0] === id);
      expect(call).toBeDefined();
      return call![1] as (value?: unknown) => Promise<unknown>;
    };

    await expect(handlerFor("netezza.confirmJoinKnowledgeRelation")({})).rejects
      .toThrow(/left/u);
    await handlerFor("netezza.confirmJoinKnowledgeRelation")(relation);
    expect(service.getSnapshot().relations).toHaveLength(1);

    await handlerFor("netezza.pinSqlObject")({ object: object.object });
    expect(service.getSnapshot().objectPreferences).toHaveLength(1);

    // An accepted FROM selection is evidence only, never a manual preference,
    // and a malformed argument is swallowed so typing is never interrupted.
    const acceptObject = handlerFor("netezza.recordSqlObjectAcceptance");
    await expect(acceptObject({ object: { name: "ACCEPTED_TABLE" } })).resolves.toBe(true);
    await expect(acceptObject({})).resolves.toBe(false);
    expect(service.getSnapshot().objectPreferences).toHaveLength(1);
    expect(service.getSnapshot().acceptedObjects).toEqual([
      expect.objectContaining({ source: "accepted", observations: 1, belowThreshold: true }),
    ]);

    const revertObject = handlerFor("netezza.revertSqlObjectPreference");
    const objectId = service.getObjectOverrides()[0].id;
    await expect(revertObject({ id: objectId })).resolves.toBe(true);

    const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
    showInformationMessage.mockClear();
    await handlerFor("netezza.showJoinKnowledgeStatus")();
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("justybase.sql.joinRelations"),
    );
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Workspace index"),
    );
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Favorite is a preference"),
    );
  });

  it("reports skip reasons, truncation and Git mode in the status command", async () => {
    const { registerJoinKnowledgeCommands } = await import(
      "../../commands/joinKnowledgeCommands"
    );
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const register = vscode.commands.registerCommand as jest.Mock;
    register.mockClear();
    registerJoinKnowledgeCommands(service, {
      getIndexStatus: () => ({
        enabled: true,
        running: false,
        filesSelected: 3,
        filesIndexed: 2,
        relations: { total: 2, eligible: 1, belowThreshold: 1 },
        objects: { total: 3, eligible: 2, belowThreshold: 1 },
        skipped: { "parse-error": 2, ddl: 1 },
        truncated: true,
        truncationReasons: ["file-cap:2000"],
        git: {
          mode: "window",
          windowDays: 365,
          head: "abcdef123456",
          dirty: 1,
          untracked: 2,
          open: 1,
        },
        lastIndexedAt: "2026-10-25T10:00:00.000Z",
      }),
    });
    const call = register.mock.calls.find(
      (entry) => entry[0] === "netezza.showJoinKnowledgeStatus",
    );
    expect(call).toBeDefined();
    const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
    showInformationMessage.mockClear();
    await (call![1] as () => Promise<unknown>)();

    for (const expected of [
      "Workspace index: enabled",
      "parse-error: 2",
      "ddl: 1",
      "file-cap:2000",
      "window 365 day(s)",
      "HEAD abcdef123456",
      "1 dirty, 2 untracked",
    ]) {
      expect(showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining(expected),
      );
    }
  });

  it("registers favorite and index commands with the shared store", async () => {
    const { registerJoinKnowledgeCommands } = await import(
      "../../commands/joinKnowledgeCommands"
    );
    const service = new JoinKnowledgeService(new MemoryPersistence());
    await service.initialize();
    const register = vscode.commands.registerCommand as jest.Mock;
    register.mockClear();
    const rebuiltStatus = {
      enabled: true,
      running: false,
      filesSelected: 2,
      filesIndexed: 2,
      relations: { total: 1, eligible: 1, belowThreshold: 0 },
      objects: { total: 1, eligible: 1, belowThreshold: 0 },
      skipped: {},
      truncated: false,
      truncationReasons: [],
      git: {
        mode: "window" as const,
        windowDays: 365,
        head: "abc123",
        dirty: 0,
        untracked: 0,
        open: 0,
      },
      lastIndexedAt: "2026-10-25T10:00:00.000Z",
    };
    const rebuild = jest.fn(async () => rebuiltStatus);
    registerJoinKnowledgeCommands(service, {
      rebuildIndex: rebuild,
      getIndexStatus: () => undefined,
    });
    const handlerFor = (id: string): ((value?: unknown) => Promise<unknown>) => {
      const call = register.mock.calls.find((entry) => entry[0] === id);
      expect(call).toBeDefined();
      return call![1] as (value?: unknown) => Promise<unknown>;
    };

    await handlerFor("netezza.favoriteJoinKnowledgeRelation")(relation);
    expect(service.getSnapshot().relations[0]).toMatchObject({
      decision: "favorite",
      favorite: true,
    });
    await handlerFor("netezza.favoriteJoinKnowledgeRelation")(relation);
    expect(service.getSnapshot().relations).toHaveLength(0);

    await expect(handlerFor("netezza.favoriteJoinKnowledgeRelation")({}))
      .rejects.toThrow(/left/u);
    const acceptedRelation = {
      ...relation,
      left: { ...relation.left, table: "ACCOUNTS" },
      right: { ...relation.right, table: "TRANSACTIONS" },
    };
    await expect(handlerFor("netezza.recordJoinKnowledgeAcceptance")(acceptedRelation))
      .resolves.toBe(true);
    await expect(handlerFor("netezza.recordJoinKnowledgeAcceptance")(acceptedRelation))
      .resolves.toBe(true);
    expect(service.getSnapshot().relations).toHaveLength(0);
    expect(service.getRelationEvidence()).toContainEqual(
      expect.objectContaining({ source: "accepted", observations: 2 }),
    );
    await handlerFor("netezza.rebuildJoinKnowledgeIndex")();
    expect(rebuild).toHaveBeenCalledTimes(1);
    const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("JOIN workspace index rebuilt"),
    );
  });
});

describe("JoinKnowledgeService import/export (Stage 4)", () => {
  async function serviceWith(persistence = new MemoryPersistence()) {
    const service = new JoinKnowledgeService(persistence, {
      now: () => "2026-10-26T10:00:00.000Z",
    });
    await service.initialize();
    return { service, persistence };
  }

  async function exportedText(): Promise<string> {
    const { service } = await serviceWith();
    await service.confirmRelation(relation);
    await service.pinObject(object);
    return service.exportKnowledge().text;
  }

  it("rejects an unknown version with zero writes", async () => {
    const { service, persistence } = await serviceWith();
    const text = JSON.stringify({ ...JSON.parse(await exportedText()), version: 99 });
    expect(service.previewImport(text)).toEqual({
      ok: false,
      error: expect.stringContaining("Unsupported export version 99"),
    });
    expect(persistence.saves).toBe(0);
  });

  it("imports in one write, then undoes the import while keeping later evidence", async () => {
    const { service, persistence } = await serviceWith();
    const preview = service.previewImport(await exportedText());
    if (!preview.ok) {
      throw new Error(preview.error);
    }
    expect(preview.diff).toMatchObject({ added: 2, conflicts: 0 });

    await expect(service.importKnowledge(preview.document, {})).resolves.toMatchObject({ added: 2 });
    expect(persistence.saves).toBe(1);
    expect(service.getSnapshot().relations).toHaveLength(1);
    expect(service.getSnapshot().objectPreferences).toHaveLength(1);

    await service.recordAcceptedObject({ object: { name: "LATER" }, databaseKind: "netezza" });
    expect(service.canUndoImport()).toBe(true);
    await expect(service.undoLastImport()).resolves.toBe(true);
    expect(service.getSnapshot().relations).toHaveLength(0);
    expect(service.getSnapshot().objectPreferences).toHaveLength(0);
    expect(service.getSnapshot().acceptedObjects).toHaveLength(1);
    expect(service.canUndoImport()).toBe(false);
  });

  it("refuses undo after a manual change made after the import", async () => {
    const { service } = await serviceWith();
    const preview = service.previewImport(await exportedText());
    if (!preview.ok) {
      throw new Error(preview.error);
    }
    await service.importKnowledge(preview.document, {});
    const [override] = service.getObjectOverrides();
    await service.revertObjectPreference(override.id);
    expect(service.canUndoImport()).toBe(false);
    await expect(service.undoLastImport()).rejects.toThrow(/changed after the import/u);
  });

  it("rolls back the in-memory state when the import cannot be saved", async () => {
    const persistence = new MemoryPersistence();
    const { service } = await serviceWith(persistence);
    const preview = service.previewImport(await exportedText());
    if (!preview.ok) {
      throw new Error(preview.error);
    }
    persistence.failSave = true;
    await expect(service.importKnowledge(preview.document, {})).rejects.toThrow(/nothing was changed/u);
    expect(service.getSnapshot().relations).toHaveLength(0);
    expect(service.getSnapshot().objectPreferences).toHaveLength(0);
    expect(service.canUndoImport()).toBe(false);
  });
});
