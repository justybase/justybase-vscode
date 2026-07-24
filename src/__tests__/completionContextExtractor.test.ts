jest.unmock("chevrotain");

import { TextDocument } from "vscode-languageserver-textdocument";
import { CompletionContextExtractor } from "../server/completionContextExtractor";
import { parseAlterTableContext } from "../server/completionAlterTableContext";

describe("CompletionContextExtractor", () => {
  let extractor: CompletionContextExtractor;

  beforeEach(() => {
    extractor = new CompletionContextExtractor();
  });

  it("keys statement boundaries by document uri and version", () => {
    const sqlV1 = "SELECT 1; SELECT 2;";
    const sqlV2 = "SELECT 1; SELECT 3;";
    const uri = "file:///stmt-version.sql";

    const first = extractor.getStatementAtPosition(
      sqlV1,
      sqlV1.indexOf("2"),
      uri,
      1,
    );
    const second = extractor.getStatementAtPosition(
      sqlV2,
      sqlV2.indexOf("3"),
      uri,
      2,
    );

    expect(first?.sql.trim()).toBe("SELECT 2");
    expect(second?.sql.trim()).toBe("SELECT 3");
  });

  it("parses quoted DB..TABLE fragments from multiline CTE FROM clauses", () => {
    const context = extractor.parseFromJoinContext(
      `WITH CTE1 AS (
    SELECT * FROM
        "JUST_DATA"..D`,
      '        "JUST_DATA"..D',
      "    SELECT * FROM",
      "netezza",
    );

    expect(context).toEqual({
      kind: "db_double_dot",
      dbName: "JUST_DATA",
      partial: "D",
    });
  });

  it.each(["CALL", "EXECUTE", "EXEC"])(
    "parses %s procedure targets with quoted db.schema qualification",
    (keyword) => {
      const context = extractor.parseUpdateDropTruncateContext(
        `${keyword} "JUST_DATA"."ADMIN".`,
        "netezza",
      );

      expect(context).toEqual({
        path: {
          kind: "db_schema_dot",
          dbName: "JUST_DATA",
          schemaName: "ADMIN",
          partial: "",
        },
        targetType: "procedure",
      });
    },
  );

  it("parses EXEC procedure targets with database-only qualification", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "EXEC JUST_DATA.",
      "netezza",
    );

    expect(context).toEqual({
      path: {
        kind: "db_dot",
        dbName: "JUST_DATA",
        partial: "",
      },
      targetType: "procedure",
    });
  });

  it("parses CREATE SYNONYM FOR targets with bracket-prefixed database qualification", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "CREATE SYNONYM DIMACCOUNT_XYZ2 FOR JUST_DATA.[DIM",
      "netezza",
    );

    expect(context).toEqual({
      path: {
        kind: "db_double_dot",
        dbName: "JUST_DATA",
        partial: "DIM",
      },
      targetType: "table",
    });
  });

  it("converts db_dot to db_double_dot for Netezza CREATE SYNONYM FOR target", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "CREATE SYNONYM MySyn FOR JUST_DATA.",
      "netezza",
    );

    expect(context).toEqual({
      path: {
        kind: "db_double_dot",
        dbName: "JUST_DATA",
        partial: "",
      },
      targetType: "table",
    });
  });

  it("keeps db_dot for MSSQL CREATE SYNONYM FOR database qualification", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "CREATE SYNONYM MySyn FOR TESTDB.",
      "mssql",
    );

    expect(context).toEqual({
      path: {
        kind: "db_dot",
        dbName: "TESTDB",
        partial: "",
      },
      targetType: "table",
    });
  });

  it("parses INSERT column list context with nested parentheses in expressions", () => {
    const context = extractor.parseInsertColumnListContext(
      "INSERT INTO JUST_DATA..FILMS (CODE, (SELECT MAX(ID) FROM SRC), ",
      "netezza",
    );

    expect(context).toEqual({
      tablePath: "JUST_DATA..FILMS",
      database: "JUST_DATA",
      table: "FILMS",
    });
  });

  it("does not treat closed INSERT column list as active context", () => {
    const context = extractor.parseInsertColumnListContext(
      "INSERT INTO JUST_DATA..FILMS (CODE, TITLE) VALUES (1, 2)",
      "netezza",
    );

    expect(context).toBeUndefined();
  });

  it("stops treating UPDATE targets as object paths after SET is present", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "UPDATE JUST_DATA..DIMACCOUNT SET ACCOUNTKEY = 1",
      "netezza",
    );

    expect(context).toBeUndefined();
  });

  it("does not treat ALTER TABLE after table name as object path", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "ALTER TABLE USERS ",
      "netezza",
    );

    expect(context).toBeUndefined();
  });

  it("returns ALTER TABLE action context after table name", () => {
    const context = parseAlterTableContext(
      "ALTER TABLE USERS ",
      "ALTER TABLE USERS ".length,
      "netezza",
    );

    expect(context).toEqual({
      kind: "action",
      table: { table: "USERS" },
      phase: "top_level",
      typedPrefix: "",
    });
  });

  it("returns DROP COLUMN phase for ALTER TABLE", () => {
    const sql = "ALTER TABLE USERS DROP COLUMN ";
    const context = parseAlterTableContext(sql, sql.length, "netezza");

    expect(context).toMatchObject({
      kind: "action",
      phase: "drop_column",
      table: { table: "USERS" },
    });
  });

  it("returns DROP COLUMN phase for DROP without COLUMN keyword", () => {
    const sql = "ALTER TABLE USERS DROP MIDDLE_NAME ";
    const context = parseAlterTableContext(sql, sql.length, "netezza");

    expect(context).toMatchObject({
      kind: "action",
      phase: "drop_column",
      table: { table: "USERS" },
    });
  });

  it("keeps ALTER TABLE qualification paths active for trailing dot", () => {
    const context = extractor.parseUpdateDropTruncateContext(
      "ALTER TABLE JUST_DATA.",
      "netezza",
    );

    expect(context).toEqual({
      path: {
        kind: "db_dot",
        dbName: "JUST_DATA",
        partial: "",
      },
      targetType: "table",
    });
  });

  it("keeps later sibling CTEs hidden in FROM/JOIN visible definitions", () => {
    const localDefs = [
      { name: "TEMP_STAGE", type: "TEMP TABLE", columns: ["ID"] },
    ];
    const statementSql = `WITH CTE1 AS (
  SELECT ID FROM USERS
),
CTE2 AS (
  SELECT ID FROM CTE1
)
SELECT * FROM `;
    const statementOffset = statementSql.length;

    const visible = extractor.getVisibleLocalDefinitionsForFromJoin(
      localDefs,
      statementSql,
      statementOffset,
      "netezza",
    );

    expect(visible.map((definition) => definition.name)).toEqual(["TEMP_STAGE", "CTE1", "CTE2"]);

    const earlierOffset = statementSql.indexOf('ID FROM USERS');
    const earlierVisible = extractor.getVisibleLocalDefinitionsForFromJoin(
      localDefs,
      statementSql,
      earlierOffset,
      "netezza",
    );

    expect(earlierVisible.map((definition) => definition.name)).toEqual(["TEMP_STAGE", "CTE1"]);
  });

  it("refreshes variables on parsed-context cache hit within the same statement", () => {
    const prefix = "@SET VAR1 = 1;\nSELECT ";
    const docV1 = TextDocument.create(
      "file:///parsed-context-vars.sql",
      "sql",
      1,
      prefix,
    );
    const docV2 = TextDocument.create(
      "file:///parsed-context-vars.sql",
      "sql",
      2,
      `${prefix}@SET VAR2 = 2 `,
    );
    const cursorOffset = docV2.getText().length - 1;

    const first = extractor.getParsedContext(
      docV1,
      "netezza",
      docV1.getText().length - 1,
    );
    const second = extractor.getParsedContext(
      docV2,
      "netezza",
      cursorOffset,
    );

    expect(first.variables).toEqual(["VAR1"]);
    expect(second.variables).toEqual(["VAR1", "VAR2"]);
  });

  it("keys Oracle PL/SQL local definitions by cursor position", () => {
    const sql = `DECLARE
  v_before NUMBER;
  v_after NUMBER;
BEGIN
  NULL;
END;`;
    const document = TextDocument.create("file:///oracle-scope.sql", "sql", 1, sql);
    const beforeDeclaration = sql.indexOf("v_after");
    const afterDeclaration = sql.indexOf("BEGIN");

    const before = extractor.getParsedContext(document, "oracle", beforeDeclaration);
    const after = extractor.getParsedContext(document, "oracle", afterDeclaration);

    expect(before.contentHash).not.toBe(after.contentHash);
  });
});
