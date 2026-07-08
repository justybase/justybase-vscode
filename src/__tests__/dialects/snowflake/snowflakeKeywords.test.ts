import {
  SNOWFLAKE_COMPLETION_KEYWORDS,
  SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS,
  snowflakeFormatterProfile,
} from "../../../../extensions/snowflake/src/sql/keywords";
import { BASE_SQL_COMPLETION_KEYWORDS } from "../../../sql/authoring/baseProfiles";

describe("Snowflake keywords", () => {
  describe("SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS", () => {
    it("has no duplicate entries", () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const kw of SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS) {
        if (seen.has(kw)) {
          duplicates.push(kw);
        }
        seen.add(kw);
      }
      expect(duplicates).toEqual([]);
    });
  });

  describe("SNOWFLAKE_COMPLETION_KEYWORDS", () => {
    it("includes all base SQL keywords", () => {
      for (const kw of BASE_SQL_COMPLETION_KEYWORDS) {
        expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
      }
    });

    it("includes all Snowflake overlays", () => {
      for (const kw of SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS) {
        expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
      }
    });

    const ddlKeywords = [
      "CLONE",
      "CLUSTER",
      "COPY",
      "STAGE",
      "FILE_FORMAT",
      "PIPE",
      "STREAM",
      "TASK",
    ];
    it.each(ddlKeywords)("includes DDL keyword: %s", (kw) => {
      expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
    });

    const dmlKeywords = ["MERGE", "INSERT OVERWRITE", "UPSERT"];
    it.each(dmlKeywords)("includes DML keyword: %s", (kw) => {
      expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
    });

    const queryKeywords = ["QUALIFY", "PIVOT", "UNPIVOT", "LATERAL"];
    it.each(queryKeywords)("includes query keyword: %s", (kw) => {
      expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
    });

    const timeTravelKeywords = ["AT", "BEFORE", "TIMESTAMP", "OFFSET"];
    it.each(timeTravelKeywords)("includes time travel keyword: %s", (kw) => {
      expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
    });

    const sessionKeywords = ["WAREHOUSE", "DATABASE", "SCHEMA", "ROLE"];
    it.each(sessionKeywords)("includes session keyword: %s", (kw) => {
      expect(SNOWFLAKE_COMPLETION_KEYWORDS).toContain(kw);
    });

    it("has no duplicate entries", () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const kw of SNOWFLAKE_COMPLETION_KEYWORDS) {
        if (seen.has(kw)) {
          duplicates.push(kw);
        }
        seen.add(kw);
      }
      expect(duplicates).toEqual([]);
    });
  });

  describe("snowflakeFormatterProfile", () => {
    it("includes Snowflake-specific newline-before keywords", () => {
      const expected = [
        "QUALIFY",
        "PIVOT",
        "UNPIVOT",
        "CLUSTER BY",
        "COPY INTO",
      ];
      for (const kw of expected) {
        expect(snowflakeFormatterProfile.newlineBeforeKeywords.has(kw)).toBe(
          true,
        );
      }
    });

    it("inherits base formatter newline-before keywords", () => {
      const baseNewline = ["FROM", "WHERE", "HAVING"];
      for (const kw of baseNewline) {
        expect(snowflakeFormatterProfile.newlineBeforeKeywords.has(kw)).toBe(
          true,
        );
      }
    });

    it("includes join modifiers from base", () => {
      const joinMods = ["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL"];
      for (const kw of joinMods) {
        expect(snowflakeFormatterProfile.joinModifiers.has(kw)).toBe(true);
      }
    });

    it("includes logical break keywords from base", () => {
      expect(snowflakeFormatterProfile.logicalBreakKeywords.has("AND")).toBe(
        true,
      );
      expect(snowflakeFormatterProfile.logicalBreakKeywords.has("OR")).toBe(
        true,
      );
    });

    it("includes Snowflake overlay keywords in the keywords set", () => {
      for (const kw of SNOWFLAKE_COMPLETION_KEYWORD_OVERLAYS) {
        expect(snowflakeFormatterProfile.keywords.has(kw)).toBe(true);
      }
    });
  });
});
