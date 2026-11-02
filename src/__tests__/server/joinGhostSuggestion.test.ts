jest.unmock("chevrotain");

import { TextDocument } from "vscode-languageserver-textdocument";
import {
  canonicalizeRelation,
  isConfidentJoinSuggestion,
  JoinKnowledgeStore,
} from "@justybase/sql-core/joinKnowledge";
import { CatalogReplayMetadataProvider, type ReplayCatalog } from "../../knowledge/replayCatalog";
import type { JoinGhostMode } from "../../lsp/protocol";
import { LspCompletionEngine } from "../../server/completionEngine";
import { computeJoinGhostSuggestion, detectJoinGhostSlot } from "../../server/joinGhostSuggestion";
import { __TEST_ONLY_resetJoinKnowledge, setJoinKnowledgeSnapshot } from "../../server/joinKnowledgeRanking";

const fk = (fromTable: string, fromColumn: string, toTable: string, toColumn: string) => ({
  fromSchema: "ADMIN", fromTable, fromColumn,
  toSchema: "ADMIN", toTable, toColumn,
  constraintName: `FK_${fromTable}_${toTable}`, ordinalPosition: 1,
});

const catalog: ReplayCatalog = {
  database: "DWH",
  defaultSchema: "ADMIN",
  tables: [
    {
      schema: "ADMIN", name: "FACTINTERNETSALES",
      columns: ["PRODUCTKEY", "ORDERDATEKEY", "SHIPDATEKEY", "SALESAMOUNT"].map((name) => ({ name })),
    },
    { schema: "ADMIN", name: "DIMPRODUCT", columns: ["PRODUCTKEY", "COLOR"].map((name) => ({ name })) },
    { schema: "ADMIN", name: "DIMDATE", columns: ["DATEKEY", "CALENDARYEAR"].map((name) => ({ name })) },
    { schema: "ADMIN", name: "MIS_DIM_REGION", columns: [{ name: "REGION_ID", isPk: true }] },
    {
      schema: "ADMIN", name: "MIS_DIM_BRANCH",
      columns: [
        { name: "BRANCH_ID", isPk: true },
        { name: "REGION_ID", isFk: true, references: [fk("MIS_DIM_BRANCH", "REGION_ID", "MIS_DIM_REGION", "REGION_ID")] },
      ],
    },
  ],
};

async function ghost(sql: string, mode: JoinGhostMode = "afterJoin", after = "") {
  const engine = new LspCompletionEngine(new CatalogReplayMetadataProvider(catalog, "netezza"));
  const document = TextDocument.create("file:///ghost.sql", "sql", 1, `${sql}${after}`);
  return computeJoinGhostSuggestion(engine, document, document.positionAt(sql.length), mode);
}

const FACT_PRODUCT = {
  left: { database: "DWH", schema: "ADMIN", table: "FACTINTERNETSALES" },
  right: { database: "DWH", schema: "ADMIN", table: "DIMPRODUCT" },
  columns: [{ left: "PRODUCTKEY", right: "PRODUCTKEY" }],
};

/** Two executions on different days: the relation reaches the `0_4_` tier. */
function executeFactProduct(): void {
  const store = new JoinKnowledgeStore();
  const relation = canonicalizeRelation(FACT_PRODUCT, "netezza")!;
  ["2026-10-25", "2026-10-26"].forEach((date, index) => store.recordExecutedStatement({
    executionKey: `run-${index}`,
    databaseKind: "netezza",
    relations: [relation],
    objects: [],
    now: `${date}T10:00:00.000Z`,
  }));
  setJoinKnowledgeSnapshot(store.buildSnapshot(), { now: "2026-10-27T10:00:00.000Z" });
}

/** A starred relation reaches the `0_3_` tier. */
function favoriteFactProduct(): void {
  const store = new JoinKnowledgeStore();
  store.appendRelationOverride({
    kind: "favorite",
    relation: FACT_PRODUCT,
    databaseKind: "netezza",
    now: "2026-10-26T10:00:00.000Z",
  });
  setJoinKnowledgeSnapshot(store.buildSnapshot(), { now: "2026-10-27T10:00:00.000Z" });
}

describe("JOIN ghost gate", () => {
  it("accepts a qualifying top tier only without a same-tier runner-up", () => {
    expect(isConfidentJoinSuggestion("target", "0_3_30_A", "2_40_B")).toBe(true);
    expect(isConfidentJoinSuggestion("target", "0_3_30_A", "0_3_60_B")).toBe(false);
    // Executed means valid, not "next": 0/3 correct target ghosts on the star corpus.
    expect(isConfidentJoinSuggestion("target", "0_4_30_A", "2_40_B")).toBe(false);
    expect(isConfidentJoinSuggestion("target", "0_5_20_A", undefined)).toBe(false);
    expect(isConfidentJoinSuggestion("target", "2_20_A", undefined)).toBe(false);
    expect(isConfidentJoinSuggestion("predicate", "0_6_40_A", "0_7_40_B")).toBe(true);
    expect(isConfidentJoinSuggestion("predicate", "0_6_40_A", "0_6_46_B")).toBe(false);
    expect(isConfidentJoinSuggestion("predicate", "0_7_40_A", undefined)).toBe(false);
    expect(isConfidentJoinSuggestion("predicate", undefined, undefined)).toBe(false);
  });
});

describe("JOIN ghost slots", () => {
  const slot = (before: string, after = "", mode: JoinGhostMode = "afterJoinAndNewLine") =>
    detectJoinGhostSlot(before, after, mode);

  it("finds the target, ON and condition positions", () => {
    expect(slot("SELECT * FROM F JOIN ")).toEqual({ kind: "target", lead: "" });
    expect(slot("SELECT * FROM F LEFT OUTER JOIN ")).toEqual({ kind: "target", lead: "" });
    expect(slot("SELECT * FROM F JOIN DWH..DIMDATE D ")).toEqual({ kind: "predicate", lead: "ON " });
    expect(slot("SELECT * FROM F JOIN DIMDATE AS D ")).toEqual({ kind: "predicate", lead: "ON " });
    expect(slot("SELECT * FROM F JOIN DIMDATE ")).toEqual({ kind: "predicate", lead: "ON " });
    expect(slot("SELECT * FROM F JOIN DIMDATE D ON ")).toEqual({ kind: "predicate", lead: "" });
  });

  it("offers a whole JOIN on an empty line that ends a top-level FROM clause", () => {
    expect(slot("SELECT *\nFROM F\n")).toEqual({ kind: "target", lead: "JOIN " });
    expect(slot("SELECT *\nFROM F\nJOIN D ON F.K = D.K\n  ", "\nWHERE 1 = 1")).toEqual({ kind: "target", lead: "JOIN " });
    expect(slot("SELECT *\nFROM F\n", "", "afterJoin")).toBeUndefined();
  });

  it("stays silent where a JOIN would be wrong or the user is mid-token", () => {
    expect(slot("SELECT * FROM F JOIN")).toBeUndefined();
    expect(slot("SELECT * FROM F JOIN ", "DIMDATE")).toBeUndefined();
    expect(slot("SELECT * FROM F JOIN D ON F.K = ")).toBeUndefined();
    expect(slot("SELECT *\nFROM F\nWHERE F.X = 1\n")).toBeUndefined();
    expect(slot("SELECT *\nFROM F,\n")).toBeUndefined();
    expect(slot("SELECT * FROM (SELECT *\nFROM F\n")).toBeUndefined();
    expect(slot("UPDATE F SET X = 1\n")).toBeUndefined();
    expect(slot("SELECT *\nFROM F\n", "GROUP_TOTAL")).toBeUndefined();
    expect(slot("SELECT * FROM F JOIN ", "", "off")).toBeUndefined();
  });

  it("only looks at the statement that contains the cursor", () => {
    expect(slot("SELECT * FROM A JOIN B ON A.K = B.K;\nUPDATE F SET X = 1\n")).toBeUndefined();
    expect(slot("UPDATE F SET X = 1;\nSELECT *\nFROM F\n")).toEqual({ kind: "target", lead: "JOIN " });
  });
});

describe("JOIN ghost suggestions", () => {
  afterEach(() => __TEST_ONLY_resetJoinKnowledge());

  it("completes the unambiguous ON condition for a written target", async () => {
    await expect(ghost("SELECT * FROM FACTINTERNETSALES F JOIN DIMPRODUCT P ")).resolves.toMatchObject({
      kind: "predicate",
      insertText: "ON F.PRODUCTKEY = P.PRODUCTKEY",
      relation: { right: { table: "DIMPRODUCT" } },
    });
    await expect(ghost("SELECT * FROM MIS_DIM_BRANCH B JOIN MIS_DIM_REGION R ON ")).resolves.toMatchObject({
      kind: "predicate",
      insertText: "B.REGION_ID = R.REGION_ID",
    });
  });

  it("does not guess between role-playing conditions", async () => {
    await expect(ghost("SELECT * FROM FACTINTERNETSALES F JOIN DIMDATE D ON ")).resolves.toBeNull();
  });

  it("never ghosts a catalog or heuristic target, however well it ranks", async () => {
    await expect(ghost("SELECT * FROM MIS_DIM_BRANCH B JOIN ")).resolves.toBeNull();
    await expect(ghost("SELECT * FROM FACTINTERNETSALES F JOIN ")).resolves.toBeNull();
  });

  it("does not ghost an executed target: valid is not the same as next", async () => {
    executeFactProduct();
    await expect(ghost("SELECT * FROM FACTINTERNETSALES F JOIN ")).resolves.toBeNull();
    await expect(ghost("SELECT *\nFROM FACTINTERNETSALES F\n", "afterJoinAndNewLine")).resolves.toBeNull();
  });

  it("ghosts a starred target, and the whole JOIN on a new line when enabled", async () => {
    favoriteFactProduct();
    await expect(ghost("SELECT * FROM FACTINTERNETSALES F JOIN ")).resolves.toMatchObject({
      kind: "target",
      insertText: "DWH.ADMIN.DIMPRODUCT D ON F.PRODUCTKEY = D.PRODUCTKEY",
    });
    await expect(ghost("SELECT *\nFROM FACTINTERNETSALES F\n", "afterJoinAndNewLine", "\nWHERE 1 = 1")).resolves
      .toMatchObject({ kind: "target", insertText: "JOIN DWH.ADMIN.DIMPRODUCT D ON F.PRODUCTKEY = D.PRODUCTKEY" });
    await expect(ghost("SELECT *\nFROM FACTINTERNETSALES F\n", "afterJoin")).resolves.toBeNull();
  });

  it("offers the GROUP BY list only when enabled", async () => {
    const engine = new LspCompletionEngine(new CatalogReplayMetadataProvider(catalog, "netezza"));
    const sql = "SELECT p.COLOR, SUM(f.SALESAMOUNT) FROM FACTINTERNETSALES f JOIN DIMPRODUCT p ON 1 = 1 GROUP BY ";
    const document = TextDocument.create("file:///ghost.sql", "sql", 1, sql);
    const position = document.positionAt(sql.length);
    await expect(computeJoinGhostSuggestion(engine, document, position, "off", { groupBy: true }))
      .resolves.toEqual({ kind: "groupBy", insertText: "p.COLOR" });
    await expect(computeJoinGhostSuggestion(engine, document, position, "afterJoin")).resolves.toBeNull();
  });

  it("does not repeat a relation the statement already contains", async () => {
    favoriteFactProduct();
    await expect(ghost(
      "SELECT * FROM FACTINTERNETSALES F JOIN DIMPRODUCT P ON F.PRODUCTKEY = P.PRODUCTKEY JOIN ",
    )).resolves.toBeNull();
  });
});
