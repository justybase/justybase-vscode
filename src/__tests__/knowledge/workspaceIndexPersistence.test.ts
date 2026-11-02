jest.unmock("chevrotain");

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
} from "../../knowledge/workspaceIndexEngine";
import { FileWorkspaceIndexPersistence } from "../../knowledge/workspaceIndexPersistence";
import { FileJoinKnowledgePersistence } from "../../knowledge/joinKnowledgeFilePersistence";
import { JoinKnowledgeStore } from "@justybase/sql-core/joinKnowledge";

function input(relPath: string, text: string): WorkspaceFileInput {
  return {
    relPath,
    size: Buffer.byteLength(text, "utf8"),
    mtimeMs: 1000,
    dirty: false,
    open: false,
    loadText: () => text,
  };
}

describe("FileWorkspaceIndexPersistence", () => {
  let directory: string;
  let persistence: FileWorkspaceIndexPersistence;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "justybase-workspace-index-"));
    persistence = new FileWorkspaceIndexPersistence(directory);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("round-trips per-file records, head and truncation", async () => {
    const engine = new WorkspaceIndexEngine({
      databaseKind: "netezza",
      salt: "0011223344556677",
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await engine.reconcile([
      input("a.sql", "SELECT * FROM A a JOIN B b ON a.ID = b.PARENT_ID;"),
    ], {
      head: "abc123",
      gitMode: "window",
      truncated: false,
    });
    await persistence.save(engine.getPersistedState("2026-10-25T10:00:00.000Z"));

    const loaded = await persistence.load();
    expect(loaded.salt).toBe("0011223344556677");
    expect(loaded.head).toBe("abc123");
    expect(loaded.gitMode).toBe("window");
    expect(loaded.files).toHaveLength(1);
    expect(loaded.files[0].relPath).toBe("a.sql");
    expect(loaded.files[0].relations).toHaveLength(1);
    expect(loaded.files[0].relations[0].relation.key).toContain("A");
  });

  it("keeps concurrent same-millisecond checkpoints from colliding", async () => {
    const state = await persistence.load();
    const first = { ...state, files: [], savedAt: "2026-10-25T10:00:00.000Z" };
    const second = { ...state, files: [], savedAt: "2026-10-25T10:00:01.000Z" };
    // File-watcher events can checkpoint in the same millisecond; a shared
    // temporary name makes one rename fail and silently drops its delta.
    const now = jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await expect(Promise.all([
        persistence.save(first),
        persistence.save(second),
      ])).resolves.toBeDefined();
    } finally {
      now.mockRestore();
    }
    const stored = await persistence.load();
    expect([first.savedAt, second.savedAt]).toContain(stored.savedAt);
  });

  it("degrades corrupt and unknown versions to an empty index", async () => {
    await fs.writeFile(
      path.join(directory, "workspace-index.json"),
      "{not json",
      "utf8",
    );
    expect((await persistence.load()).files).toEqual([]);

    await fs.writeFile(
      path.join(directory, "workspace-index.json"),
      JSON.stringify({ version: 99, files: [{ relPath: "a.sql" }] }),
      "utf8",
    );
    expect((await persistence.load()).files).toEqual([]);
  });

  it("writes identifiers, hashes and counters only", async () => {
    const engine = new WorkspaceIndexEngine({
      databaseKind: "netezza",
      salt: "0011223344556677",
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await engine.reconcile([
      input(
        "secret.sql",
        "SELECT * FROM USERS u JOIN ORDERS o ON u.ID = o.OWNER_ID "
        + "WHERE u.password = 'hunter2';",
      ),
    ]);
    await persistence.save(engine.getPersistedState());
    const payload = await fs.readFile(
      path.join(directory, "workspace-index.json"),
      "utf8",
    );
    expect(payload).not.toContain("hunter2");
    expect(payload).not.toContain("SELECT");
    expect(payload).not.toContain("WHERE");
    // Column usage stores the referenced column as a normalized identifier
    // (the ranking model allows identifiers); never the predicate or literal.
    expect(payload).not.toContain("password");
    expect(payload).toContain("\"column\": \"PASSWORD\"");
    expect(payload).toContain("USERS");
    expect(payload).toContain("ORDERS");
  });

  it("keeps manual favorites across a full and an incremental re-index", async () => {
    const manual = new FileJoinKnowledgePersistence(directory);
    const store = new JoinKnowledgeStore();
    const favorite = store.appendRelationOverride({
      kind: "favorite",
      relation: {
        left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
        right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
        columns: [{ left: "USER_ID", right: "OWNER_ID" }],
      },
      databaseKind: "netezza",
      now: "2026-10-25T10:00:00.000Z",
      id: "favorite-1",
    });
    await manual.save(store.getState("2026-10-25T10:00:00.000Z"));

    const engine = new WorkspaceIndexEngine({
      databaseKind: "netezza",
      salt: "0011223344556677",
      now: () => "2026-10-25T10:00:00.000Z",
    });
    await engine.reconcile([
      input("a.sql", "SELECT * FROM USERS u JOIN ORDERS o ON u.USER_ID = o.OWNER_ID;"),
    ]);
    await persistence.save(engine.getPersistedState());

    await engine.clear({ keepSalt: true });
    await engine.reconcile([
      input("a.sql", "SELECT * FROM USERS u JOIN ORDERS o ON u.USER_ID = o.OWNER_ID;"),
    ]);
    await persistence.save(engine.getPersistedState());
    await engine.indexFile(input(
      "b.sql",
      "SELECT * FROM CUSTOMERS c JOIN ORDERS o ON c.CUSTOMER_ID = o.ID;",
    ));
    await persistence.save(engine.getPersistedState());

    const reloaded = await manual.load();
    const reloadedFavorite = reloaded.relationOverrides.find(
      (entry) => entry.id === favorite.id,
    );
    expect(reloadedFavorite?.kind).toBe("favorite");
    expect(reloadedFavorite?.revertedAt).toBeUndefined();
    expect((await persistence.load()).files).toHaveLength(2);
  });

  it("keeps two workspace directories isolated", async () => {
    const otherDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "justybase-workspace-index-other-"),
    );
    try {
      const other = new FileWorkspaceIndexPersistence(otherDirectory);
      const engine = new WorkspaceIndexEngine({
        databaseKind: "netezza",
        salt: "0011223344556677",
      });
      await engine.reconcile([
        input("a.sql", "SELECT * FROM A a JOIN B b ON a.ID = b.PARENT_ID;"),
      ]);
      await persistence.save(engine.getPersistedState());
      expect((await other.load()).files).toEqual([]);
      expect((await persistence.load()).files).toHaveLength(1);
    } finally {
      await fs.rm(otherDirectory, { recursive: true, force: true });
    }
  });
});
