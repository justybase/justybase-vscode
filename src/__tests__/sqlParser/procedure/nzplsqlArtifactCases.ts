/**
 * NZPLSQL that the product inserts for the user: dialect snippets and the
 * procedure wizard templates, turned into runnable procedures.
 *
 * The same cases drive:
 * - `nzplsqlArtifacts.test.ts` — the parser accepts every artifact and none
 *   uses a construct Netezza rejects.
 * - `nzplsqlArtifacts.live.integration.test.ts` — CREATE + CALL on a live
 *   Netezza (the body is compiled only at CALL).
 *
 * Placeholders, substituted by the callers:
 * - `{{DB}}`, `{{SCHEMA}}`, `{{PROCNAME}}` — procedure identity;
 * - `{{T}}` / `{{T_NAME}}` and `{{CUSTOMERS}}`, `{{INVENTORY}}`, ... —
 *   fixture tables, qualified and bare (see `NZPLSQL_ARTIFACT_FIXTURES`).
 */

import * as fs from "fs";
import * as path from "path";

import { procedureTemplates } from "../../../providers/procedureTemplates";

export interface NzplsqlArtifactCase {
  id: string;
  /** Where the SQL comes from: a snippet name or a wizard template id. */
  source: string;
  sql: string;
  /** CALL argument list, rendered verbatim. */
  callArgs: string;
  /** Argument types for DROP PROCEDURE. */
  dropSignature: string;
  /** Expected CALL outcome; snippets that raise on purpose expect `error`. */
  call: "ok" | "error";
  errorIncludes?: string;
  expectNotices?: string[];
  /** First column of the first row returned by CALL. */
  expectValue?: unknown;
}

/** Fixture tables used by the artifacts: name → column definitions. */
export const NZPLSQL_ARTIFACT_FIXTURES: Readonly<Record<string, string>> = {
  T: "id INT, name VARCHAR(20)",
  CUSTOMERS: "customer_id INT, name VARCHAR(100), hash BIGINT",
  INVENTORY: "product_id INT, qty INT, quantity INT",
  SALES_LOG: "product_id INT, qty INT, ts TIMESTAMP",
  ORDERS: "order_id INT, total_amount NUMERIC(10,2), total_items INT",
  TEMP_CUSTOMERS: "customer_id INT, name VARCHAR(100), hash BIGINT",
  NEW_DATA: "customer_id INT, name VARCHAR(100), hash BIGINT",
};

/** Seed rows, inserted after the fixture tables are created. */
export const NZPLSQL_ARTIFACT_SEED: readonly string[] = [
  "INSERT INTO {{T}} VALUES (1, 'a')",
  "INSERT INTO {{T}} VALUES (2, 'b')",
  "INSERT INTO {{INVENTORY}} VALUES (1, 10, 10)",
  "INSERT INTO {{ORDERS}} VALUES (1, 10, 0)",
  "INSERT INTO {{ORDERS}} VALUES (2, 10, 4)",
  "INSERT INTO {{NEW_DATA}} VALUES (5, 'n', 0)",
];

export interface NzplsqlArtifactNames {
  db: string;
  schema: string;
  procName: string;
  /** Bare fixture table name for each `NZPLSQL_ARTIFACT_FIXTURES` key. */
  tables: Readonly<Record<string, string>>;
}

export function renderNzplsqlArtifactSql(sql: string, names: NzplsqlArtifactNames): string {
  let rendered = sql
    .split("{{DB}}").join(names.db)
    .split("{{SCHEMA}}").join(names.schema)
    .split("{{PROCNAME}}").join(names.procName);
  for (const [key, table] of Object.entries(names.tables)) {
    rendered = rendered
      .split(`{{${key}_NAME}}`).join(table)
      .split(`{{${key}}}`).join(`${names.schema}.${table}`);
  }
  return rendered;
}

interface SnippetDefinition {
  prefix: string | string[];
  body: string | string[];
}

const SNIPPET_FILE = path.resolve(__dirname, "../../../../dialects/netezza/snippets/netezza.code-snippets");

export function loadNetezzaSnippets(): Record<string, SnippetDefinition> {
  return JSON.parse(fs.readFileSync(SNIPPET_FILE, "utf8")) as Record<string, SnippetDefinition>;
}

/** Snippets that insert NZPLSQL; each one needs a case below. */
export function isNzplsqlSnippet(name: string, snippet: SnippetDefinition): boolean {
  const body = Array.isArray(snippet.body) ? snippet.body.join("\n") : snippet.body;
  return name.startsWith("NZPLSQL") || /\bLANGUAGE\s+NZPLSQL\b/i.test(body);
}

/**
 * Expand a snippet body: `${n:default}` and `${n}` take `fills[n]`, else the
 * default of the first `${n:...}`.
 */
export function expandSnippet(body: string | string[], fills: Readonly<Record<number, string>>): string {
  const text = Array.isArray(body) ? body.join("\n") : body;
  const defaults = new Map<number, string>();
  for (const match of text.matchAll(/\$\{(\d+):([^}]*)\}/g)) {
    const index = Number(match[1]);
    if (!defaults.has(index)) {
      defaults.set(index, match[2]);
    }
  }
  return text.replace(/\$\{(\d+)(?::[^}]*)?\}/g, (_whole, digits: string) => {
    const index = Number(digits);
    return fills[index] ?? defaults.get(index) ?? "";
  });
}

const PROC = "{{SCHEMA}}.{{PROCNAME}}";

function procedure(declare: string, body: string, returns = "INT4"): string {
  return `CREATE OR REPLACE PROCEDURE ${PROC}() RETURNS ${returns} LANGUAGE NZPLSQL AS
BEGIN_PROC
${declare ? `DECLARE\n${declare}\n` : ""}BEGIN
${body}
END;
END_PROC;`;
}

interface SnippetCaseSpec {
  fills: Record<number, string>;
  /** Builds the procedure around the expanded snippet. */
  wrap: (snippet: string) => string;
  callArgs?: string;
  dropSignature?: string;
  call?: "ok" | "error";
  errorIncludes?: string;
  expectNotices?: string[];
  expectValue?: unknown;
}

const PROCEDURE_IDENTITY = { 1: "{{DB}}", 2: "{{SCHEMA}}", 3: "{{PROCNAME}}" };

/** One runnable case per NZPLSQL snippet, keyed by snippet name. */
export const NZPLSQL_SNIPPET_CASE_SPECS: Readonly<Record<string, SnippetCaseSpec>> = {
  "NZPLSQL Stored Procedure": {
    fills: { ...PROCEDURE_IDENTITY, 7: "v_result := arg1 + 1;" },
    wrap: (snippet) => snippet,
    callArgs: "1",
    dropSignature: "INT4",
    expectValue: 2,
  },
  "CREATE OR REPLACE PROCEDURE (simple)": {
    fills: { ...PROCEDURE_IDENTITY, 6: "RAISE NOTICE 'simple %', arg1;" },
    wrap: (snippet) => snippet,
    callArgs: "3",
    dropSignature: "INT4",
    expectNotices: ["simple 3"],
  },
  "NZPLSQL IF ELSE": {
    fills: {
      1: "v_i = 1", 2: "RAISE NOTICE 'one';",
      3: "v_i = 2", 4: "RAISE NOTICE 'two';",
      5: "RAISE NOTICE 'other';",
    },
    wrap: (snippet) => procedure("    v_i INT := 2;", snippet),
    expectNotices: ["two"],
  },
  "NZPLSQL FOR loop": {
    fills: { 2: "1", 3: "2", 4: "RAISE NOTICE 'i=%', i;" },
    wrap: (snippet) => procedure("", snippet),
    expectNotices: ["i=1", "i=2"],
  },
  "NZPLSQL FOR REVERSE loop": {
    fills: { 3: "2", 4: "1", 5: "RAISE NOTICE 'i=%', i;" },
    wrap: (snippet) => procedure("", snippet),
    expectNotices: ["i=2", "i=1"],
  },
  "NZPLSQL FOR IN SELECT": {
    fills: { 2: "id, name", 3: "{{SCHEMA}}", 4: "{{T_NAME}}", 5: "id > 0", 6: "RAISE NOTICE 'name=%', rec.name;" },
    wrap: (snippet) => procedure("    rec RECORD;", snippet),
    expectNotices: ["name=a", "name=b"],
  },
  "NZPLSQL REFTABLE procedure": {
    fills: { ...PROCEDURE_IDENTITY, 4: "{{DB}}", 5: "{{SCHEMA}}", 6: "{{T_NAME}}", 8: "{{T}}" },
    wrap: (snippet) => snippet,
  },
  "NZPLSQL WHILE loop": {
    fills: { 1: "v_c < 2", 2: "v_c := v_c + 1;" },
    wrap: (snippet) => procedure("    v_c INT := 0;", `${snippet}\nRAISE NOTICE 'c=%', v_c;`),
    expectNotices: ["c=2"],
  },
  "NZPLSQL EXIT label": {
    fills: { 1: "outer", 2: "v_c >= 3" },
    wrap: (snippet) => procedure(
      "    v_c INT := 0;",
      `<<outer>> LOOP\n    v_c := v_c + 1;\n    ${snippet}\nEND LOOP;\nRAISE NOTICE 'c=%', v_c;`,
    ),
    expectNotices: ["c=3"],
  },
  "NZPLSQL Cursor": {
    fills: { 2: "id", 3: "name", 4: "{{SCHEMA}}", 5: "{{T_NAME}}", 6: "id > 0", 7: "RAISE NOTICE 'row=%', rec.name;" },
    wrap: (snippet) => `CREATE OR REPLACE PROCEDURE ${PROC}() RETURNS INT4 LANGUAGE NZPLSQL AS\nBEGIN_PROC\n${snippet}\nEND_PROC;`,
    expectNotices: ["row=a", "row=b"],
  },
  "NZPLSQL Exception handling": {
    fills: {},
    wrap: (snippet) => procedure("", `RAISE EXCEPTION 'boom';\n${snippet}`),
    call: "error",
    errorIncludes: "Error: boom",
  },
  "NZPLSQL RAISE NOTICE": {
    fills: { 2: "v" },
    wrap: (snippet) => procedure("    v INT := 1;", snippet),
    expectNotices: ["Message: 1"],
  },
  "NZPLSQL RAISE EXCEPTION": {
    fills: { 2: "v" },
    wrap: (snippet) => procedure("    v INT := 1;", snippet),
    call: "error",
    errorIncludes: "Error message: 1",
  },
  "NZPLSQL Variable declaration": {
    fills: {},
    wrap: (snippet) => procedure(`    ${snippet}`, "RAISE NOTICE 'v=%', v_name;"),
    expectNotices: ["v=0"],
  },
  "NZPLSQL Execute immediate": {
    fills: { 1: "UPDATE {{T}} SET name = name WHERE id = 1" },
    wrap: (snippet) => procedure("", `${snippet}\nRAISE NOTICE 'rows=%', ROW_COUNT;`),
    expectNotices: ["rows=1"],
  },
};

const TEMPLATE_TABLES: ReadonlyArray<[RegExp, string]> = [
  [/\btemp_customers\b/g, "{{TEMP_CUSTOMERS}}"],
  [/\bcustomers\b/g, "{{CUSTOMERS}}"],
  [/\binventory\b/g, "{{INVENTORY}}"],
  [/\bsales_log\b/g, "{{SALES_LOG}}"],
  [/\borders\b/g, "{{ORDERS}}"],
  [/\bnew_data\b/g, "{{NEW_DATA}}"],
];

/** CALL arguments per wizard template signature. */
const TEMPLATE_CALLS: ReadonlyArray<{ signature: string; callArgs: string }> = [
  { signature: "(INTEGER, VARCHAR(100))", callArgs: "7, 'x'" },
  { signature: "(INTEGER, INTEGER)", callArgs: "1, 1" },
  { signature: "(INTEGER)", callArgs: "1" },
  { signature: "()", callArgs: "" },
];

/** Expected first value per template id, with the seed above (none of them raise). */
const TEMPLATE_VALUES: Readonly<Record<string, unknown>> = {
  "basic-simple": 1,
  "basic-select-into": "NOT FOUND",
  "advanced-retry": "Success",
  "advanced-division": "0.00",
  "advanced-transaction": "SUCCESS",
  "advanced-temp-table": "Data inserted successfully",
};

export function buildNzplsqlArtifactCases(): NzplsqlArtifactCase[] {
  const cases: NzplsqlArtifactCase[] = [];
  const snippets = loadNetezzaSnippets();
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!isNzplsqlSnippet(name, snippet)) {
      continue;
    }
    const spec = NZPLSQL_SNIPPET_CASE_SPECS[name];
    if (!spec) {
      throw new Error(`NZPLSQL snippet "${name}" has no case in nzplsqlArtifactCases.ts`);
    }
    cases.push({
      id: `snippet_${name.replace(/\W+/g, "_").toLowerCase()}`,
      source: `snippet "${name}"`,
      sql: spec.wrap(expandSnippet(snippet.body, spec.fills)),
      callArgs: spec.callArgs ?? "",
      dropSignature: spec.dropSignature ?? "",
      call: spec.call ?? "ok",
      errorIncludes: spec.errorIncludes,
      expectNotices: spec.expectNotices,
      expectValue: spec.expectValue,
    });
  }
  for (const template of procedureTemplates) {
    let sql = template.template("{{PROCNAME}}", "{{DB}}", "{{SCHEMA}}");
    for (const [pattern, placeholder] of TEMPLATE_TABLES) {
      sql = sql.replace(pattern, placeholder);
    }
    sql = sql.replace("{{DB}}.{{SCHEMA}}.{{PROCNAME}}", PROC);
    const call = TEMPLATE_CALLS.find((entry) => sql.includes(`${PROC}${entry.signature}`));
    if (!call) {
      throw new Error(`Template "${template.id}" has an unknown signature`);
    }
    cases.push({
      id: `template_${template.id.replace(/\W+/g, "_")}`,
      source: `template "${template.id}"`,
      sql,
      callArgs: call.callArgs,
      dropSignature: call.signature.slice(1, -1),
      call: "ok",
      expectValue: TEMPLATE_VALUES[template.id],
    });
  }
  return cases;
}

/**
 * Constructs Netezza rejects (verified live, see `procedureMatrixCases.ts`)
 * or that do not exist on a standard install. No artifact may contain them.
 */
export const NZPLSQL_FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bCURSOR\s+FOR\b|\bOPEN\s+\w+\s*;|\bFETCH\s+\w+\s+INTO\b/i, reason: "explicit cursors are rejected" },
  { pattern: /\bWHEN\s+SQLSTATE\b/i, reason: "WHEN SQLSTATE handlers are rejected" },
  { pattern: /\bWHEN\s+(?!OTHERS\b|TRANSACTION_ABORTED\b)[A-Z_]+_[A-Z_]+\s+THEN\b/i, reason: "only OTHERS and TRANSACTION_ABORTED handlers exist" },
  { pattern: /\bRAISE\s+(ERROR|WARNING|INFO|LOG)\b/i, reason: "RAISE accepts DEBUG, NOTICE, EXCEPTION only" },
  { pattern: /,\s*SQLSTATE\b/i, reason: "SQLSTATE is not available in handlers" },
  { pattern: /\bGET\s+DIAGNOSTICS\b/i, reason: "GET DIAGNOSTICS is rejected; use ROW_COUNT" },
  { pattern: /\bEND\s+CASE\b/i, reason: "the CASE statement is rejected; use IF or a CASE expression" },
  { pattern: /\bhash[48]?\s*\(/i, reason: "hash functions need the SQL Extensions Toolkit" },
  { pattern: /\bRETURN\s+SELECT\b/i, reason: "REFTABLE procedures fill REFTABLENAME, then RETURN REFTABLE" },
];
