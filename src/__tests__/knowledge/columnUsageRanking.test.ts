jest.unmock("chevrotain");

import {
  aggregateWorkspaceIndex,
  columnUsageKey,
  diffWorkspaceIndex,
  JoinKnowledgeStore,
  mergeJoinKnowledgeIndexDelta,
  objectRefKey,
  type JoinKnowledgeSnapshot,
  type WorkspaceFileIndexRecord,
} from "@justybase/sql-core/joinKnowledge";
import { extractWorkspaceSql } from "../../knowledge/workspaceSqlExtractor";
import {
  parseWorkspaceIndexState,
  WorkspaceIndexEngine,
  type WorkspaceFileInput,
} from "../../knowledge/workspaceIndexEngine";
import {
  __TEST_ONLY_resetJoinKnowledge,
  getColumnUsageBands,
  setJoinKnowledgeSnapshot,
} from "../../server/joinKnowledgeRanking";

const NOW = "2026-10-26T12:00:00.000Z";

function columnsOf(sql: string): string[] {
  return extractWorkspaceSql(sql, { databaseKind: "netezza", fingerprint: (value) => value })
    .columns
    .map((entry) => `${entry.object.name}.${entry.column}`)
    .sort();
}

function record(relPath: string, sql: string): WorkspaceFileIndexRecord {
  const extraction = extractWorkspaceSql(sql, { databaseKind: "netezza", fingerprint: (value) => value });
  return {
    relPath,
    size: sql.length,
    mtimeMs: Date.parse("2026-10-20T00:00:00.000Z"),
    contentHash: relPath,
    dirty: false,
    open: false,
    fingerprints: extraction.fingerprints,
    relations: extraction.relations,
    objects: extraction.objects,
    columns: extraction.columns,
    skipped: extraction.skipped,
  };
}

function input(relPath: string, text: string): WorkspaceFileInput & { reads: { value: number } } {
  const reads = { value: 0 };
  return {
    relPath,
    size: Buffer.byteLength(text, "utf8"),
    mtimeMs: 1000,
    dirty: false,
    open: false,
    loadText: () => {
      reads.value += 1;
      return text;
    },
    reads,
  } as WorkspaceFileInput & { reads: { value: number } };
}

describe("column usage extraction", () => {
  it("records qualified columns through their alias and the sole unqualified table", () => {
    expect(columnsOf(
      "SELECT o.ORDER_ID, c.NAME FROM ORDERS o JOIN CUSTOMERS c ON o.CUSTOMER_ID = c.CUSTOMER_ID "
      + "WHERE o.STATUS = 'OPEN' ORDER BY c.NAME;",
    )).toEqual([
      "CUSTOMERS.CUSTOMER_ID",
      "CUSTOMERS.NAME",
      "ORDERS.CUSTOMER_ID",
      "ORDERS.ORDER_ID",
      "ORDERS.STATUS",
    ]);
    expect(columnsOf("SELECT status, amount FROM orders WHERE region = 'EU';")).toEqual([
      "ORDERS.AMOUNT",
      "ORDERS.REGION",
      "ORDERS.STATUS",
    ]);
  });

  it("skips unqualified columns when more than one source is in scope", () => {
    expect(columnsOf("SELECT NAME FROM ORDERS o JOIN CUSTOMERS c ON o.CUSTOMER_ID = c.CUSTOMER_ID;"))
      .not.toContain("ORDERS.NAME");
    expect(columnsOf("SELECT NAME FROM ORDERS o JOIN CUSTOMERS c ON o.CUSTOMER_ID = c.CUSTOMER_ID;"))
      .not.toContain("CUSTOMERS.NAME");
  });

  it("gives a nested SELECT its own scope and ignores CTE and derived sources", () => {
    const columns = columnsOf(
      "WITH recent AS (SELECT ORDER_ID FROM ORDERS WHERE CREATED_AT > CURRENT_DATE - 7) "
      + "SELECT r.ORDER_ID, d.TOTAL FROM recent r "
      + "JOIN (SELECT ORDER_ID, SUM(AMOUNT) AS TOTAL FROM PAYMENTS GROUP BY ORDER_ID) d ON d.ORDER_ID = r.ORDER_ID;",
    );
    expect(columns).toEqual(expect.arrayContaining([
      "ORDERS.ORDER_ID",
      "ORDERS.CREATED_AT",
      "PAYMENTS.AMOUNT",
      "PAYMENTS.ORDER_ID",
    ]));
    expect(columns.some((entry) => entry.startsWith("RECENT."))).toBe(false);
    expect(columns).not.toContain("PAYMENTS.TOTAL");
  });

  it("never stores literals or a wildcard as a column", () => {
    const columns = columnsOf("SELECT o.* FROM ORDERS o WHERE o.NOTE = 'secret value';");
    expect(columns).toEqual(["ORDERS.NOTE"]);
  });
});

describe("workspace column aggregation", () => {
  it("publishes only eligible columns and diffs them by key", () => {
    const files = [
      record("a.sql", "SELECT o.STATUS, o.ORDER_ID FROM ORDERS o;"),
      record("b.sql", "SELECT o.STATUS FROM ORDERS o WHERE o.ORDER_ID > 1;"),
      record("c.sql", "SELECT o.NOTE FROM ORDERS o;"),
    ];
    const aggregate = aggregateWorkspaceIndex(files, { now: NOW });
    expect(aggregate.columns.map((entry) => entry.column).sort()).toEqual(["ORDER_ID", "STATUS"]);
    expect(aggregate.columnsBelowThreshold).toBe(1);

    const next = aggregateWorkspaceIndex(files.slice(1), { now: NOW });
    const delta = diffWorkspaceIndex(aggregate, next, { generatedAt: NOW, truncated: false });
    const statusKey = columnUsageKey(objectRefKey({ name: "ORDERS" }), "STATUS")!;
    expect(delta.columnsRemove).toEqual(expect.arrayContaining([statusKey]));

    const merged = mergeJoinKnowledgeIndexDelta({
      version: 1,
      relations: [],
      objectPreferences: [],
      workspace: {
        version: 1,
        relations: aggregate.relations,
        objects: aggregate.objects,
        columns: aggregate.columns,
        truncated: false,
        generatedAt: NOW,
      },
    }, delta);
    expect(merged.workspace?.columns).toEqual([]);
  });

  it("re-parses a file whose persisted record predates column usage", async () => {
    const first = new WorkspaceIndexEngine({ databaseKind: "netezza", salt: "0011223344556677", now: () => NOW });
    const sql = "SELECT o.STATUS FROM ORDERS o;";
    await first.reconcile([input("a.sql", sql)]);
    const legacy = JSON.parse(JSON.stringify(first.getPersistedState()));
    for (const file of legacy.files) {
      delete file.columns;
    }

    const restarted = new WorkspaceIndexEngine({ databaseKind: "netezza", salt: "0011223344556677", now: () => NOW });
    restarted.load(parseWorkspaceIndexState(legacy, "netezza"));
    const again = input("a.sql", sql);
    await restarted.reconcile([again]);
    expect(again.reads.value).toBe(1);
    expect(restarted.getPersistedState().files[0].columns?.map((entry) => entry.column)).toEqual(["STATUS"]);

    // A current record is reused without reading the file.
    const current = new WorkspaceIndexEngine({ databaseKind: "netezza", salt: "0011223344556677", now: () => NOW });
    current.load(parseWorkspaceIndexState(JSON.parse(JSON.stringify(restarted.getPersistedState())), "netezza"));
    const unchanged = input("a.sql", sql);
    await current.reconcile([unchanged]);
    expect(unchanged.reads.value).toBe(0);
  });
});

describe("executed column usage", () => {
  const orders = { name: "ORDERS" };

  function execute(store: JoinKnowledgeStore, key: string, now: string, columns: string[]): void {
    store.recordExecutedStatement({
      executionKey: key,
      databaseKind: "netezza",
      relations: [],
      objects: [],
      columns: columns.map((column) => ({ object: orders, column })),
      now,
    });
  }

  it("counts a column once per execution and becomes eligible at two executions", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "e1", NOW, ["STATUS", "STATUS", "status"]);
    expect(store.getExecutedColumnEvidence()).toHaveLength(1);
    expect(store.getExecutedColumnEvidence()[0]).toMatchObject({ observations: 1, belowThreshold: true });
    execute(store, "e1", NOW, ["STATUS"]);
    expect(store.getExecutedColumnEvidence()[0].observations).toBe(1);
    execute(store, "e2", NOW, ["STATUS"]);
    expect(store.getExecutedColumnEvidence()[0]).toMatchObject({ observations: 2, belowThreshold: false });
    expect(store.describe().executed).toMatchObject({ columnsEligible: 1, columnsBelowThreshold: 0 });
  });

  it("survives a persistence round-trip and publishes no day set", () => {
    const store = new JoinKnowledgeStore();
    execute(store, "e1", "2026-10-25T10:00:00.000Z", ["STATUS"]);
    execute(store, "e2", NOW, ["STATUS"]);
    const restored = JoinKnowledgeStore.fromState(JSON.parse(JSON.stringify(store.getState())), "netezza");
    expect(restored.getExecutedColumnEvidence()[0]).toMatchObject({ observations: 2, distinctDays: 2 });
    const published = restored.buildSnapshot().executed?.columns?.[0];
    expect(published).toBeDefined();
    expect(published).not.toHaveProperty("days");
  });

  it("stops growing at the column cap and reports truncation", () => {
    const store = new JoinKnowledgeStore(undefined, { limits: { maxColumnRecords: 2 } });
    execute(store, "e1", NOW, ["A", "B", "C"]);
    expect(store.getExecutedColumnEvidence()).toHaveLength(2);
    expect(store.isExecutedTruncated()).toBe(true);
  });

  it("removes the column usage of an object deleted from executed evidence", () => {
    const store = new JoinKnowledgeStore();
    store.recordExecutedStatement({
      executionKey: "e1",
      databaseKind: "netezza",
      relations: [],
      objects: [{ object: orders, kind: "select" }],
      columns: [{ object: orders, column: "STATUS" }],
      now: NOW,
    });
    expect(store.deleteExecutedObjectEvidence(objectRefKey(orders))).toBe(true);
    expect(store.getExecutedColumnEvidence()).toHaveLength(0);
  });
});

describe("column usage bands in the language server", () => {
  afterEach(() => __TEST_ONLY_resetJoinKnowledge());

  function snapshot(files: number): JoinKnowledgeSnapshot {
    const objectKey = objectRefKey({ name: "ORDERS" });
    return {
      version: 1,
      relations: [],
      objectPreferences: [],
      workspace: {
        version: 1,
        relations: [],
        objects: [],
        columns: [
          {
            key: columnUsageKey(objectKey, "STATUS")!,
            object: { name: "ORDERS" },
            column: "STATUS",
            distinctFiles: files,
            distinctQueries: files,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
          {
            key: columnUsageKey(objectKey, "NOTE")!,
            object: { name: "ORDERS" },
            column: "NOTE",
            distinctFiles: 2,
            distinctQueries: 2,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
        ],
        truncated: false,
        generatedAt: NOW,
      },
    };
  }

  it("resolves unqualified evidence for the object in the effective scope only", () => {
    setJoinKnowledgeSnapshot(snapshot(10), { now: NOW });
    const bands = getColumnUsageBands({ database: "DWH", schema: "ADMIN", name: "ORDERS" }, "netezza", {
      database: "DWH",
      schema: "ADMIN",
    });
    expect(bands?.get("STATUS")).toBeLessThan(bands?.get("NOTE") ?? 0);
    expect(getColumnUsageBands({ database: "DWH", schema: "STAGE", name: "ORDERS" }, "netezza", {
      database: "DWH",
      schema: "ADMIN",
    })).toBeUndefined();
  });

  it("is disabled by personalizeColumns", () => {
    setJoinKnowledgeSnapshot(snapshot(10), { now: NOW, personalizeColumns: false });
    expect(getColumnUsageBands({ name: "ORDERS" }, "netezza")).toBeUndefined();
  });

  it("ignores executed column usage for other dialects", () => {
    const store = new JoinKnowledgeStore();
    for (const key of ["e1", "e2"]) {
      store.recordExecutedStatement({
        executionKey: key,
        databaseKind: "netezza",
        relations: [],
        objects: [],
        columns: [{ object: { name: "ORDERS" }, column: "STATUS" }],
        now: NOW,
      });
    }
    setJoinKnowledgeSnapshot(store.buildSnapshot(), { now: NOW });
    expect(getColumnUsageBands({ name: "ORDERS" }, "netezza")?.get("STATUS")).toBeDefined();
    expect(getColumnUsageBands({ name: "ORDERS" }, "postgresql")).toBeUndefined();
  });
});
