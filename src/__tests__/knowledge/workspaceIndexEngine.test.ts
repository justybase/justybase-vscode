jest.unmock("chevrotain");

import {
  createWorkspaceIndexSnapshot,
} from "@justybase/sql-core/joinKnowledge";
import {
  parseWorkspaceIndexState,
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
  type WorkspaceIndexPersistedState,
} from "../../knowledge/workspaceIndexEngine";
import {
  isWorkspaceFileSelected,
  parseGitStatusPorcelainZ,
} from "../../knowledge/workspaceIndexCoordinator";

const now = "2026-10-25T10:00:00.000Z";

function input(
  relPath: string,
  text: string,
  options: {
    mtimeMs?: number;
    dirty?: boolean;
    open?: boolean;
  } = {},
): WorkspaceFileInput & { readCount: { value: number } } {
  const readCount = { value: 0 };
  return {
    relPath,
    size: Buffer.byteLength(text, "utf8"),
    mtimeMs: options.mtimeMs ?? 1000,
    dirty: options.dirty ?? false,
    open: options.open ?? false,
    contentHash: options.dirty || options.open ? hash(text) : undefined,
    loadText: () => {
      readCount.value += 1;
      return text;
    },
    readCount,
  } as WorkspaceFileInput & { readCount: { value: number } };
}

function hash(text: string): string {
  // Node crypto is available in Jest's node environment.
  return require("node:crypto")
    .createHash("sha256")
    .update(text, "utf8")
    .digest("hex");
}

function relationSql(table = "A", other = "B", column = "ID"): string {
  return `SELECT * FROM ${table} a JOIN ${other} b ON a.${column} = b.PARENT_${column};`;
}

function engine(options: {
  checkpointEvery?: number;
  isCancelled?: () => boolean;
  onCheckpoint?: (state: WorkspaceIndexPersistedState) => void;
  salt?: string;
} = {}): WorkspaceIndexEngine {
  return new WorkspaceIndexEngine({
    databaseKind: "netezza",
    now: () => now,
    salt: options.salt ?? "0011223344556677",
    checkpointEvery: options.checkpointEvery,
    isCancelled: options.isCancelled,
    onCheckpoint: options.onCheckpoint,
  });
}

describe("WorkspaceIndexEngine consistency gate", () => {
  it("1. modification re-parses only the changed file and removes old contributions", async () => {
    const instance = engine();
    const firstA = input("a.sql", relationSql("A", "B"));
    const firstB = input("b.sql", relationSql("C", "D"));
    const first = await instance.reconcile([firstA, firstB]);
    expect(first.reindexed).toEqual(["a.sql", "b.sql"]);
    expect(instance.getSnapshot().relations).toHaveLength(2);

    const changedA = input("a.sql", "SELECT * FROM X x JOIN Y y ON x.ID = y.PARENT_ID;", {
      mtimeMs: 2000,
    });
    const unchangedB = input("b.sql", relationSql("C", "D"));
    const second = await instance.reconcile([changedA, unchangedB]);

    expect(second.reindexed).toEqual(["a.sql"]);
    expect(second.reused).toEqual(["b.sql"]);
    expect(changedA.readCount.value).toBe(1);
    expect(unchangedB.readCount.value).toBe(0);
    const labels = instance.getSnapshot().relations.map((entry) => entry.key);
    expect(labels).toHaveLength(2);
    expect(labels.some((label) => label.includes("X"))).toBe(true);
    expect(labels.some((label) => label.includes("C"))).toBe(true);
    // Only X/Y and C/D remain; the old A/B relation was removed.
  });

  it("2. deletion and rename remove the old evidence", async () => {
    const instance = engine();
    await instance.reconcile([
      input("a.sql", relationSql("A", "B")),
      input("b.sql", relationSql("A", "B")),
    ]);
    expect(instance.getSnapshot().relations[0].belowThreshold).toBe(false);

    const removed = await instance.reconcile([input("a.sql", relationSql("A", "B"))]);
    expect(removed.removed).toEqual(["b.sql"]);
    // One observation is stored but below the breadth threshold.
    expect(instance.getSnapshot().relations[0].belowThreshold).toBe(true);

    const renamed = await instance.reconcile([
      input("renamed.sql", relationSql("A", "B"), { mtimeMs: 3000 }),
    ]);
    expect(renamed.removed).toEqual(["a.sql"]);
    expect(renamed.reindexed).toEqual(["renamed.sql"]);
    expect(instance.getFileCount()).toBe(1);
    const keys = instance.getSnapshot().relations.map((entry) => entry.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("A");
  });

  it("3. open, dirty and untracked files bypass the Git window", () => {
    const base = { dirty: false, untracked: false, inWindow: false, open: false };
    expect(isWorkspaceFileSelected({ ...base, gitMode: "window" })).toBe(false);
    expect(isWorkspaceFileSelected({ ...base, gitMode: "window", open: true })).toBe(true);
    expect(isWorkspaceFileSelected({ ...base, gitMode: "window", dirty: true })).toBe(true);
    expect(isWorkspaceFileSelected({ ...base, gitMode: "window", untracked: true })).toBe(true);
    expect(isWorkspaceFileSelected({ ...base, gitMode: "all" })).toBe(true);
    expect(isWorkspaceFileSelected({ ...base, gitMode: "unavailable" })).toBe(true);
  });

  it("4. a branch switch with changed file content removes the previous relation", async () => {
    const instance = engine();
    await instance.reconcile([input("a.sql", relationSql("A", "B"))], {
      head: "branch-a",
      gitMode: "window",
    });
    const before = instance.getSnapshot().relations.map((entry) => entry.key);
    expect(before).toHaveLength(1);
    expect(before[0]).toContain("A");

    await instance.reconcile([input("a.sql", relationSql("C", "D"), {
      mtimeMs: 4000,
    })], {
      head: "branch-b",
      gitMode: "window",
    });
    const after = instance.getSnapshot().relations.map((entry) => entry.key);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("C");
    expect(after[0]).not.toBe(before[0]);
    expect(instance.getHead()).toBe("branch-b");
  });

  it("5. an interrupted run resumes from checkpointed per-file hashes", async () => {
    let checkpoint: WorkspaceIndexPersistedState | undefined;
    let cancel = false;
    const first = engine({
      checkpointEvery: 1,
      isCancelled: () => cancel,
      onCheckpoint: (state) => {
        checkpoint = state;
      },
    });
    const files = [
      input("a.sql", relationSql("A", "B")),
      input("b.sql", relationSql("A", "B")),
      input("c.sql", relationSql("C", "D")),
    ];
    let processed = 0;
    for (const file of files) {
      const original = file.loadText!;
      file.loadText = () => {
        processed += 1;
        if (processed === 2) {
          cancel = true;
        }
        return original();
      };
    }
    const interrupted = await first.reconcile(files);
    expect(interrupted.cancelled).toBe(true);
    expect(checkpoint?.files.length).toBeGreaterThanOrEqual(1);

    const resumed = engine({ checkpointEvery: 1 });
    resumed.load(parseWorkspaceIndexState(JSON.parse(JSON.stringify(checkpoint))));
    const resumedFiles = [
      input("a.sql", relationSql("A", "B")),
      input("b.sql", relationSql("A", "B")),
      input("c.sql", relationSql("C", "D")),
    ];
    const result = await resumed.reconcile(resumedFiles);
    expect(result.reused.length).toBeGreaterThanOrEqual(1);
    expect(resumedFiles.some((file) => file.readCount.value === 0)).toBe(true);
    expect(resumed.getSnapshot().relations.length).toBeGreaterThan(0);
  });

  it("5b. uses the persisted salt for new fingerprints after a restart", async () => {
    const first = engine({ salt: "aaaaaaaaaaaaaaaa" });
    await first.reconcile([input("a.sql", relationSql("A", "B"))]);
    const persisted = first.getPersistedState(now);

    const restarted = engine({ salt: "bbbbbbbbbbbbbbbb" });
    restarted.load(parseWorkspaceIndexState(JSON.parse(JSON.stringify(persisted))));
    expect(restarted.getSalt()).toBe("aaaaaaaaaaaaaaaa");

    await restarted.reconcile([input("b.sql", relationSql("A", "B"))]);
    const [relation] = restarted.getAggregate().relations;
    // A wrong salt would hash the same statement differently and make these 2.
    expect(relation.distinctQueries).toBe(1);
  });

  it("6. a full rebuild is deterministic", async () => {
    const files = () => [
      input("b.sql", relationSql("A", "B"), { mtimeMs: 2000 }),
      input("a.sql", relationSql("C", "D"), { mtimeMs: 1000 }),
    ];
    const instance = engine();
    await instance.reconcile(files());
    const first = JSON.stringify(instance.getSnapshot());
    await instance.clear({ keepSalt: true });
    await instance.reconcile(files());
    const second = JSON.stringify(instance.getSnapshot());
    expect(second).toBe(first);
    expect(createWorkspaceIndexSnapshot(instance.getAggregate(), {
      generatedAt: now,
      truncated: false,
    })).toEqual(instance.getSnapshot());
  });

  it("7. enforces the 2,000-file, 2 MB-per-file and 64 MB total caps explicitly", async () => {
    // `size` mirrors the on-disk stat the coordinator passes; `loadText` stays
    // tiny so the caps can be exercised without 64 MB of real SQL.
    const declared = (
      relPath: string,
      size: number,
      text = "SELECT 1;",
      mtimeMs = 1000,
    ): WorkspaceFileInput => ({
      relPath,
      size,
      mtimeMs,
      dirty: false,
      open: false,
      loadText: () => text,
    });

    const fileCap = engine({ checkpointEvery: 5000 });
    await fileCap.reconcile(
      Array.from({ length: 2001 }, (_, index) =>
        index === 2000
          // The file past the cap is last in sorted order and carries the only
          // relation; it must not leave ghost evidence behind.
          ? declared("cap/2000.sql", 10, relationSql("GHOST", "TABLE"))
          : declared(`cap/${String(index).padStart(4, "0")}.sql`, 10),
      ),
    );
    expect(fileCap.getFileCount()).toBe(2000);
    expect(fileCap.hasFile("cap/2000.sql")).toBe(false);
    expect(fileCap.getSnapshot().truncated).toBe(true);
    expect(fileCap.getSnapshot().relations).toHaveLength(0);

    const perFileCap = engine();
    await perFileCap.reconcile([
      declared("big.sql", 2 * 1024 * 1024 + 1, relationSql("GHOST", "TABLE")),
      declared("ok.sql", 10),
    ]);
    expect(perFileCap.hasFile("big.sql")).toBe(false);
    expect(perFileCap.hasFile("ok.sql")).toBe(true);
    expect(perFileCap.getSnapshot().truncated).toBe(true);
    expect(
      perFileCap.getSnapshot().relations.some((entry) =>
        entry.key.includes("GHOST"),
      ),
    ).toBe(false);

    const totalBytesCap = engine();
    const megabyte = 1024 * 1024;
    await totalBytesCap.reconcile(
      Array.from({ length: 65 }, (_, index) =>
        declared(`bytes/${String(index).padStart(2, "0")}.sql`, megabyte, "SELECT 1;", 1000 + index),
      ),
    );
    expect(totalBytesCap.getFileCount()).toBe(64);
    expect(totalBytesCap.hasFile("bytes/64.sql")).toBe(false);
    expect(totalBytesCap.getSnapshot().truncated).toBe(true);
  });

  it("8. delete evidence removes observed contributions without touching files", async () => {
    const instance = engine();
    await instance.reconcile([
      input("a.sql", relationSql("A", "B")),
      input("b.sql", relationSql("A", "B")),
    ]);
    const relationSnapshot = instance.getSnapshot().relations[0];
    expect(relationSnapshot).toBeDefined();
    const objectKeys = instance.getSnapshot().objects.map((entry) => entry.key);
    expect(objectKeys.length).toBeGreaterThan(0);

    const relationDelta = await instance.deleteRelationEvidence(relationSnapshot.key);
    expect(instance.getSnapshot().relations).toHaveLength(0);
    expect(instance.getFileCount()).toBe(2);
    expect(relationDelta.relationsRemove).toContain(relationSnapshot.key);

    for (const objectKey of objectKeys) {
      const objectDelta = await instance.deleteObjectEvidence(objectKey);
      expect(objectDelta.objectsRemove).toContain(objectKey);
    }
    expect(instance.getSnapshot().objects).toHaveLength(0);
    expect(instance.getFileCount()).toBe(2);
  });

  it("keeps only the latest checkpointed state after a restart", async () => {
    let checkpoint: WorkspaceIndexPersistedState | undefined;
    const first = engine({ onCheckpoint: (state) => { checkpoint = state; } });
    await first.reconcile([input("a.sql", relationSql("A", "B"))]);
    const second = engine();
    second.load(parseWorkspaceIndexState(JSON.parse(JSON.stringify(checkpoint))));
    expect(second.getSnapshot().relations).toHaveLength(1);
    expect(second.getFileCount()).toBe(1);
  });

  it("parses git porcelain rename records without treating the old path as current", () => {
    const output = [
      " M a.sql",
      "?? b.sql",
      "R  old.sql",
      "new.sql",
      "",
    ].join("\u0000");
    expect(parseGitStatusPorcelainZ(output)).toEqual([
      { path: "a.sql", status: " M" },
      { path: "b.sql", status: "??" },
      { path: "new.sql", status: "R " },
    ]);
  });
});
