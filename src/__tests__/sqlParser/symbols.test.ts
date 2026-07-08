import { describe, expect, it, jest } from "@jest/globals";

jest.unmock("chevrotain");

import {
  collectSqlSymbolUsages,
  resolveSqlRenameSymbol,
} from "../../sqlParser/symbols";

const mergeSql = `MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMDATE S
ON T.ACCOUNTKEY = S.DATEKEY
WHEN MATCHED THEN UPDATE SET T.ACCOUNTNAME = S.CALENDARQUARTER`;

const quotedAliasSql = `SELECT "Sales Alias"."Customer Id"
FROM JUST_DATA..DIMACCOUNT AS "Sales Alias"
WHERE "Sales Alias"."Customer Id" > 0`;

const createdTableSql = `CREATE TEMP TABLE JUST_DATA..WORKING_SET AS
SELECT ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT;

SELECT * FROM JUST_DATA..WORKING_SET;

DROP TABLE JUST_DATA..WORKING_SET;`;

describe("sqlParser/symbols", () => {
  it("collects MERGE target and source alias usages directly from SQL", () => {
    const usages = collectSqlSymbolUsages(mergeSql);
    const targetAlias = usages.find(
      (usage) => usage.kind === "table_alias" && usage.name === "T",
    );
    const sourceAlias = usages.find(
      (usage) => usage.kind === "table_alias" && usage.name === "S",
    );

    expect(
      targetAlias?.occurrences.map((occurrence) => occurrence.role),
    ).toEqual(["definition", "reference", "reference"]);
    expect(
      sourceAlias?.occurrences.map((occurrence) => occurrence.role),
    ).toEqual(["definition", "reference", "reference"]);
  });

  it("resolves MERGE target alias references for rename/navigation", () => {
    const symbol = resolveSqlRenameSymbol(
      mergeSql,
      mergeSql.indexOf("T.ACCOUNTNAME") + 1,
    );

    expect(symbol).toMatchObject({
      kind: "table_alias",
      name: "T",
    });
    expect(symbol?.target.role).toBe("reference");
    expect(symbol?.occurrences).toHaveLength(3);
    expect(symbol?.occurrences.map((occurrence) => occurrence.text)).toEqual([
      "T",
      "T",
      "T",
    ]);
  });

  it("resolves MERGE source alias when the cursor is at the end of the symbol", () => {
    const sourceAliasOffset = mergeSql.indexOf("S.DATEKEY") + 1;
    const symbol = resolveSqlRenameSymbol(mergeSql, sourceAliasOffset);

    expect(symbol).toMatchObject({
      kind: "table_alias",
      name: "S",
    });
    expect(symbol?.occurrences).toHaveLength(3);
  });

  it("collects quoted alias usages in source order and preserves the unquoted display name", () => {
    const usages = collectSqlSymbolUsages(quotedAliasSql);
    const aliasUsage = usages.find(
      (usage) => usage.kind === "table_alias" && usage.name === "Sales Alias",
    );

    expect(
      aliasUsage?.occurrences.map((occurrence) => occurrence.role),
    ).toEqual(["reference", "definition", "reference"]);
    expect(
      aliasUsage?.occurrences.map((occurrence) => occurrence.text),
    ).toEqual(['"Sales Alias"', '"Sales Alias"', '"Sales Alias"']);
  });

  it("resolves quoted alias references for rename/navigation", () => {
    const symbol = resolveSqlRenameSymbol(
      quotedAliasSql,
      quotedAliasSql.indexOf('"Sales Alias"."Customer Id"') + 2,
    );

    expect(symbol).toMatchObject({
      kind: "table_alias",
      name: "Sales Alias",
    });
    expect(symbol?.target.role).toBe("reference");
    expect(symbol?.occurrences).toHaveLength(3);
  });

  it("collects created table usages for Netezza DB..TABLE paths", () => {
    const usages = collectSqlSymbolUsages(createdTableSql);
    const tableUsage = usages.find(
      (usage) => usage.kind === "table" && usage.name === "WORKING_SET",
    );

    expect(
      tableUsage?.occurrences.map((occurrence) => occurrence.role),
    ).toEqual(["definition", "reference", "reference"]);
    expect(
      tableUsage?.occurrences.map((occurrence) => occurrence.text),
    ).toEqual(["WORKING_SET", "WORKING_SET", "WORKING_SET"]);
  });

  it("resolves created table references across Netezza DB..TABLE statements", () => {
    const symbol = resolveSqlRenameSymbol(
      createdTableSql,
      createdTableSql.indexOf("JUST_DATA..WORKING_SET;") +
        "JUST_DATA..".length +
        2,
    );

    expect(symbol).toMatchObject({
      kind: "table",
      name: "WORKING_SET",
    });
    expect(symbol?.target.role).toBe("reference");
    expect(symbol?.occurrences).toHaveLength(3);
  });

  describe("CTE scope isolation", () => {
    const cteLeakSql = `WITH ABC_1 AS (
      SELECT A.ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT A
    ),
    ABC_2 AS (
      SELECT A.DATEKEY FROM JUST_DATA..DIMDATE A
    )
    SELECT * FROM ABC_2 X`;

    it("collects CTE definitions separately from alias definitions", () => {
      const usages = collectSqlSymbolUsages(cteLeakSql);
      const cte1 = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "ABC_1",
      );
      const cte2 = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "ABC_2",
      );

      expect(cte1).toBeDefined();
      expect(cte2).toBeDefined();
      expect(cte1?.occurrences).toHaveLength(1);
      expect(cte2?.occurrences).toHaveLength(2);
    });

    it("collects alias A separately for each CTE scope", () => {
      const usages = collectSqlSymbolUsages(cteLeakSql);
      const aliasUsages = usages.filter(
        (usage) => usage.kind === "table_alias" && usage.name === "A",
      );

      expect(aliasUsages).toHaveLength(2);
      expect(aliasUsages[0].occurrences).toHaveLength(2);
      expect(aliasUsages[1].occurrences).toHaveLength(2);
    });

    it("resolves alias A inside first CTE to its local definition", () => {
      const firstAliasOffset = cteLeakSql.indexOf("A.ACCOUNTKEY") + 1;
      const symbol = resolveSqlRenameSymbol(cteLeakSql, firstAliasOffset);

      expect(symbol).toMatchObject({
        kind: "table_alias",
        name: "A",
      });
      expect(symbol?.occurrences).toHaveLength(2);
    });

    it("resolves alias A inside second CTE to its own local definition", () => {
      const secondAliasOffset = cteLeakSql.indexOf("A.DATEKEY") + 1;
      const symbol = resolveSqlRenameSymbol(cteLeakSql, secondAliasOffset);

      expect(symbol).toMatchObject({
        kind: "table_alias",
        name: "A",
      });
      expect(symbol?.occurrences).toHaveLength(2);
    });
  });

  describe("nested subquery scope", () => {
    const nestedSubquerySql = `SELECT SQ2.ID
    FROM (
      SELECT SQ1.ID
      FROM (
        SELECT D.ID FROM BAZA..DEPT D
      ) SQ1
    ) SQ2`;

    it("collects alias D only within innermost scope", () => {
      const usages = collectSqlSymbolUsages(nestedSubquerySql);
      const aliasD = usages.find(
        (usage) => usage.kind === "table_alias" && usage.name === "D",
      );

      expect(aliasD).toBeDefined();
      expect(aliasD?.occurrences).toHaveLength(2);
    });

    it("collects alias SQ1 only within middle scope", () => {
      const usages = collectSqlSymbolUsages(nestedSubquerySql);
      const aliasSQ1 = usages.find(
        (usage) => usage.kind === "table_alias" && usage.name === "SQ1",
      );

      expect(aliasSQ1).toBeDefined();
      expect(aliasSQ1?.occurrences).toHaveLength(2);
    });

    it("collects alias SQ2 with definition and reference", () => {
      const usages = collectSqlSymbolUsages(nestedSubquerySql);
      const aliasSQ2 = usages.find(
        (usage) => usage.kind === "table_alias" && usage.name === "SQ2",
      );

      expect(aliasSQ2).toBeDefined();
      expect(aliasSQ2?.occurrences).toHaveLength(2);
    });

    it("resolves inner alias D from its own scope", () => {
      const innerAliasOffset = nestedSubquerySql.indexOf("D.ID") + 1;
      const symbol = resolveSqlRenameSymbol(
        nestedSubquerySql,
        innerAliasOffset,
      );

      expect(symbol).toMatchObject({
        kind: "table_alias",
        name: "D",
      });
    });
  });

  describe("CTE reference chain", () => {
    const cteChainSql = `WITH CTE1 AS (
      SELECT D.ID FROM BAZA..DEPT D
    ),
    CTE2 AS (
      SELECT C1.ID FROM CTE1 C1
    )
    SELECT C2.ID FROM CTE2 C2`;

    it("collects CTE definition and reference across scopes", () => {
      const usages = collectSqlSymbolUsages(cteChainSql);
      const cte1 = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "CTE1",
      );
      const cte2 = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "CTE2",
      );

      expect(cte1?.occurrences).toHaveLength(2);
      expect(cte2?.occurrences).toHaveLength(2);

      const cte1Roles = cte1?.occurrences.map((occurrence) => occurrence.role);
      expect(cte1Roles).toEqual(["definition", "reference"]);

      const cte2Roles = cte2?.occurrences.map((occurrence) => occurrence.role);
      expect(cte2Roles).toEqual(["definition", "reference"]);
    });

    it("resolves CTE1 reference in second CTE", () => {
      const cte1ReferenceOffset =
        cteChainSql.indexOf("FROM CTE1 C1") + "FROM ".length + 1;
      const symbol = resolveSqlRenameSymbol(cteChainSql, cte1ReferenceOffset);

      expect(symbol).toMatchObject({
        kind: "cte",
        name: "CTE1",
      });
      expect(symbol?.occurrences).toHaveLength(2);
    });

    it("tracks nested WITH references inside INSERT CTE definitions", () => {
      const sql = `INSERT INTO TARGET_TABLE
WITH ABC AS (
  WITH DEF AS (
    SELECT 1 AS ID
  )
  SELECT ID FROM DEF
)
SELECT * FROM ABC`;
      const usages = collectSqlSymbolUsages(sql);
      const abc = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "ABC",
      );
      const def = usages.find(
        (usage) => usage.kind === "cte" && usage.name === "DEF",
      );

      expect(abc?.occurrences.map((occurrence) => occurrence.role)).toEqual([
        "definition",
        "reference",
      ]);
      expect(def?.occurrences.map((occurrence) => occurrence.role)).toEqual([
        "definition",
        "reference",
      ]);
    });
  });

  describe("UPDATE and DELETE alias scope", () => {
    const updateAliasSql = `UPDATE JUST_DATA.ADMIN.DEPARTMENT C SET C.NAME = 'test' WHERE C.ID > 0`;
    const deleteAliasSql = `DELETE FROM JUST_DATA.ADMIN.DEPARTMENT C WHERE C.ID > 0`;

    it("collects UPDATE alias and its references", () => {
      const usages = collectSqlSymbolUsages(updateAliasSql);
      const aliasC = usages.find(
        (usage) => usage.kind === "table_alias" && usage.name === "C",
      );

      expect(aliasC).toBeDefined();
      expect(aliasC?.occurrences).toHaveLength(3);
      expect(aliasC?.occurrences[0].role).toBe("definition");
    });

    it("collects DELETE alias and its references", () => {
      const usages = collectSqlSymbolUsages(deleteAliasSql);
      const aliasC = usages.find(
        (usage) => usage.kind === "table_alias" && usage.name === "C",
      );

      expect(aliasC).toBeDefined();
      expect(aliasC?.occurrences).toHaveLength(2);
      expect(aliasC?.occurrences[0].role).toBe("definition");
    });

    it("resolves UPDATE alias reference", () => {
      const aliasOffset = updateAliasSql.indexOf("C.NAME") + 1;
      const symbol = resolveSqlRenameSymbol(updateAliasSql, aliasOffset);

      expect(symbol).toMatchObject({
        kind: "table_alias",
        name: "C",
      });
    });
  });
});
