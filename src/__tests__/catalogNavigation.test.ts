import {
  buildCatalogDdlQuery,
  buildCatalogDdlUri,
  buildCatalogUsageSearchPatterns,
  findCatalogUsagesInText,
  parseCallArgumentContext,
  parseCatalogDdlUri,
  resolveCatalogObjectAtOffset,
} from "../server/catalogNavigation";

describe("catalogNavigation", () => {
  it("resolves qualified table reference at offset", () => {
    const sql = "SELECT * FROM JUST_DATA.ADMIN.DIM_ACCOUNT;";
    const object = resolveCatalogObjectAtOffset(sql, 25, "netezza", "JUST_DATA");
    expect(object?.name).toBe("DIM_ACCOUNT");
    expect(object?.schema).toBe("ADMIN");
    expect(object?.database).toBe("JUST_DATA");
    expect(object?.kind).toBe("table");
  });

  it("builds and parses catalog DDL uri", () => {
    const uri = buildCatalogDdlUri(
      {
        kind: "table",
        database: "JUST_DATA",
        schema: "ADMIN",
        name: "DIM_ACCOUNT",
        startOffset: 0,
        endOffset: 10,
      },
      "file:///query.sql",
    );
    expect(uri.startsWith("netezza-catalog:/ddl?")).toBe(true);
    const parsed = parseCatalogDdlUri(uri);
    expect(parsed?.kind).toBe("table");
    expect(parsed?.name).toBe("DIM_ACCOUNT");
    expect(parsed?.sourceDocumentUri).toBe("file:///query.sql");
  });

  it("builds catalog DDL query for fully qualified table", () => {
    const query = buildCatalogDdlQuery(
      {
        kind: "table",
        database: "JUST_DATA",
        schema: "ADMIN",
        name: "DIMACCOUNT",
        startOffset: 0,
        endOffset: 10,
      },
      "file:///query.sql",
    );
    const params = new URLSearchParams(query);
    expect(params.get("database")).toBe("JUST_DATA");
    expect(params.get("schema")).toBe("ADMIN");
    expect(params.get("name")).toBe("DIMACCOUNT");
  });

  it("parses legacy /ddl catalog uri paths", () => {
    const parsed = parseCatalogDdlUri(
      "netezza-catalog:/ddl?kind=table&name=DIMACCOUNT&database=JUST_DATA",
    );
    expect(parsed?.name).toBe("DIMACCOUNT");
    expect(parsed?.database).toBe("JUST_DATA");
  });

  it("resolves JUST_DATA..DIMACCOUNT at any offset in the qualified name", () => {
    const sql = "SELECT A.ACCOUNTDESCRIPTION FROM JUST_DATA..DIMACCOUNT A";
    const qualifiedStart = sql.indexOf("JUST_DATA..DIMACCOUNT");
    const offsets = [
      qualifiedStart,
      qualifiedStart + "JUST_DATA..".length,
      qualifiedStart + "JUST_DATA..DIM".length,
    ];

    for (const offset of offsets) {
      const object = resolveCatalogObjectAtOffset(sql, offset, "netezza");
      expect(object?.name).toBe("DIMACCOUNT");
      expect(object?.database).toBe("JUST_DATA");
      expect(object?.schema).toBeUndefined();
      expect(sql.slice(object!.startOffset, object!.endOffset)).toBe(
        "JUST_DATA..DIMACCOUNT",
      );
    }
  });

  it("resolves table name after DB.. prefix without applying default schema", () => {
    const sql = "SELECT A.ACCOUNTDESCRIPTION FROM JUST_DATA..DIMACCOUNT A";
    const object = resolveCatalogObjectAtOffset(
      sql,
      sql.indexOf("DIMACCOUNT"),
      "netezza",
      "OTHER_DB",
      "ADMIN",
    );
    expect(object?.name).toBe("DIMACCOUNT");
    expect(object?.database).toBe("JUST_DATA");
    expect(object?.schema).toBeUndefined();
  });

  it("finds catalog usages in workspace text", () => {
    const patterns = buildCatalogUsageSearchPatterns({
      kind: "table",
      database: "JUST_DATA",
      schema: "ADMIN",
      name: "DIM_ACCOUNT",
      startOffset: 0,
      endOffset: 1,
    });
    const matches = findCatalogUsagesInText(
      "FROM JUST_DATA.ADMIN.DIM_ACCOUNT a JOIN JUST_DATA..DIM_ACCOUNT b",
      patterns,
    );
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves unqualified table name in FROM using effective schema", () => {
    const sql = "SELECT * FROM DIM_ACCOUNT;";
    const object = resolveCatalogObjectAtOffset(
      sql,
      14,
      "netezza",
      "JUST_DATA",
      "ADMIN",
    );
    expect(object?.name).toBe("DIM_ACCOUNT");
    expect(object?.schema).toBe("ADMIN");
    expect(object?.database).toBe("JUST_DATA");
    expect(object?.kind).toBe("table");
  });

  it("parses CALL argument context", () => {
    const prefix = "CALL JUST_DATA.ADMIN.MY_PROC(1, ";
    const context = parseCallArgumentContext(prefix, "netezza");
    expect(context?.procedureName).toBe("MY_PROC");
    expect(context?.argIndex).toBeGreaterThanOrEqual(1);
  });
});
