import { SNOWFLAKE_FUNCTION_SIGNATURES } from "../../../../extensions/snowflake/src/sql/signatures";
import { BASE_SQL_FUNCTION_SIGNATURES } from "../../../sql/authoring/baseProfiles";

describe("Snowflake function signatures", () => {
  it("includes all base SQL function signatures", () => {
    for (const [name] of BASE_SQL_FUNCTION_SIGNATURES) {
      expect(SNOWFLAKE_FUNCTION_SIGNATURES.has(name)).toBe(true);
    }
  });

  it("has more signatures than base (Snowflake-specific additions)", () => {
    expect(SNOWFLAKE_FUNCTION_SIGNATURES.size).toBeGreaterThan(
      BASE_SQL_FUNCTION_SIGNATURES.size,
    );
  });

  // Plan-specified signatures
  const planSignatures = [
    { name: "ARRAY_AGG", expectedParams: ["expr"] },
    { name: "DATEADD", expectedParams: ["date_part", "value", "source"] },
    { name: "DATEDIFF", expectedParams: ["date_part", "source1", "source2"] },
    { name: "IFF", expectedParams: ["condition", "true_expr", "false_expr"] },
    { name: "PARSE_JSON", expectedParams: ["text_expr"] },
    {
      name: "FLATTEN",
      expectedParams: ["input", "path", "outer", "recursive", "mode"],
    },
    {
      name: "OBJECT_CONSTRUCT",
      expectedParams: ["key1", "val1", "key2", "val2", "..."],
    },
  ];

  it.each(planSignatures)(
    "has signature for $name with correct parameters",
    ({ name, expectedParams }) => {
      const sigs = SNOWFLAKE_FUNCTION_SIGNATURES.get(name);
      expect(sigs).toBeDefined();
      expect(sigs!.length).toBeGreaterThanOrEqual(1);
      const firstSig = sigs![0];
      expect(firstSig.name).toContain(name);
      expect(firstSig.parameters).toEqual(expectedParams);
      expect(firstSig.description).toBeTruthy();
    },
  );

  // Additional Snowflake-specific signatures present
  const additionalSignatures = [
    "LISTAGG",
    "APPROX_COUNT_DISTINCT",
    "ZEROIFNULL",
    "TO_VARIANT",
    "TRY_TO_DATE",
    "TRY_TO_TIMESTAMP",
    "TRY_TO_NUMBER",
    "CONVERT_TIMEZONE",
    "GET",
    "GET_PATH",
    "ARRAY_CONSTRUCT",
    "OBJECT_KEYS",
    "ARRAY_SIZE",
    "RESULT_SCAN",
    "GENERATOR",
    "CURRENT_DATABASE",
    "CURRENT_SCHEMA",
    "CURRENT_WAREHOUSE",
    "CURRENT_ROLE",
    "CURRENT_USER",
    "CURRENT_ACCOUNT",
    "LAST_QUERY_ID",
    "UUID_STRING",
    "HASH",
    "HASH_AGG",
    "MD5",
    "SHA1",
    "SHA2",
    "UNIFORM",
  ];

  it.each(additionalSignatures)("has signature for: %s", (name) => {
    const sigs = SNOWFLAKE_FUNCTION_SIGNATURES.get(name);
    expect(sigs).toBeDefined();
    expect(sigs!.length).toBeGreaterThanOrEqual(1);
    expect(sigs![0].description).toBeTruthy();
  });

  // Base signatures are preserved
  const baseSignatures = [
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "CAST",
    "COALESCE",
    "ROUND",
  ];
  it.each(baseSignatures)("preserves base signature for: %s", (name) => {
    expect(SNOWFLAKE_FUNCTION_SIGNATURES.has(name)).toBe(true);
  });
});
