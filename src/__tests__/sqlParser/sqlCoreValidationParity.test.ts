jest.unmock("chevrotain");

import {
  createMockSchemaProvider,
  type SchemaProvider,
} from "../../sqlParser/schemaProvider";
import { DocumentParseSession } from "../../sqlParser/documentParseSession";
import { SqlCoreBackedValidator } from "../../sqlParser/sqlCoreBackedValidator";
import {
  parseNetezzaSqlStatements,
  type NetezzaSqlParseResult,
} from "@justybase/sql-core/validation";
import { SqlValidator } from "../../sqlParser/validator";
import {
  NETEZZA_SQL_PARSING_RUNTIME,
  parseSqlStatements,
} from "../../sqlParser";
import type { Scope, TableInfo, ValidationError, ValidationResult } from "../../sqlParser/types";

interface ParityCase {
  id: string;
  sql: string;
  schema?: SchemaProvider;
}

interface NormalizedIssue {
  code: string;
  message: string;
  severity: ValidationError["severity"];
  suggestedFix?: string;
  position: ValidationError["position"];
}

const typedSchema = createMockSchemaProvider([
  {
    database: "DB",
    schema: "PUBLIC",
    name: "ORDERS",
    columns: [
      { name: "ORDER_ID", dataType: "INTEGER" },
      { name: "DESCRIPTION", dataType: "VARCHAR(80)" },
      { name: "CREATED_AT", dataType: "DATE" },
    ],
  },
]);

const parityCases: ParityCase[] = [
  { id: "select-literal", sql: "SELECT 1;" },
  { id: "double-dot-table", sql: "SELECT ORDER_ID FROM DB..ORDERS", schema: typedSchema },
  { id: "qualified-column", sql: "SELECT O.ORDER_ID FROM DB.PUBLIC.ORDERS O", schema: typedSchema },
  { id: "numeric-string-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1'", schema: typedSchema },
  { id: "text-ordered-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE DESCRIPTION > 10", schema: typedSchema },
  { id: "date-comparison", sql: "SELECT * FROM DB.PUBLIC.ORDERS WHERE CREATED_AT = DATE '2024-01-01'", schema: typedSchema },
  { id: "malformed-expression", sql: "SELECT FROM DB.PUBLIC.ORDERS", schema: typedSchema },
  { id: "semicolon-only", sql: " ;;; " },
  { id: "multiline-offsets", sql: "SELECT\n  ORDER_ID\nFROM DB.PUBLIC.ORDERS", schema: typedSchema },
  { id: "procedure-body", sql: "CREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;" },
];

describe("sql-core validation compatibility boundary", () => {
  it.each(parityCases)("preserves legacy result for $id", ({ sql, schema }) => {
    const legacy = new SqlValidator(schema);
    const coreBacked = new SqlCoreBackedValidator(schema);

    expect(normalizeResult(coreBacked.validate(sql))).toEqual(
      normalizeResult(legacy.validate(sql)),
    );
  });

  it("preserves typed SQL025/SQL026 diagnostics exactly", () => {
    const legacy = new SqlValidator(typedSchema);
    const coreBacked = new SqlCoreBackedValidator(typedSchema);
    const sql =
      "SELECT * FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1' AND DESCRIPTION > 10";

    const legacyDiagnostics = normalizeDiagnostics(legacy.validate(sql));
    const coreDiagnostics = normalizeDiagnostics(coreBacked.validate(sql));

    expect(coreDiagnostics).toEqual(legacyDiagnostics);
    expect(coreDiagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["SQL025", "SQL026"]),
    );
  });

  it("preserves the shared parse-session validation path", () => {
    const sql = "SELECT ORDER_ID FROM DB.PUBLIC.ORDERS WHERE ORDER_ID = '1'";
    const parseSession = new DocumentParseSession();
    const parseRequest = {
      documentUri: "file:///parity.sql",
      documentVersion: 1,
      sql,
      databaseKind: "netezza" as const,
    };
    const parseResult = parseSession.getParseResult(parseRequest);
    const legacy = new SqlValidator(typedSchema);
    const coreBacked = new SqlCoreBackedValidator(typedSchema);

    expect(normalizeResult(coreBacked.validateFromParseResult(sql, parseResult))).toEqual(
      normalizeResult(legacy.validateFromParseResult(sql, parseResult)),
    );
  });

  it.each([
    "%let x=5;\n%put Value is &x;\nSELECT &x, ${ x }, $x;",
    "SELECT * FROM &table_name;\nSELECT * FROM $table_name;\nSELECT * FROM ${ table_name };",
    "%python script.py --value 1;\n%do;\nSELECT 1;\n%end;",
    "SELECT %sql(SELECT MAX(DATEKEY) FROM DB.PUBLIC.DIMDATE) AS max_key FROM DB.PUBLIC.DIMDATE WHERE REGION IN (%sqllist(SELECT REGION FROM DB.PUBLIC.REGIONS));",
    "SELECT * FROM DB.PUBLIC.DIMDATE WHERE DATEKEY >= %eval(20240731 - 30);",
    `%LET run_bad_sql = 0;
%IF &run_bad_sql = 1 %THEN %DO;
  THIS IS NOT VALID SQL FROM A SKIPPED BRANCH
%ELSE %DO;
  %PUT skipped invalid branch;
%END;
SELECT 1;`,
  ])("preserves lexer and parser output for macro authoring input", (sql) => {
    const legacy = parseSqlStatements({
      sql,
      runtime: NETEZZA_SQL_PARSING_RUNTIME,
    });
    const core = parseNetezzaSqlStatements({ sql });

    expect(normalizeParseResult(core)).toEqual(normalizeParseResult(legacy));
  });
});

function normalizeResult(result: ValidationResult): unknown {
  return {
    valid: result.valid,
    errors: normalizeIssues(result.errors),
    warnings: normalizeIssues(result.warnings),
    scope: normalizeScope(result.scope),
  };
}

function normalizeParseResult(result: NetezzaSqlParseResult | {
  lexResult: {
    errors: Array<{ message: string; offset?: number; line?: number; column?: number }>;
    tokens: Array<{ image: string; startOffset?: number; endOffset?: number; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }>;
  };
  parserErrors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>;
  actionableParserErrors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>;
  cst?: { name?: string; children?: Record<string, unknown> };
}): unknown {
  return {
    lexErrors: result.lexResult.errors.map((error) => ({
      message: error.message,
      offset: error.offset,
      line: error.line,
      column: error.column,
    })),
    tokens: result.lexResult.tokens.map((token) => ({
      image: token.image,
      startOffset: token.startOffset,
      endOffset: token.endOffset,
      startLine: token.startLine,
      startColumn: token.startColumn,
      endLine: token.endLine,
      endColumn: token.endColumn,
    })),
    parserErrors: normalizeParserErrors(result.parserErrors),
    actionableParserErrors: normalizeParserErrors(result.actionableParserErrors),
    cstName: result.cst?.name,
    statementCount: result.cst?.children?.statement
      ? (result.cst.children.statement as unknown[]).length
      : 0,
  };
}

function normalizeParserErrors(
  errors: Array<{ message: string; token?: { image?: string; startOffset?: number; startLine?: number; startColumn?: number } }>,
): unknown[] {
  return errors.map((error) => ({
    message: error.message,
    token: error.token
      ? {
        image: error.token.image,
        startOffset: error.token.startOffset,
        startLine: error.token.startLine,
        startColumn: error.token.startColumn,
      }
      : undefined,
  }));
}

function normalizeDiagnostics(result: ValidationResult): NormalizedIssue[] {
  return normalizeIssues([...result.errors, ...result.warnings]);
}

function normalizeIssues(issues: ValidationError[]): NormalizedIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    suggestedFix: issue.suggestedFix,
    position: { ...issue.position },
  }));
}

function normalizeScope(scope: Scope): unknown {
  return normalizeScopeNode(scope);
}

function normalizeScopeNode(scope: Scope | undefined): unknown {
  if (!scope) return undefined;
  return {
    level: scope.level,
    tables: [...scope.tables.entries()].map(([key, table]) => [
      key,
      normalizeTable(table),
    ]),
    ctes: [...scope.ctes.entries()].map(([key, table]) => [
      key,
      normalizeTable(table),
    ]),
    parent: normalizeScopeNode(scope.parent),
    position: scope.position ? { ...scope.position } : undefined,
  };
}

function normalizeTable(table: TableInfo): unknown {
  return {
    name: table.name,
    alias: table.alias,
    schema: table.schema,
    database: table.database,
    isCte: table.isCte,
    isTempTable: table.isTempTable,
    columns: table.columns.map((column) => ({ ...column })),
    position: table.position ? { ...table.position } : undefined,
  };
}
