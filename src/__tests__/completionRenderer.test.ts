import { describe, expect, it } from "@jest/globals";
import {
  CompletionItemKind,
  Position,
} from "vscode-languageserver/node";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import type { ScopedColumnCandidate } from "../server/completionTypes";
import {
  filterMetadataItems,
  filterOracleSchemaItems,
  filterOracleSourceItems,
  toFunctionItems,
  toMetadataColumnItem,
  toScopedColumnItems,
} from "../server/completionRenderer";
import { NETEZZA_FUNCTION_SIGNATURES } from "../dialects/netezza/sql/signatures";
import { dedupeCompletionItems } from "../server/completionRanker";
import {
  __TEST_ONLY_resetJoinKnowledge,
  setJoinKnowledgeSnapshot,
} from "../server/joinKnowledgeRanking";
import {
  executedObjectBandForUsage,
  JoinKnowledgeStore,
  objectRefKey,
  type JoinKnowledgeSnapshot,
} from "@justybase/sql-core/joinKnowledge";

describe("completionRenderer — documentation regression guard", () => {
  const position = Position.create(0, 10);

  describe("toScopedColumnItems", () => {
    it("sets scoped column sort priority before session variables and functions", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "ACCOUNTKEY", qualifiers: ["X"] },
      ];
      const items = toScopedColumnItems(scoped, "", position);
      expect(items[0].sortText).toBe("2_ACCOUNTKEY");
    });

    it("includes column description as documentation when present", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "PRODUCT_ID", qualifiers: ["A"], description: "Foreign key to DIMPRODUCT" },
      ];
      const items = toScopedColumnItems(scoped, "PROD", position);
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBe("Foreign key to DIMPRODUCT");
      expect(items[0].labelDetails?.description).toBe("Foreign key to DIMPRODUCT");
    });

    it("omits documentation when description is undefined", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "PRODUCT_ID", qualifiers: ["A"] },
      ];
      const items = toScopedColumnItems(scoped, "PROD", position);
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBeUndefined();
    });

    it("omits documentation when description is empty string", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "PRODUCT_ID", qualifiers: ["A"], description: "" },
      ];
      const items = toScopedColumnItems(scoped, "PROD", position);
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBeUndefined();
    });

    it("includes description for ambiguous (multi-qualifier) columns", () => {
      const scoped: ScopedColumnCandidate[] = [
        {
          column: "AMOUNT",
          qualifiers: ["A", "B"],
          description: "Transaction amount in local currency",
        },
      ];
      const items = toScopedColumnItems(scoped, "AMO", position);
      expect(items).toHaveLength(2);
      expect(items[0].documentation).toBe("Transaction amount in local currency");
      expect(items[1].documentation).toBe("Transaction amount in local currency");
    });

    it("preserves description when multiple columns exist", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "PRODUCT_ID", qualifiers: ["A"], description: "FK to product" },
        { column: "PRODUCT_NAME", qualifiers: ["A"], description: "Display name" },
      ];
      const items = toScopedColumnItems(scoped, "PROD", position);
      expect(items).toHaveLength(2);
      expect(items[0].documentation).toBe("FK to product");
      expect(items[1].documentation).toBe("Display name");
    });

    it("matches snake_case and camelCase prefixes and identifier fragments", () => {
      const scoped: ScopedColumnCandidate[] = [
        { column: "ACCOUNT_ID", qualifiers: ["A"] },
        { column: "accountOwnerId", qualifiers: ["A"] },
        { column: "CUSTOMER_CODE", qualifiers: ["A"] },
      ];
      expect(toScopedColumnItems(scoped, "accId", position).map((item) => item.label))
        .toEqual(["ACCOUNT_ID", "accountOwnerId"]);
      expect(toScopedColumnItems(scoped, "CODE", position).map((item) => item.label))
        .toEqual(["CUSTOMER_CODE"]);
    });
  });

  describe("toMetadataColumnItem", () => {
    it("includes column description as documentation when present", () => {
      const col: MetadataColumnItem = {
        name: "SALES_AMOUNT",
        type: "DECIMAL(18,2)",
        description: "Net sales amount after discounts",
      };
      const item = toMetadataColumnItem(col);
      expect(item.documentation).toBe("Net sales amount after discounts");
    });

    it("omits documentation when description is undefined", () => {
      const col: MetadataColumnItem = {
        name: "SALES_AMOUNT",
        type: "DECIMAL(18,2)",
      };
      const item = toMetadataColumnItem(col);
      expect(item.documentation).toBeUndefined();
    });

    it("omits documentation when description is empty string", () => {
      const col: MetadataColumnItem = {
        name: "SALES_AMOUNT",
        type: "DECIMAL(18,2)",
        description: "",
      };
      const item = toMetadataColumnItem(col);
      expect(item.documentation).toBeUndefined();
    });

    it("still sets detail (type) alongside documentation", () => {
      const col: MetadataColumnItem = {
        name: "ORDER_ID",
        type: "INTEGER",
        description: "Primary key",
        isPk: true,
      };
      const item = toMetadataColumnItem(col);
      expect(item.detail).toBe("INTEGER");
      expect(item.documentation).toBe("Primary key");
      expect(item.labelDetails?.description).toBe("Primary key");
    });
  });

  describe("filterMetadataItems", () => {
    it("includes table description as documentation when present", () => {
      const tables: MetadataObjectItem[] = [
        { name: "FACT_SALES", objectType: "table", description: "Daily sales facts" },
      ];
      const items = filterMetadataItems(tables, "FACT");
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBe("Daily sales facts");
      expect(items[0].labelDetails?.description).toBe("Daily sales facts");
    });

    it("omits documentation when description is undefined", () => {
      const tables: MetadataObjectItem[] = [
        { name: "FACT_SALES", objectType: "table" },
      ];
      const items = filterMetadataItems(tables, "FACT");
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBeUndefined();
    });

    it("omits documentation when description is empty string", () => {
      const tables: MetadataObjectItem[] = [
        { name: "FACT_SALES", objectType: "table", description: "" },
      ];
      const items = filterMetadataItems(tables, "FACT");
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBeUndefined();
    });

    it("preserves description for views", () => {
      const views: MetadataObjectItem[] = [
        { name: "V_SALES_SUMMARY", objectType: "view", description: "Aggregated sales by region" },
      ];
      const items = filterMetadataItems(views, "V_", CompletionItemKind.Interface);
      expect(items).toHaveLength(1);
      expect(items[0].documentation).toBe("Aggregated sales by region");
      expect(items[0].kind).toBe(CompletionItemKind.Interface);
    });

    it("preserves description across multiple filtered items", () => {
      const tables: MetadataObjectItem[] = [
        { name: "FACT_SALES", objectType: "table", description: "Sales facts" },
        { name: "FACT_INVENTORY", objectType: "table", description: "Inventory snapshot" },
      ];
      const items = filterMetadataItems(tables, "FACT");
      expect(items).toHaveLength(2);
      expect(items[0].documentation).toBe("Sales facts");
      expect(items[1].documentation).toBe("Inventory snapshot");
    });

    it("filters correctly while preserving description", () => {
      const tables: MetadataObjectItem[] = [
        { name: "FACT_SALES", objectType: "table", description: "Sales" },
        { name: "DIM_PRODUCT", objectType: "table", description: "Products" },
      ];
      const items = filterMetadataItems(tables, "DIM");
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe("DIM_PRODUCT");
      expect(items[0].documentation).toBe("Products");
    });

    it("inserts quoted SQL text for Netezza lowercase table names", () => {
      const tables: MetadataObjectItem[] = [
        { name: "lower_table", objectType: "table" },
        { name: "ORDERS", objectType: "table" },
      ];
      const items = filterMetadataItems(tables, "", undefined, "netezza");
      expect(items.find((item) => item.label === "lower_table")?.insertText).toBe(
        '"lower_table"',
      );
      expect(items.find((item) => item.label === "ORDERS")?.insertText).toBe("ORDERS");
    });

    it("preserves mixed-case MSSQL table names without quoting them", () => {
      const tables: MetadataObjectItem[] = [
        { name: "departments", objectType: "table" },
        { name: "Sales Orders", objectType: "table" },
      ];
      const items = filterMetadataItems(tables, "", undefined, "mssql");

      expect(items.find((item) => item.label === "departments")?.insertText)
        .toBe("departments");
      expect(items.find((item) => item.label === "Sales Orders")?.insertText)
        .toBe('"Sales Orders"');
    });

    it("keeps same-named objects from different schemas distinct", () => {
      const items = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
        { name: "ORDERS", database: "BAZA", schema: "PUBLIC", objectType: "table" },
      ], "", undefined, "netezza");

      const deduped = dedupeCompletionItems(items, "netezza");
      expect(deduped).toHaveLength(2);
      expect(deduped.map((item) => (item.data as { schema?: string }).schema))
        .toEqual(["ADMIN", "PUBLIC"]);
      // Acceptance still inserts only the object name; qualification is never
      // rewritten by personalization.
      expect(deduped.map((item) => item.insertText)).toEqual(["ORDERS", "ORDERS"]);
    });

    it("applies object preferences without changing insertText or crossing scope/kind", () => {
      __TEST_ONLY_resetJoinKnowledge();
      const store = new JoinKnowledgeStore();
      const now = "2026-10-25T10:00:00.000Z";
      store.appendObjectPreference({
        kind: "pin",
        object: { database: "BAZA", schema: "PUBLIC", name: "PINNED" },
        pinOrder: 1,
        databaseKind: "netezza",
        now,
        id: "p1",
      });
      store.appendObjectPreference({
        kind: "boost",
        object: { database: "BAZA", schema: "PUBLIC", name: "BOOSTED" },
        band: 0,
        databaseKind: "netezza",
        now,
        id: "p2",
      });
      store.appendObjectPreference({
        kind: "demote",
        object: { database: "BAZA", schema: "ADMIN", name: "DEMOTED" },
        databaseKind: "netezza",
        now,
        id: "p3",
      });
      store.appendObjectPreference({
        kind: "exclude",
        object: { database: "BAZA", schema: "ADMIN", name: "HIDDEN" },
        databaseKind: "netezza",
        now,
        id: "p4",
      });
      setJoinKnowledgeSnapshot(store.buildSnapshot(), {
        personalizeFromObjects: true,
      });

      const items = filterMetadataItems([
        { name: "PINNED", database: "BAZA", schema: "PUBLIC", objectType: "table" },
        { name: "BOOSTED", database: "BAZA", schema: "PUBLIC", objectType: "table" },
        { name: "NEUTRAL", database: "BAZA", schema: "ADMIN", objectType: "table" },
        { name: "DEMOTED", database: "BAZA", schema: "ADMIN", objectType: "table" },
        { name: "HIDDEN", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      const byLabel = new Map(items.map((item) => [item.label, item]));

      expect(byLabel.has("HIDDEN")).toBe(false);
      expect(byLabel.get("PINNED")?.sortText).toBe("2_010_PINNED");
      expect(byLabel.get("PINNED")?.insertText).toBe("PINNED");
      // Boost/demote stay inside scope+kind+match rank.
      expect(String(byLabel.get("BOOSTED")?.sortText)).toMatch(/^3_100_000_/u);
      expect(String(byLabel.get("NEUTRAL")?.sortText)).toMatch(/^3_000_050_/u);
      expect(String(byLabel.get("DEMOTED")?.sortText)).toMatch(/^3_000_090_/u);
      const ordered = [...items]
        .sort((left, right) => String(left.sortText).localeCompare(String(right.sortText)))
        .map((item) => item.label);
      expect(ordered.indexOf("PINNED")).toBe(0);
      expect(ordered.indexOf("DEMOTED")).toBeGreaterThan(ordered.indexOf("NEUTRAL"));
    });

    it("applies learned workspace bands only inside the FROM tie group", () => {
      __TEST_ONLY_resetJoinKnowledge();
      const object = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };
      const workspace: JoinKnowledgeSnapshot["workspace"] = {
        version: 1,
        relations: [],
        objects: [{
          key: objectRefKey(object),
          object,
          usage: { select: 3, insert: 0, update: 0, delete: 0 },
          distinctFiles: 3,
          distinctQueries: 6,
          belowThreshold: false,
          band: 10,
          firstSeenAt: "2026-10-25T10:00:00.000Z",
          lastSeenAt: "2026-10-25T10:00:00.000Z",
        }],
        truncated: false,
        generatedAt: "2026-10-25T10:00:00.000Z",
      };
      setJoinKnowledgeSnapshot({
        version: 1,
        relations: [],
        objectPreferences: [],
        workspace,
      }, { personalizeFromObjects: true });

      const items = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      expect(items.map((item) => item.sortText)).toEqual(["3_000_010_ORDERS"]);

      const disabled = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: false,
        },
      });
      expect(disabled.map((item) => item.sortText)).toEqual(["3_000_ORDERS"]);

      const nonSource = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: { role: "source", effectiveSchema: "ADMIN" },
      });
      expect(nonSource.map((item) => item.sortText)).toEqual(["3_000_ORDERS"]);

      const store = new JoinKnowledgeStore();
      store.appendObjectPreference({
        kind: "boost",
        object,
        band: 3,
        databaseKind: "netezza",
        now: "2026-10-25T10:00:00.000Z",
        id: "manual-boost",
      });
      const manual = store.buildSnapshot();
      setJoinKnowledgeSnapshot({ ...manual, workspace }, {
        personalizeFromObjects: true,
      });
      const boosted = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      expect(boosted.map((item) => item.sortText)).toEqual(["3_000_003_ORDERS"]);
    });

    it("applies executed object bands and merges them with workspace by the better band", () => {
      __TEST_ONLY_resetJoinKnowledge();
      const object = { database: "BAZA", schema: "ADMIN", name: "ORDERS" };
      const store = new JoinKnowledgeStore();
      for (const day of ["2026-10-25", "2026-10-26"]) {
        store.recordExecutedStatement({
          executionKey: `exec-${day}`,
          databaseKind: "netezza",
          relations: [],
          objects: [{ object, kind: "select" }],
          now: `${day}T10:00:00.000Z`,
        });
      }
      setJoinKnowledgeSnapshot(store.buildSnapshot(), { personalizeFromObjects: true });
      const expectedBand = executedObjectBandForUsage({ select: 2 }, 2, 2);
      expect(expectedBand).toBeDefined();

      const items = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      expect(items.map((item) => item.sortText)).toEqual([
        `3_000_0${String(expectedBand).padStart(2, "0")}_ORDERS`,
      ]);

      const workspace: JoinKnowledgeSnapshot["workspace"] = {
        version: 1,
        relations: [],
        objects: [{
          key: objectRefKey(object),
          object,
          usage: { select: 3, insert: 0, update: 0, delete: 0 },
          distinctFiles: 3,
          distinctQueries: 6,
          belowThreshold: false,
          band: 10,
          firstSeenAt: "2026-10-25T10:00:00.000Z",
          lastSeenAt: "2026-10-25T10:00:00.000Z",
        }],
        truncated: false,
        generatedAt: "2026-10-25T10:00:00.000Z",
      };
      setJoinKnowledgeSnapshot({ ...store.buildSnapshot(), workspace }, {
        personalizeFromObjects: true,
      });
      const merged = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      expect(merged.map((item) => item.sortText)).toEqual(["3_000_010_ORDERS"]);
    });

    it("ignores object preferences when FROM personalization is disabled", () => {
      __TEST_ONLY_resetJoinKnowledge();
      const store = new JoinKnowledgeStore();
      store.appendObjectPreference({
        kind: "exclude",
        object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
        databaseKind: "netezza",
        now: "2026-10-25T10:00:00.000Z",
        id: "p1",
      });
      setJoinKnowledgeSnapshot(store.buildSnapshot(), {
        personalizeFromObjects: false,
      });

      const items = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: {
          role: "source",
          effectiveSchema: "ADMIN",
          personalizeFromObjects: true,
        },
      });
      expect(items.map((item) => item.sortText)).toEqual(["3_000_ORDERS"]);
    });

    it("does not apply FROM object preferences to non-FROM target lists", () => {
      __TEST_ONLY_resetJoinKnowledge();
      const store = new JoinKnowledgeStore();
      store.appendObjectPreference({
        kind: "exclude",
        object: { database: "BAZA", schema: "ADMIN", name: "ORDERS" },
        databaseKind: "netezza",
        now: "2026-10-25T10:00:00.000Z",
        id: "p1",
      });
      setJoinKnowledgeSnapshot(store.buildSnapshot(), {
        personalizeFromObjects: true,
      });

      // INSERT/UPDATE/DELETE/ALTER target lists leave `personalizeFromObjects`
      // unset, so exclude/pin must not touch them.
      const items = filterMetadataItems([
        { name: "ORDERS", database: "BAZA", schema: "ADMIN", objectType: "table" },
      ], "", undefined, "netezza", {
        ranking: { role: "source", effectiveSchema: "ADMIN" },
      });
      expect(items.map((item) => item.sortText)).toEqual(["3_000_ORDERS"]);
    });

    it("ranks Oracle schemas before relation sources and gives synonyms a distinct kind", () => {
      const schemas = filterOracleSchemaItems(
        [{ name: "APP" }, { name: "HR" }],
        "",
        "HR",
      );
      const sources = filterOracleSourceItems([
        { name: "EMPLOYEES_SYNONYM", objectType: "synonym" },
        { name: "EMPLOYEES_MV", objectType: "materialized-view" },
        { name: "EMPLOYEES", objectType: "table" },
      ], "EMP");

      expect(schemas.map((item) => item.sortText)).toEqual([
        "0_200_HR",
        "0_300_APP",
      ]);
      expect(sources.map((item) => item.sortText)).toEqual([
        "3_000_EMPLOYEES",
        "3_010_EMPLOYEES_MV",
        "3_020_EMPLOYEES_SYNONYM",
      ]);
      expect(sources[2].kind).toBe(CompletionItemKind.Reference);
    });
  });

  describe("toFunctionItems", () => {
    it("uses signature detail and documentation when available", () => {
      const items = toFunctionItems(
        "DLE",
        position,
        ["DLE_DST", "COUNT"],
        NETEZZA_FUNCTION_SIGNATURES,
      );
      const dleDst = items.find((item) => item.label === "DLE_DST");

      expect(dleDst?.detail).toBe("DLE_DST(string1, string2)");
      expect(dleDst?.documentation).toEqual(
        expect.objectContaining({
          kind: "markdown",
          value: expect.stringContaining("SELECT dle_dst('two', 'tow')"),
        }),
      );
      expect(dleDst?.labelDetails?.description).toContain(
        "Damerau-Levenshtein edit distance",
      );
    });

    it("uses base signature detail for functions with registry entries", () => {
      const items = toFunctionItems(
        "COA",
        position,
        ["COALESCE"],
        NETEZZA_FUNCTION_SIGNATURES,
      );
      expect(items[0].detail).toBe("COALESCE(value1, value2, ...)");
    });

    it("includes both TO_CHAR examples from merged Netezza signatures", () => {
      const items = toFunctionItems(
        "TO_CHAR",
        position,
        ["TO_CHAR"],
        NETEZZA_FUNCTION_SIGNATURES,
      );
      const documentation = items[0].documentation as { value?: string } | undefined;
      expect(documentation?.value).toContain("TO_CHAR(CURRENT_DATE, 'YYYYMMDD')");
      expect(documentation?.value).toContain("TO_CHAR(CURRENT_DATE, 'YYYYMMDD')::INT");
    });

    it("falls back to generic SQL Function detail without signatures", () => {
      const items = toFunctionItems("COA", position, ["COALESCE"]);
      expect(items[0].detail).toBe("SQL Function");
      expect(items[0].documentation).toBeUndefined();
    });

    it("inserts required OVER clauses after function arguments", () => {
      const items = toFunctionItems("ROW", position, ["ROW_NUMBER"], new Map([
        ["ROW_NUMBER", [{ name: "ROW_NUMBER", parameters: ["OVER (ORDER BY ...)"], description: "Row number", window: "required" as const }]],
      ]));
      expect(items[0].insertText).toBe("ROW_NUMBER() OVER ($1)$0");
      expect(items[0].insertTextFormat).toBe(2);
    });

    it("keeps text after the cursor and emits one OVER clause", () => {
      const sql = "SELECT ROW + 1";
      const cursor = Position.create(0, "SELECT ROW".length);
      const item = toFunctionItems(
        "ROW",
        cursor,
        ["ROW_NUMBER"],
        new Map([
          ["ROW_NUMBER", [{
            name: "ROW_NUMBER",
            parameters: ["OVER (ORDER BY ...)"],
            description: "Row number",
            window: "required" as const,
          }]],
        ]),
      )[0];
      const textEdit = item.textEdit;
      if (!textEdit || !("range" in textEdit) || !("newText" in textEdit)) {
        throw new Error("Expected a prefix text edit for the function item");
      }
      const start = textEdit.range.start.character;
      const end = textEdit.range.end.character;
      const acceptedSql = `${sql.slice(0, start)}${textEdit.newText}${sql.slice(end)}`;

      expect(acceptedSql).toBe("SELECT ROW_NUMBER() OVER ($1)$0 + 1");
      expect(acceptedSql.match(/\bOVER\b/g)).toHaveLength(1);
    });

    it("offers a separate window variant for aggregate functions", () => {
      const items = toFunctionItems("SUM", position, ["SUM"], new Map([
        ["SUM", [{ name: "SUM", parameters: ["expression"], description: "Sum", window: "supported" as const }]],
      ]));
      expect(items).toHaveLength(2);
      expect(items[0].insertText).toBe("SUM()");
      expect(items[1].insertText).toBe("SUM($1) OVER ($2)$0");
      expect(items[1].filterText).toBe("SUM");
    });
  });
});
