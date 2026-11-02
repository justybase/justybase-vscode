jest.unmock("chevrotain");

import { CompletionTriggerKind, type CompletionItem } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CatalogReplayMetadataProvider, type ReplayCatalog } from "../../knowledge/replayCatalog";
import { LspCompletionEngine } from "../../server/completionEngine";
import { __TEST_ONLY_resetJoinKnowledge } from "../../server/joinKnowledgeRanking";

const fk = (fromTable: string, fromColumn: string, toTable: string, toColumn: string) => ({
  fromSchema: "ADMIN", fromTable, fromColumn,
  toSchema: "ADMIN", toTable, toColumn,
  constraintName: `FK_${fromTable}_${toTable}`, ordinalPosition: 1,
});

/** AdventureWorks-style tables without keys plus an MIS-style FK snowflake. */
const catalog: ReplayCatalog = {
  database: "DWH",
  defaultSchema: "ADMIN",
  tables: [
    {
      schema: "ADMIN", name: "FACTINTERNETSALES",
      columns: ["PRODUCTKEY", "ORDERDATEKEY", "SHIPDATEKEY", "SALESAMOUNT"].map((name) => ({ name })),
    },
    {
      schema: "ADMIN", name: "DIMPRODUCT",
      columns: ["PRODUCTKEY", "PRODUCTSUBCATEGORYKEY", "COLOR"].map((name) => ({ name })),
    },
    {
      schema: "ADMIN", name: "DIMPRODUCTSUBCATEGORY",
      columns: ["PRODUCTSUBCATEGORYKEY", "ENGLISHPRODUCTSUBCATEGORYNAME"].map((name) => ({ name })),
    },
    { schema: "ADMIN", name: "DIMDATE", columns: ["DATEKEY", "CALENDARYEAR"].map((name) => ({ name })) },
    {
      schema: "ADMIN", name: "MIS_DIM_REGION",
      columns: [{ name: "REGION_ID", isPk: true }, { name: "REGION_NAME" }],
    },
    {
      schema: "ADMIN", name: "MIS_DIM_BRANCH",
      columns: [
        { name: "BRANCH_ID", isPk: true },
        { name: "REGION_ID", isFk: true, references: [fk("MIS_DIM_BRANCH", "REGION_ID", "MIS_DIM_REGION", "REGION_ID")] },
      ],
    },
    {
      schema: "ADMIN", name: "MIS_FACT_SALES",
      columns: [
        { name: "SALE_ID", isPk: true },
        { name: "BRANCH_ID", isFk: true, references: [fk("MIS_FACT_SALES", "BRANCH_ID", "MIS_DIM_BRANCH", "BRANCH_ID")] },
      ],
    },
  ],
};

async function joinTargets(sql: string): Promise<CompletionItem[]> {
  const engine = new LspCompletionEngine(new CatalogReplayMetadataProvider(catalog, "netezza"));
  const document = TextDocument.create("file:///catalog-join.sql", "sql", 1, sql);
  const items = await engine.provideCompletionItems(
    document,
    document.positionAt(sql.length),
    CompletionTriggerKind.TriggerCharacter,
  );
  return items
    .filter((item) => (item.data as { joinKnowledgeRelation?: unknown } | undefined)?.joinKnowledgeRelation)
    .sort((left, right) => String(left.sortText).localeCompare(String(right.sortText)));
}

describe("catalog JOIN targets", () => {
  afterEach(() => __TEST_ONLY_resetJoinKnowledge());

  it("suggests dimensions of an FK-less fact through self-named keys, role-playing dates separately", async () => {
    const items = await joinTargets("SELECT * FROM FACTINTERNETSALES F JOIN ");
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining([
      "DWH..DIMPRODUCT D ON F.PRODUCTKEY = D.PRODUCTKEY",
      "DWH..DIMDATE D ON F.ORDERDATEKEY = D.DATEKEY",
      "DWH..DIMDATE D ON F.SHIPDATEKEY = D.DATEKEY",
    ]));
    expect(items.every((item) => String(item.sortText).startsWith("2_"))).toBe(true);
    // Identical column names beat role-playing pairs inside the same tier.
    expect(labels[0]).toBe("DWH..DIMPRODUCT D ON F.PRODUCTKEY = D.PRODUCTKEY");
  });

  it("ranks the parent of a source above children referencing it", async () => {
    const items = await joinTargets("SELECT * FROM MIS_DIM_BRANCH B JOIN ");
    expect(items.map((item) => String(item.sortText).slice(0, 4))).toEqual(["0_2_", "0_2_"]);
    expect(items[0].label).toMatch(/^DWH..MIS_DIM_REGION /u);
    expect(items[1].label).toMatch(/^DWH..MIS_FACT_SALES /u);
  });

  it("walks the snowflake: the new parent leads and the written relation sinks", async () => {
    const items = await joinTargets(
      "SELECT * FROM FACTINTERNETSALES F JOIN DIMPRODUCT P ON P.PRODUCTKEY = F.PRODUCTKEY JOIN ",
    );
    expect(items[0].label).toBe("DWH..DIMPRODUCTSUBCATEGORY D ON P.PRODUCTSUBCATEGORYKEY = D.PRODUCTSUBCATEGORYKEY");
    const repeated = items.filter((item) => item.label.includes("F.PRODUCTKEY"));
    expect(repeated.length).toBeGreaterThan(0);
    expect(repeated.every((item) => String(item.sortText).startsWith("3_"))).toBe(true);
    // A role-playing join through other columns keeps its tier.
    expect(items.find((item) => item.label.includes("F.ORDERDATEKEY"))?.sortText).toMatch(/^2_/u);
  });
});
