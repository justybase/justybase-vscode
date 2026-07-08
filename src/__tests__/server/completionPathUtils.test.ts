import {
  buildMetadataLookupTargets,
  isNetezzaDoubleDotSource,
} from "../../server/completionPathUtils";

describe("completionPathUtils Netezza double-dot lookup", () => {
  const source = { db: "JUST_DATA_5", table: "DIMACCOUNT_NS" };

  it("identifies DB..TABLE alias bindings as double-dot sources", () => {
    expect(isNetezzaDoubleDotSource(source, "netezza")).toBe(true);
    expect(
      isNetezzaDoubleDotSource(
        { db: "JUST_DATA_5", schema: "PUBLIC", table: "DIMACCOUNT_NS" },
        "netezza",
      ),
    ).toBe(false);
  });

  it("schemas OFF: does not apply effectiveSchema for DB..TABLE", () => {
    const targets = buildMetadataLookupTargets(
      source,
      "JUST_DATA",
      "ADMIN",
      "netezza",
      { netezzaSchemasEnabled: false },
    );

    expect(targets[0]).toEqual({
      database: "JUST_DATA_5",
      schema: undefined,
      table: "DIMACCOUNT_NS",
    });
  });

  it("schemas ON: uses database DEFSCHEMA instead of effectiveSchema", () => {
    const targets = buildMetadataLookupTargets(
      source,
      "JUST_DATA",
      "ADMIN",
      "netezza",
      {
        netezzaSchemasEnabled: true,
        netezzaDefaultSchemaForDatabase: "PUBLIC",
      },
    );

    expect(targets[0]).toEqual({
      database: "JUST_DATA_5",
      schema: "PUBLIC",
      table: "DIMACCOUNT_NS",
    });
  });

  it("unqualified table still uses effectiveSchema", () => {
    const targets = buildMetadataLookupTargets(
      { table: "DIMACCOUNT_NS" },
      "JUST_DATA_5",
      "ADMIN",
      "netezza",
      { netezzaSchemasEnabled: true },
    );

    expect(targets[0]).toEqual({
      database: "JUST_DATA_5",
      schema: "ADMIN",
      table: "DIMACCOUNT_NS",
    });
  });
});
