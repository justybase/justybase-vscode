/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, jest } from "@jest/globals";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Hover, Position } from "vscode-languageserver/node";
import { provideHover, type HoverDependencies } from "../../server/hoverEngine";
import type { MetadataBridge } from "../../server/metadataBridge";
import type { LocalDefinition } from "../../providers/types";

/*
 * Cursor positions (0-based):
 * "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 T1"
 *  FACT_SALES_2 starts at 32, ends at 44
 *  T1 starts at 45
 *
 * "SELECT * FROM JUST_DATA_2..FACT_SALES_2 T1"
 *  FACT_SALES_2 starts at 27
 *
 * "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 T1 WHERE T1.PRODUCT_ID IS NOT NULL"
 *  PRODUCT_ID starts at 57, ends at 67, middle at 62
 */

const SQL_TABLE_ALIAS = "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 T1";
const SQL_DOUBLEDOT = "SELECT * FROM JUST_DATA_2..FACT_SALES_2 T1";
const SQL_WITH_WHERE = "SELECT * FROM JUST_DATA_2.ADMIN.FACT_SALES_2 T1 WHERE T1.PRODUCT_ID IS NOT NULL";

const COLUMNS_FACT_SALES = [
  { name: "PRODUCT_ID", type: "INTEGER", description: "Foreign key to DIMPRODUCT" },
  { name: "SALES_AMOUNT", type: "DECIMAL(18,2)", description: "Net sales amount" },
];

function makeDeps(overrides?: Partial<HoverDependencies>): HoverDependencies {
  return {
    resolveSqlRenameSymbol: jest.fn(() => undefined),
    getStatementAtPosition: jest.fn(() => null),
    getAliasBindings: jest.fn(() => new Map()),
    getCompletionLocalDefinitions: jest.fn(() => []),
    findLocalDefinition: jest.fn(() => undefined),
    formatObjectPath: jest.fn(
      (db?: string, schema?: string, table?: string) =>
        [db, schema, table].filter(Boolean).join("."),
    ),
    isCancellationRequested: jest.fn(() => false),
    ...overrides,
  };
}

function makeBridge(overrides?: {
  getContext?: any;
  getTableInfo?: any;
}): MetadataBridge {
  return {
    getContext: overrides?.getContext || jest.fn(() =>
      Promise.resolve({
        effectiveDatabase: "JUST_DATA_2",
        databaseKind: "netezza",
        effectiveSchema: undefined,
      }),
    ),
    getTableInfo: overrides?.getTableInfo || jest.fn(() =>
      Promise.resolve({
        exists: true,
        table: "FACT_SALES_2",
        database: "JUST_DATA_2",
        schema: "ADMIN",
        description: "Daily sales facts",
        columns: COLUMNS_FACT_SALES,
      }),
    ),
  } as unknown as MetadataBridge;
}

function makeDocument(text: string): TextDocument {
  return TextDocument.create("file:///test.sql", "sql", 0, text);
}

function makePosition(line: number, character: number): Position {
  return { line, character };
}

function getMarkdown(hover: Hover | null): string | null {
  if (!hover) return null;
  if (typeof hover.contents === "string") return hover.contents;
  if (Array.isArray(hover.contents)) {
    return hover.contents
      .map((s) => (typeof s === "string" ? s : s.value))
      .join("\n");
  }
  return (hover.contents as { kind: string; value: string }).value;
}

function aliasBindings(
  map: Record<string, { db?: string; schema?: string; table: string }>,
): Map<string, { db?: string; schema?: string; table: string }> {
  return new Map(Object.entries(map));
}

describe("LSP hoverEngine — regression guard", () => {
  it("shows hover for an Oracle PL/SQL local variable", async () => {
    const sql = `CREATE OR REPLACE FUNCTION F(P_AMOUNT IN NUMBER)
RETURN NUMBER IS
  V_TOTAL NUMBER;
BEGIN
  V_TOTAL := P_AMOUNT;
  RETURN V_TOTAL;
END;`;
    const hover = await provideHover(
      makeDocument(sql),
      { position: makePosition(5, 10) },
      makeDeps({
        getStatementAtPosition: jest.fn(() => null),
        getCompletionLocalDefinitions: jest.fn(() => [
          { name: "V_TOTAL", type: "Variable", columns: [] },
        ]),
        findLocalDefinition: jest.fn((definitions: LocalDefinition[], name: string) =>
          definitions.find((definition) => definition.name === name),
        ),
      }),
      makeBridge({
        getContext: jest.fn(() =>
          Promise.resolve({
            effectiveDatabase: "ORCL",
            databaseKind: "oracle",
          }),
        ),
      }),
    );

    expect(getMarkdown(hover)).toContain("**PL/SQL variable** `V_TOTAL`");
  });

  // ============================================================
  // TABLE HOVER — manual resolution (no symbol)
  // ============================================================
  describe("table hover (manual, no symbol)", () => {
    const commonDeps = makeDeps({
      getAliasBindings: jest.fn(() =>
        aliasBindings({
          T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
        }),
      ) as any,
    });
    const commonBridge = makeBridge();

    it("shows table with description and column descriptions (qualified FROM)", async () => {
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        commonDeps,
        commonBridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("`JUST_DATA_2.ADMIN.FACT_SALES_2`");
      expect(md).toContain("Daily sales facts");
      expect(md).toContain("- **PRODUCT_ID** : `INTEGER`");
      expect(md).toContain("— _Foreign key to DIMPRODUCT_");
      expect(md).toContain("- **SALES_AMOUNT** : `DECIMAL(18,2)`");
      expect(md).toContain("— _Net sales amount_");
      expect(md).toContain("---");
    });

    it("shows table hover with double-dot notation (DB..TABLE)", async () => {
      const hover = await provideHover(
        makeDocument(SQL_DOUBLEDOT),
        { position: makePosition(0, 27) },
        makeDeps({
          getAliasBindings: jest.fn(() =>
            aliasBindings({
              T1: { db: "JUST_DATA_2", schema: undefined, table: "FACT_SALES_2" },
            }),
          ) as any,
        }),
        makeBridge(),
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("Daily sales facts");
    });

    it("shows table hover with cursor in middle of table name", async () => {
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 38) },
        commonDeps,
        commonBridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("Daily sales facts");
    });

    it("omits column descriptions that are empty", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            description: "Sales",
            columns: [
              { name: "PRODUCT_ID", type: "INTEGER", description: "" },
              { name: "AMOUNT", type: "DECIMAL", description: undefined },
            ],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        commonDeps,
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("- **PRODUCT_ID** : `INTEGER`");
      expect(md).toContain("- **AMOUNT** : `DECIMAL`");
      expect(md).not.toContain("—");
    });

    it("truncates column descriptions longer than 500 chars", async () => {
      const longDesc = "A".repeat(600);
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            description: "Sales",
            columns: [{ name: "PRODUCT_ID", type: "INTEGER", description: longDesc }],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        commonDeps,
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("A".repeat(500) + "…");
      expect(md).not.toContain("A".repeat(600));
    });

    it("shows PK and FK badges on columns", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            description: "Sales",
            columns: [
              { name: "ID", type: "INTEGER", isPk: true },
              { name: "PRODUCT_ID", type: "INTEGER", isFk: true, description: "Ref to product" },
            ],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        commonDeps,
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("- **ID** : `INTEGER` \u25C6");
      expect(md).toContain("- **PRODUCT_ID** : `INTEGER` \u25CB");
    });
  });

  // ============================================================
  // TABLE HOVER — symbol-based (resolveSqlRenameSymbol returns symbol)
  // ============================================================
  describe("table hover (symbol-based)", () => {
    it("shows table via symbol (kind=table_alias, alias key match)", async () => {
      const deps = makeDeps({
        resolveSqlRenameSymbol: jest.fn(() => ({
          kind: "table_alias",
          name: "T1",
          target: { text: "FACT_SALES_2" },
        })) as any,
        getAliasBindings: jest.fn(() =>
          aliasBindings({
            T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_WITH_WHERE),
        { position: makePosition(0, 45) },
        deps,
        makeBridge(),
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table alias** `T1`");
      expect(md).toContain("Daily sales facts");
      expect(md).toContain("- **PRODUCT_ID** : `INTEGER`");
      expect(md).toContain("— _Foreign key to DIMPRODUCT_");
    });

    it("shows table via symbol (kind=table, no alias key, value match)", async () => {
      const deps = makeDeps({
        resolveSqlRenameSymbol: jest.fn(() => ({
          kind: "table",
          name: "FACT_SALES_2",
          target: { text: "FACT_SALES_2" },
        })) as any,
        getAliasBindings: jest.fn(() =>
          aliasBindings({
            T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        deps,
        makeBridge(),
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("Daily sales facts");
    });
  });

  // ============================================================
  // COLUMN HOVER
  // ============================================================
  describe("column hover", () => {
    const commonDeps = makeDeps({
      getAliasBindings: jest.fn(() =>
        aliasBindings({
          T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
        }),
      ) as any,
    });
    const commonBridge = makeBridge();

    it("shows column type and description when hovering qualified column", async () => {
      const hover = await provideHover(
        makeDocument(SQL_WITH_WHERE),
        { position: makePosition(0, 57) },
        commonDeps,
        commonBridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**column** `PRODUCT_ID`");
      expect(md).toContain(": `INTEGER`");
      expect(md).toContain("Description: Foreign key to DIMPRODUCT");
    });

    it("shows column hover with cursor in middle of column name", async () => {
      const hover = await provideHover(
        makeDocument(SQL_WITH_WHERE),
        { position: makePosition(0, 62) },
        commonDeps,
        commonBridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**column** `PRODUCT_ID`");
      expect(md).toContain(": `INTEGER`");
    });

    it("returns null when qualifier is not an alias", async () => {
      const hover = await provideHover(
        makeDocument(SQL_WITH_WHERE),
        { position: makePosition(0, 57) },
        makeDeps({ getAliasBindings: jest.fn(() => new Map()) as any }),
        commonBridge,
      );
      expect(hover).toBeNull();
    });

    it("does not show Type: nor Description: when column metadata is missing", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            columns: [],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_WITH_WHERE),
        { position: makePosition(0, 57) },
        commonDeps,
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**column** `PRODUCT_ID`");
      expect(md).not.toContain(": `");
    });

    it("shows column type and description for unqualified column without table alias", async () => {
      const sql =
        "SELECT PRODUCT_ID FROM JUST_DATA_2..FACT_SALES_2";
      const hover = await provideHover(
        makeDocument(sql),
        { position: makePosition(0, 10) },
        commonDeps,
        commonBridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**column** `PRODUCT_ID`");
      expect(md).toContain(": `INTEGER`");
      expect(md).toContain("Description: Foreign key to DIMPRODUCT");
      expect(md).toContain("→ `JUST_DATA_2.ADMIN.FACT_SALES_2`");
    });

    it("returns null for ambiguous unqualified column across joined tables", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn((
          _uri: string,
          _db: string,
          table: string,
        ) => {
          if (table.toUpperCase() === "PRODUCT_ID") {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            exists: true,
            table,
            database: "JUST_DATA_2",
            schema: "ADMIN",
            description: "Sales",
            columns: COLUMNS_FACT_SALES,
          });
        }) as any,
      });
      const deps = makeDeps({
        getAliasBindings: jest.fn(() =>
          aliasBindings({
            T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
            T2: { db: "JUST_DATA_2", schema: "ADMIN", table: "DIM_PRODUCT" },
          }),
        ) as any,
      });
      const sql =
        "SELECT PRODUCT_ID FROM JUST_DATA_2..FACT_SALES_2 T1 JOIN JUST_DATA_2..DIM_PRODUCT T2 ON 1=1";
      const hover = await provideHover(
        makeDocument(sql),
        { position: makePosition(0, 7) },
        deps,
        bridge,
      );
      expect(hover).toBeNull();
    });
  });

  // ============================================================
  // EDGE CASES & CANCELLATION
  // ============================================================
  describe("edge cases", () => {
    it("returns null on cancellation", async () => {
      const deps = makeDeps({ isCancellationRequested: jest.fn(() => true) as any });
      const hover = await provideHover(
        makeDocument("SELECT 1"),
        { position: makePosition(0, 0) },
        deps,
        makeBridge(),
      );
      expect(hover).toBeNull();
    });

    it("returns null when cursor is not on a word", async () => {
      const hover = await provideHover(
        makeDocument(" "),
        { position: makePosition(0, 0) },
        makeDeps(),
        makeBridge(),
      );
      expect(hover).toBeNull();
    });

    it("handles table with no columns in metadata", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            description: "Empty table",
            columns: [],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        makeDeps({
          getAliasBindings: jest.fn(() =>
            aliasBindings({
              T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
            }),
          ) as any,
        }),
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("Empty table");
      expect(md).not.toContain("---");
    });

    it("handles table with no description", async () => {
      const bridge = makeBridge({
        getTableInfo: jest.fn(() =>
          Promise.resolve({
            exists: true,
            table: "FACT_SALES_2",
            database: "JUST_DATA_2",
            schema: "ADMIN",
            columns: [{ name: "ID", type: "INTEGER" }],
          }),
        ) as any,
      });
      const hover = await provideHover(
        makeDocument(SQL_TABLE_ALIAS),
        { position: makePosition(0, 32) },
        makeDeps({
          getAliasBindings: jest.fn(() =>
            aliasBindings({
              T1: { db: "JUST_DATA_2", schema: "ADMIN", table: "FACT_SALES_2" },
            }),
          ) as any,
        }),
        bridge,
      );
      const md = getMarkdown(hover);
      expect(md).toContain("**table** `FACT_SALES_2`");
      expect(md).toContain("---");
    });
  });
});
