import {
  buildRelatedRowsSql,
  findRelatedRowCandidates,
  type RelatedRowTable,
} from "../results/relatedRows";

describe("related-row navigation", () => {
  it("prefers key-role matches and allows only unique exact name heuristics", () => {
    const source: RelatedRowTable = {
      database: "SALES",
      schema: "PUBLIC",
      table: "ORDERS",
      columns: [],
    };
    const keyTable: RelatedRowTable = {
      database: "SALES",
      schema: "PUBLIC",
      table: "USERS",
      columns: [{ name: "PK_USER_ID", isPk: true }],
    };
    const heuristicTable: RelatedRowTable = {
      database: "SALES",
      schema: "PUBLIC",
      table: "ARCHIVE",
      columns: [{ name: "COL_USER_ID" }],
    };

    expect(findRelatedRowCandidates(
      source,
      { name: "COL_FK_USER_ID" },
      [keyTable, heuristicTable],
    )).toEqual([
      expect.objectContaining({ table: "USERS", direction: "referenced", confidence: "key" }),
    ]);
    expect(findRelatedRowCandidates(
      source,
      { name: "COL_USER_ID" },
      [keyTable],
    )).toEqual([
      expect.objectContaining({ table: "USERS", direction: "matching", confidence: "name" }),
    ]);
  });

  it("quotes values and identifiers and bounds each dialect query", () => {
    const sql = buildRelatedRowsSql({
      database: "SALES",
      schema: "PUBLIC",
      table: "USERS",
      column: "USER_NAME",
      dataType: "VARCHAR",
      value: "O'B; DROP TABLE USERS",
      databaseKind: "postgresql",
    });
    expect(sql).toContain("'O''B; DROP TABLE USERS'");
    expect(sql).toMatch(/LIMIT 100$/);
    expect(sql).toContain(" = 'O''B; DROP TABLE USERS' LIMIT 100");

    expect(buildRelatedRowsSql({
      database: "SALES", schema: "dbo", table: "USERS", column: "ID",
      dataType: "INT", value: "12345678901234567890", databaseKind: "mssql",
    })).toContain("SELECT TOP (100)");
    expect(buildRelatedRowsSql({
      database: "SALES", table: "USERS", column: "ID",
      dataType: "INT", value: 42, databaseKind: "access",
    })).toContain("SELECT TOP 100");
    expect(buildRelatedRowsSql({
      database: "SALES", schema: "PUBLIC", table: "USERS", column: "ID",
      dataType: "INTEGER", value: 3, databaseKind: "oracle",
    })).toContain("FETCH FIRST 100 ROWS ONLY");
  });

  it("rejects unsafe numeric values and invalid query limits", () => {
    expect(() => buildRelatedRowsSql({
      database: "SALES", table: "USERS", column: "ID", dataType: "INTEGER",
      value: "1 OR 1=1", databaseKind: "sqlite",
    })).toThrow(/safely represented/);
    expect(() => buildRelatedRowsSql({
      database: "SALES", table: "USERS", column: "ID", value: 1,
      databaseKind: "sqlite", limit: 1001,
    })).toThrow(/limit/);
  });
});
