import { describe, expect, it } from "@jest/globals";
import {
  CompletionItemKind,
  Position,
} from "vscode-languageserver/node";
import type { MetadataColumnItem, MetadataObjectItem } from "../lsp/protocol";
import type { ScopedColumnCandidate } from "../server/completionTypes";
import {
  filterMetadataItems,
  toFunctionItems,
  toMetadataColumnItem,
  toScopedColumnItems,
} from "../server/completionRenderer";
import { NETEZZA_FUNCTION_SIGNATURES } from "../dialects/netezza/sql/signatures";

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
  });
});
