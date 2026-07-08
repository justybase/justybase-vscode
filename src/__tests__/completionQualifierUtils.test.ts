import { describe, expect, it } from "@jest/globals";
import {
  dedupeWildcardSources,
  normalizeQualifierPath,
  parseQualifierPathToSource,
} from "../server/completionQualifierUtils";

describe("completionQualifierUtils", () => {
  it("normalizes quoted qualifier parts while preserving empty double-dot segments", () => {
    expect(normalizeQualifierPath('"JUST_DATA"..[DIMACCOUNT]')).toBe(
      "JUST_DATA..DIMACCOUNT",
    );
  });

  it("maps two-part schema paths for schema-object dialects", () => {
    expect(parseQualifierPathToSource("public.orders", "postgresql")).toEqual(
      {
        schema: "public",
        table: "orders",
      },
    );
  });

  it("maps two-part database paths for database-object dialects", () => {
    expect(parseQualifierPathToSource("main.orders", "sqlite")).toEqual({
      db: "main",
      table: "orders",
    });
  });

  it("preserves Netezza-style double-dot paths only for supporting dialects", () => {
    expect(parseQualifierPathToSource("JUST_DATA..DIMACCOUNT", "netezza")).toEqual(
      {
        db: "JUST_DATA",
        table: "DIMACCOUNT",
      },
    );
    expect(parseQualifierPathToSource("JUST_DATA..DIMACCOUNT", "postgresql")).toBeUndefined();
  });

  it("deduplicates wildcard sources case-insensitively while preserving order", () => {
    expect(
      dedupeWildcardSources([
        { db: "APPDB", schema: "public", table: "orders" },
        { db: "appdb", schema: "PUBLIC", table: "ORDERS" },
        { db: "APPDB", schema: "sales", table: "orders" },
      ]),
    ).toEqual([
      { db: "APPDB", schema: "public", table: "orders" },
      { db: "APPDB", schema: "sales", table: "orders" },
    ]);
  });
});