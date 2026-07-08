jest.unmock("chevrotain");

import * as parsingRuntime from "../../sqlParser/parsingRuntime";
import {
  DocumentParseSession,
  resolveSqlRenameSymbolWithSession,
} from "../../sqlParser/documentParseSession";
import {
  buildSemanticScopeFromParseResult,
  parseSemanticScopeWithParser,
} from "../../providers/parsers/parserSqlContext";

const DOC_URI = "file:///session-test.sql";

function createRequest(
  sql: string,
  overrides: Partial<{
    documentVersion: number;
    cursorOffset: number;
    databaseKind: "netezza" | "postgresql";
  }> = {},
) {
  return {
    documentUri: DOC_URI,
    documentVersion: overrides.documentVersion ?? 1,
    sql,
    databaseKind: overrides.databaseKind,
    cursorOffset: overrides.cursorOffset,
  };
}

describe("DocumentParseSession", () => {
  let session: DocumentParseSession;
  let parseSpy: jest.SpyInstance;

  beforeEach(() => {
    session = new DocumentParseSession();
    parseSpy = jest.spyOn(parsingRuntime, "parseSqlStatements");
  });

  afterEach(() => {
    parseSpy.mockRestore();
    session.clear();
  });

  it("returns cached parse result for identical sql", () => {
    const sql = "SELECT a.__JB_COMPLETION__ FROM t1 a JOIN t2 b ON a.id = b.id";
    const request = createRequest(sql);

    session.getParseResult(request);
    session.getParseResult(request);

    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses parse cache when document version changes but sql is unchanged", () => {
    const sql = "SELECT 1;";
    session.getParseResult(createRequest(sql, { documentVersion: 1 }));
    session.getParseResult(createRequest(sql, { documentVersion: 2 }));

    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("parses again when sql content changes", () => {
    session.getParseResult(createRequest("SELECT 1;"));
    session.getParseResult(createRequest("SELECT 2;"));

    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it("parses once for multiple semantic scope offsets", () => {
    const sql = `SELECT D.__JB_COMPLETION__
FROM (
    SELECT X.ACCOUNTKEY
    FROM JUST_DATA..DIMACCOUNT X
) O
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = O.ACCOUNTKEY`;
    const offset = sql.indexOf("__JB_COMPLETION__");

    session.getSemanticScope(createRequest(sql, { cursorOffset: offset }));
    session.getSemanticScope(createRequest(sql, { cursorOffset: offset + 1 }));

    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("matches legacy parseSemanticScopeWithParser scope for Netezza alias binding", () => {
    const sql = "SELECT a.__JB_COMPLETION__ FROM JUST_DATA..DIMACCOUNT a";
    const offset = sql.indexOf("__JB_COMPLETION__");
    const request = createRequest(sql, { cursorOffset: offset });

    const legacy = parseSemanticScopeWithParser(sql, offset);
    const cached = session.getSemanticScope(request);

    expect(cached.preferredAliasBindings.get("A")).toEqual(
      legacy.preferredAliasBindings.get("A"),
    );
    expect(cached.source).toBe(legacy.source);
  });

  it("matches legacy scope for nested subquery alias isolation", () => {
    const sql = `SELECT D.__JB_COMPLETION__
FROM (
    SELECT X.ACCOUNTKEY
    FROM JUST_DATA..DIMACCOUNT X
) O
JOIN JUST_DATA..DIMDATE D ON D.DATEKEY = O.ACCOUNTKEY`;
    const offset = sql.indexOf("__JB_COMPLETION__");
    const request = createRequest(sql, { cursorOffset: offset });

    const legacy = parseSemanticScopeWithParser(sql, offset);
    const cached = session.getSemanticScope(request);

    expect(cached.preferredAliasBindings.has("X")).toBe(false);
    expect(cached.preferredAliasBindings.get("D")).toEqual(
      legacy.preferredAliasBindings.get("D"),
    );
  });

  it("buildSemanticScopeFromParseResult matches session output", () => {
    const sql = "SELECT * FROM TABLE WITH FINAL (DB1.SCH1.FLUID_FN()) F;";
    const parseResult = parsingRuntime.parseSqlStatements({ sql });
    const fromHelper = buildSemanticScopeFromParseResult(parseResult, sql);
    const fromSession = session.getSemanticScope(createRequest(sql));

    expect(fromSession.preferredAliasBindings.get("F")).toEqual(
      fromHelper.preferredAliasBindings.get("F"),
    );
  });

  it("deduplicates concurrent async parse requests", async () => {
    const sql = "SELECT 1;";
    const request = createRequest(sql);

    const [first, second] = await Promise.all([
      session.getParseResultAsync(request),
      session.getParseResultAsync(request),
    ]);

    expect(first).toBe(second);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("returns statement CST nodes from the cached full-document parse", () => {
    const sql = "SELECT 1; SELECT 2;";
    const request = createRequest(sql);

    const firstStatement = session.getStatementCst(request, 0);
    const secondStatement = session.getStatementCst(request, 1);

    expect(firstStatement?.name).toBe("statement");
    expect(secondStatement?.name).toBe("statement");
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("resolveSqlRenameSymbolWithSession reuses cached parse", () => {
    const sql = "SELECT a.__JB__ FROM JUST_DATA..DIMACCOUNT a";
    const offset = sql.indexOf("__JB__");
    const request = createRequest(sql, { cursorOffset: offset });

    resolveSqlRenameSymbolWithSession(session, request, offset);
    resolveSqlRenameSymbolWithSession(session, request, offset + 1);

    expect(parseSpy).toHaveBeenCalledTimes(1);
  });
});
