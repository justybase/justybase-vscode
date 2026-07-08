import {
  SNOWFLAKE_BUILTIN_FUNCTIONS,
  SNOWFLAKE_SPECIAL_BUILTIN_VALUES,
  SNOWFLAKE_SYSTEM_COLUMNS,
} from "../../../../extensions/snowflake/src/sql/builtins";
import {
  BASE_SQL_BUILTIN_FUNCTIONS,
  BASE_SQL_SPECIAL_BUILTIN_VALUES,
} from "../../../sql/authoring/baseProfiles";

describe("Snowflake builtins", () => {
  describe("SNOWFLAKE_BUILTIN_FUNCTIONS", () => {
    it("includes all base SQL built-in functions", () => {
      for (const fn of BASE_SQL_BUILTIN_FUNCTIONS) {
        expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      }
    });

    // Plan-specified aggregate functions
    const aggregateFns = [
      "ARRAY_AGG",
      "LISTAGG",
      "APPROX_COUNT_DISTINCT",
      "APPROX_TOP_K",
    ];
    it.each(aggregateFns)("includes aggregate function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified conditional functions
    const conditionalFns = [
      "COALESCE",
      "IFF",
      "IFNULL",
      "NULLIF",
      "ZEROIFNULL",
    ];
    it.each(conditionalFns)("includes conditional function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified conversion functions
    const conversionFns = [
      "TO_DATE",
      "TO_TIMESTAMP",
      "TO_NUMBER",
      "TO_VARIANT",
      "PARSE_JSON",
    ];
    it.each(conversionFns)("includes conversion function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified date/time functions
    const dateTimeFns = [
      "DATEADD",
      "DATEDIFF",
      "DATE_TRUNC",
      "LAST_DAY",
      "NEXT_DAY",
    ];
    it.each(dateTimeFns)("includes date/time function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified string functions
    const stringFns = [
      "CONCAT_WS",
      "CONTAINS",
      "ENCRYPT",
      "DECRYPT",
      "REGEXP_SUBSTR_ALL",
    ];
    it.each(stringFns)("includes string function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified semi-structured functions
    const semiStructuredFns = [
      "GET",
      "GET_PATH",
      "ARRAY_CONSTRUCT",
      "OBJECT_CONSTRUCT",
      "FLATTEN",
    ];
    it.each(semiStructuredFns)(
      "includes semi-structured function: %s",
      (fn) => {
        expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      },
    );

    // Plan-specified table functions
    const tableFns = [
      "RESULT_SCAN",
      "GENERATOR",
      "SEQ1",
      "SEQ2",
      "SEQ4",
      "SEQ8",
    ];
    it.each(tableFns)("includes table function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified window functions (from base)
    const windowFns = [
      "LAG",
      "LEAD",
      "FIRST_VALUE",
      "LAST_VALUE",
      "NTH_VALUE",
      "RANK",
      "DENSE_RANK",
      "ROW_NUMBER",
    ];
    it.each(windowFns)("includes window function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    // Plan-specified context functions
    const contextFns = [
      "CURRENT_DATABASE",
      "CURRENT_SCHEMA",
      "CURRENT_WAREHOUSE",
      "CURRENT_ROLE",
      "CURRENT_USER",
    ];
    it.each(contextFns)("includes context function: %s", (fn) => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it("is a superset of base functions (has more than base)", () => {
      expect(SNOWFLAKE_BUILTIN_FUNCTIONS.size).toBeGreaterThan(
        BASE_SQL_BUILTIN_FUNCTIONS.size,
      );
    });
  });

  describe("SNOWFLAKE_SPECIAL_BUILTIN_VALUES", () => {
    it("includes all base SQL special builtin values", () => {
      for (const val of BASE_SQL_SPECIAL_BUILTIN_VALUES) {
        expect(SNOWFLAKE_SPECIAL_BUILTIN_VALUES.has(val)).toBe(true);
      }
    });

    const snowflakeSpecificValues = [
      "CURRENT_VERSION",
      "CURRENT_STATEMENT",
      "CURRENT_TRANSACTION",
      "CURRENT_IP_ADDRESS",
      "CURRENT_REGION",
      "CURRENT_ACCOUNT",
      "CURRENT_ORGANIZATION_NAME",
    ];
    it.each(snowflakeSpecificValues)(
      "includes Snowflake-specific value: %s",
      (val) => {
        expect(SNOWFLAKE_SPECIAL_BUILTIN_VALUES.has(val)).toBe(true);
      },
    );
  });

  describe("SNOWFLAKE_SYSTEM_COLUMNS", () => {
    it("is an empty set (Snowflake has no system pseudo-columns)", () => {
      expect(SNOWFLAKE_SYSTEM_COLUMNS.size).toBe(0);
    });
  });
});
