import {
  NETEZZA_BUILTIN_FUNCTIONS,
  NETEZZA_SPECIAL_BUILTIN_VALUES,
  NETEZZA_SYSTEM_COLUMNS,
} from "../../../dialects/netezza/sql/builtins";
import {
  BASE_SQL_BUILTIN_FUNCTIONS,
  BASE_SQL_SPECIAL_BUILTIN_VALUES,
} from "../../../sql/authoring/baseProfiles";

const characterStringFns = [
  "ASCII",
  "BTRIM",
  "CHR",
  "INITCAP",
  "INSTR",
  "LENGTH",
  "LOWER",
  "LPAD",
  "LTRIM",
  "REPEAT",
  "RPAD",
  "RTRIM",
  "STRPOS",
  "SUBSTR",
  "TRANSLATE",
  "UPPER",
  "UNICHR",
  "UNICODE",
  "UNICODES",
] as const;

const dateTimeFns = [
  "ADD_MONTHS",
  "AGE",
  "DATE_PART",
  "DATE_TRUNC",
  "EXTRACT",
  "LAST_DAY",
  "MONTHS_BETWEEN",
  "NEXT_DAY",
  "NOW",
  "OVERLAPS",
  "DURATION_ADD",
  "DURATION_SUBTRACT",
  "TIMEOFDAY",
  "TIMEZONE",
] as const;

const conversionFns = [
  "HEX_TO_BINARY",
  "HEX_TO_GEOMETRY",
  "INT_TO_STRING",
  "STRING_TO_INT",
  "TO_CHAR",
  "TO_NUMBER",
  "TO_DATE",
  "TO_TIMESTAMP",
] as const;

const regexpFns = [
  "REGEXP_REPLACE",
  "REGEXP_CAPTURE",
  "REGEXP_COUNT",
  "REGEXP_EXTRACT",
  "REGEXP_FIND",
  "REGEXP_GMATCH",
  "REGEXP_GSPLIT",
  "REGEXP_LIKE",
  "REGEXP_SPLIT",
] as const;

const stringUtilityFns = [
  "BASENAME",
  "DIRNAME",
  "STRLEN",
  "SPLIT",
  "JOIN",
  "URLDECODE",
  "URLENCODE",
  "URLPARSEQUERY",
] as const;

const miscellaneousFns = [
  "ISFALSE",
  "ISNOTFALSE",
  "ISTRUE",
  "ISNOTTRUE",
  "VERSION",
  "GET_VIEWDEF",
  "WIDTH_BUCKET",
] as const;

const mathFns = [
  "ABS",
  "ACOS",
  "ASIN",
  "ATAN",
  "ATAN2",
  "CEIL",
  "COS",
  "COT",
  "DCEIL",
  "DEGREES",
  "DFLOOR",
  "EXP",
  "FLOOR",
  "FPOW",
  "LN",
  "LOG",
  "MOD",
  "NUMERIC_SQRT",
  "PI",
  "POW",
  "RADIANS",
  "RANDOM",
  "ROUND",
  "SETSEED",
  "SIGN",
  "SIN",
  "SQRT",
  "TAN",
  "TRUNC",
] as const;

const binaryMathFns = ["1", "2", "4", "8"].flatMap((width) => [
  `INT${width}AND`,
  `INT${width}OR`,
  `INT${width}XOR`,
  `INT${width}NOT`,
  `INT${width}SHL`,
  `INT${width}SHR`,
]);

describe("Netezza builtins", () => {
  describe("NETEZZA_BUILTIN_FUNCTIONS", () => {
    it("includes all base SQL built-in functions", () => {
      for (const fn of BASE_SQL_BUILTIN_FUNCTIONS) {
        expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      }
    });

    it.each(characterStringFns)(
      "includes IBM character string function: %s",
      (fn) => {
        expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      },
    );

    it.each(dateTimeFns)("includes IBM date/time function: %s", (fn) => {
      expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it.each(conversionFns)("includes IBM conversion function: %s", (fn) => {
      expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it.each(miscellaneousFns)(
      "includes IBM miscellaneous function: %s",
      (fn) => {
        expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      },
    );

    it.each(mathFns)("includes IBM math function: %s", (fn) => {
      expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it.each(binaryMathFns)("includes IBM binary math function: %s", (fn) => {
      expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it.each(regexpFns)("includes Netezza regexp function: %s", (fn) => {
      expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
    });

    it.each(stringUtilityFns)(
      "includes Netezza string utility function: %s",
      (fn) => {
        expect(NETEZZA_BUILTIN_FUNCTIONS.has(fn)).toBe(true);
      },
    );
  });

  describe("NETEZZA_SPECIAL_BUILTIN_VALUES", () => {
    it("includes all base SQL special builtin values", () => {
      for (const value of BASE_SQL_SPECIAL_BUILTIN_VALUES) {
        expect(NETEZZA_SPECIAL_BUILTIN_VALUES.has(value)).toBe(true);
      }
    });

    it.each(["CURRENT_TIMEZONE", "CURRENT_SID", "CURRENT_DB"])(
      "includes Netezza-specific builtin value: %s",
      (value) => {
        expect(NETEZZA_SPECIAL_BUILTIN_VALUES.has(value)).toBe(true);
      },
    );
  });

  describe("NETEZZA_SYSTEM_COLUMNS", () => {
    it.each(["ROWID", "CREATEXID", "DELETEXID", "DATASLICEID"])(
      "includes Netezza system column: %s",
      (column) => {
        expect(NETEZZA_SYSTEM_COLUMNS.has(column)).toBe(true);
      },
    );
  });
});