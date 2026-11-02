jest.unmock("chevrotain");

import {
  aggregateWorkspaceIndex,
  createWorkspaceIndexSnapshot,
  type WorkspaceFileIndexRecord,
} from "@justybase/sql-core/joinKnowledge";
import {
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
} from "../../knowledge/workspaceIndexEngine";

/**
 * Small, deterministic calibration corpus. The expectations are maintainer
 * labels for this fixture, not a claim about a real user workspace.
 */
const CALIBRATION_EXPECTATIONS = [
  { source: "USERS", target: "ORDERS" },
  { source: "CUSTOMERS", target: "ORDERS" },
] as const;

const now = "2026-10-25T10:00:00.000Z";

function input(relPath: string, text: string, mtimeMs = 1000): WorkspaceFileInput {
  return {
    relPath,
    size: Buffer.byteLength(text, "utf8"),
    mtimeMs,
    dirty: false,
    open: false,
    loadText: () => text,
  };
}

function sql(source: string, target: string, sourceColumn: string, targetColumn: string): string {
  return `SELECT * FROM ${source} s JOIN ${target} t ON s.${sourceColumn} = t.${targetColumn};`;
}

function labels(aggregate: ReturnType<typeof aggregateWorkspaceIndex>): string[] {
  return createWorkspaceIndexSnapshot(aggregate, {
    generatedAt: now,
    truncated: false,
  }).relations.map((entry) => entry.key);
}

describe("JOIN workspace index calibration", () => {
  it("measures synthetic Top-1/Top-5 and re-index stability", async () => {
    const files = [
      input("sales/orders_a.sql", sql("USERS", "ORDERS", "USER_ID", "OWNER_ID")),
      input("sales/orders_b.sql", sql("USERS", "ORDERS", "USER_ID", "OWNER_ID")),
      input("sales/customers_a.sql", sql("CUSTOMERS", "ORDERS", "CUSTOMER_ID", "CUSTOMER_ID")),
      input("sales/customers_b.sql", sql("CUSTOMERS", "ORDERS", "CUSTOMER_ID", "CUSTOMER_ID")),
      input("misc/unrelated.sql", sql("A", "B", "ID", "PARENT_ID")),
    ];
    const aggregate = aggregateWorkspaceIndex(
      await indexFiles(files),
      { now },
    );
    const eligible = aggregate.relations.filter((entry) => !entry.belowThreshold);
    const bySource = new Map<string, string[]>();
    for (const relation of eligible) {
      bySource.set(relation.relation.display.left.table, [
        ...(bySource.get(relation.relation.display.left.table) ?? []),
        relation.relation.display.right.table,
      ]);
      bySource.set(relation.relation.display.right.table, [
        ...(bySource.get(relation.relation.display.right.table) ?? []),
        relation.relation.display.left.table,
      ]);
    }
    const top1Hits = CALIBRATION_EXPECTATIONS.filter(({ source, target }) =>
      bySource.get(source)?.[0] === target,
    ).length;
    const top5Hits = CALIBRATION_EXPECTATIONS.filter(({ source, target }) =>
      bySource.get(source)?.slice(0, 5).includes(target),
    ).length;
    const top1Rate = top1Hits / CALIBRATION_EXPECTATIONS.length;
    const top5Rate = top5Hits / CALIBRATION_EXPECTATIONS.length;

    const first = labels(aggregate);
    const rebuilt = labels(aggregateWorkspaceIndex(await indexFiles(files), { now }));
    const stability = first.length === rebuilt.length
      && first.every((label, index) => label === rebuilt[index]);

    const incrementalEngine = new WorkspaceIndexEngine({
      databaseKind: "netezza",
      now: () => now,
      salt: "0011223344556677",
    });
    await incrementalEngine.reconcile(files.slice(0, 2));
    for (const file of files.slice(2)) {
      await incrementalEngine.indexFile(file);
    }
    const incremental = incrementalEngine.getAggregate();
    const full = aggregateWorkspaceIndex(await indexFiles(files), { now });
    const incrementalStability = JSON.stringify(incremental) === JSON.stringify(full);

    const report = {
      corpus: "synthetic-maintainer-labels",
      expectations: CALIBRATION_EXPECTATIONS.length,
      eligibleRelations: eligible.length,
      top1Hits,
      top5Hits,
      top1Rate,
      top5Rate,
      fullRebuildStability: stability,
      fullVsIncrementalStability: incrementalStability,
    };
    console.log(JSON.stringify(report));
    expect(top1Rate).toBeGreaterThanOrEqual(0.9);
    expect(top5Rate).toBeGreaterThanOrEqual(0.9);
    expect(stability).toBe(true);
    expect(incrementalStability).toBe(true);
  });
});

async function indexFiles(files: WorkspaceFileInput[]): Promise<WorkspaceFileIndexRecord[]> {
  const engine = new WorkspaceIndexEngine({
    databaseKind: "netezza",
    now: () => now,
    salt: "0011223344556677",
  });
  await engine.reconcile(files);
  return engine
    .getPersistedState(now)
    .files;
}
