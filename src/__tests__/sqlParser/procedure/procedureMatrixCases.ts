/**
 * Live-verified NZPLSQL procedure matrix.
 *
 * Every case in this file was executed against a development Netezza
 * (Release 11.2.2.1) with `CREATE PROCEDURE` followed by `CALL` and, when
 * present, `RAISE NOTICE 'STEP_xx ...'` traces to identify the failing stage.
 *
 * The same case definitions drive:
 * - `procedureMatrix.test.ts` — parser/validator verdicts (deterministic).
 * - `nzplsqlProcedureMatrix.live.integration.test.ts` — real CREATE/CALL/DROP
 *   with server notices (best effort, opt-in via NZ_DEV_* + fixture DDL).
 *
 * Important Netezza behavior captured here:
 * - The NZPLSQL body is compiled lazily at first CALL, not at CREATE. A body
 *   syntax error therefore surfaces as a `plpgsql: ERROR during compile`
 *   notice during CALL (`callPhase: 'body-compile'`).
 * - `RAISE NOTICE` with a variable argument is the supported way to trace the
 *   stage a procedure reached before failing.
 *
 * Placeholders `{{proc}}` and `{{table}}` are substituted by the callers.
 */

export type ProcedureMatrixParse = "accept" | "reject";
export type ProcedureMatrixOutcome = "ok" | "error" | "skip";
export type ProcedureMatrixPhase = "body-compile" | "runtime";

export interface ProcedureMatrixCase {
  id: string;
  group: string;
  /** Procedure SQL. May contain `{{proc}}` and `{{table}}`. */
  sql: string;
  /** Expected parser/validator verdict. */
  parse: ProcedureMatrixParse;
  /** Expected live `CREATE PROCEDURE` outcome. */
  create: ProcedureMatrixOutcome;
  /** Expected live `CALL` outcome (when `create` succeeds). */
  call: ProcedureMatrixOutcome;
  /** When `call: 'error'`, which phase fails. */
  callPhase?: ProcedureMatrixPhase;
  /** CALL argument list (rendered verbatim). */
  callArgs?: string;
  /** Full CALL/SELECT statement override. May contain `{{proc}}` / `{{table}}`. */
  callSql?: string;
  /** Substring expected in a failure message. */
  errorIncludes?: string;
  /** NOTICE text fragments expected after a successful CALL (trace markers). */
  expectNotices?: string[];
  /** Rows expected from a successful CALL (result-set procedures). */
  expectRows?: unknown[][];
  notes?: string;
}

export function renderProcedureMatrixSql(
  template: string,
  procName: string,
  tableName: string,
): string {
  return template.split("{{proc}}").join(procName).split("{{table}}").join(tableName);
}

const P = "{{proc}}";
const T = "{{table}}";

export const PROCEDURE_MATRIX_CASES: ProcedureMatrixCase[] = [
  // ==========================================================================
  // Header / signature
  // ==========================================================================
  {
    id: "hdr_minimal_int4",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE 'STEP_01 minimal';
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 minimal"],
  },
  {
    id: "hdr_int8",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT8 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_varchar_any",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS VARCHAR(ANY) LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 'ok';
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_character_varying",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS CHARACTER VARYING(8) LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 'ok';
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_no_or_replace",
    group: "header",
    sql: `CREATE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "CREATE PROCEDURE without OR REPLACE is accepted.",
  },
  {
    id: "hdr_returns_numeric_ps",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS NUMERIC(10,2) LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1.5;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_returns_numeric_plain",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS NUMERIC LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_returns_boolean",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS BOOLEAN LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN TRUE;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_returns_timestamp",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS TIMESTAMP LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN CURRENT_TIMESTAMP;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_returns_bigint",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS BIGINT LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_reftable",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS REFTABLE(${T}) LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN REFTABLE;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "REFTABLE procedures are invoked with CALL and return a result set.",
  },
  {
    id: "hdr_execute_as_caller",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 EXECUTE AS CALLER LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_execute_as_owner_after_language",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL EXECUTE AS OWNER AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_language_before_returns",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() LANGUAGE NZPLSQL RETURNS INT4 AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "hdr_string_body",
    group: "header",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
'BEGIN
  RAISE NOTICE ''STEP_01 string body'';
  RETURN 1;
END;'`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 string body"],
  },
  {
    id: "hdr_is_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL IS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    errorIncludes: "AS",
    notes: "Netezza requires AS; IS is rejected.",
  },
  {
    id: "hdr_no_returns_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    errorIncludes: "RETURNS",
    notes: "RETURNS is required; both parser and backend reject its absence.",
  },
  {
    id: "hdr_no_language_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    errorIncludes: "LANGUAGE",
    notes: "LANGUAGE is required; both parser and backend reject its absence.",
  },
  {
    id: "hdr_missing_end_proc_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;`,
    parse: "reject",
    create: "error",
    call: "skip",
    errorIncludes: "unterminated BEGIN_PROC",
    notes: "The body must be closed with END_PROC.",
  },
  {
    id: "hdr_bad_language_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE PLPGSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    errorIncludes: "NZPLSQL",
    notes: "Only LANGUAGE NZPLSQL is accepted.",
  },
  {
    id: "hdr_bare_begin_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN
  RETURN 1;
END;`,
    parse: "reject",
    create: "error",
    call: "skip",
    notes: "The body must be bracketed with BEGIN_PROC/END_PROC or quoted.",
  },
  {
    id: "hdr_dollar_quote_rejected",
    group: "header-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS $$
BEGIN
  RETURN 1;
END; $$`,
    parse: "reject",
    create: "error",
    call: "skip",
    notes: "Dollar-quoted bodies are not supported.",
  },

  // ==========================================================================
  // Arguments — Netezza takes input types only.
  // ==========================================================================
  {
    id: "args_types_single",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v ALIAS FOR $1;
BEGIN
  RAISE NOTICE 'STEP_01 arg %', v;
  RETURN v;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "5",
    expectNotices: ["STEP_01 arg 5"],
  },
  {
    id: "args_types_multi",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INTEGER, VARCHAR(100)) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  a ALIAS FOR $1;
BEGIN
  RETURN a;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "7, 'x'",
  },
  {
    id: "args_in_prefix",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(IN INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "5",
  },
  {
    id: "args_numeric_ps",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(NUMERIC(10,2)) RETURNS NUMERIC(10,2) LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v ALIAS FOR $1;
BEGIN
  RETURN v;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "1.25",
  },
  {
    id: "args_char_varying",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(CHARACTER VARYING(8)) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "'abc'",
  },
  {
    id: "args_boolean",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(BOOLEAN) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "true",
  },
  {
    id: "args_null_passed",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v ALIAS FOR $1;
BEGIN
  RAISE NOTICE 'STEP_01 isnull=%', v;
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "NULL",
    expectNotices: ["STEP_01 isnull=<NULL>"],
    notes: "A NULL argument is accepted and visible as NULL.",
  },
  {
    id: "args_arity_too_few",
    group: "args-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    callArgs: "",
    errorIncludes: "does not exist",
    notes: "Calling with the wrong arity is a runtime resolution error.",
  },
  {
    id: "args_type_mismatch",
    group: "args-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    callArgs: "'abc'",
    errorIncludes: "pg_atoi",
    notes: "Passing a non-numeric literal to an INT argument fails at runtime.",
  },
  {
    id: "args_named_lenient",
    group: "args-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(p_name VARCHAR(100), p_age INT4) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "error",
    call: "skip",
    errorIncludes: "expecting",
    notes:
      "Named parameters are rejected live, but the grammar cannot distinguish them from a multi-word type name without a brittle whitelist.",
  },
  {
    id: "args_out_rejected",
    group: "args-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(OUT INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    notes: "OUT parameters are not supported.",
  },
  {
    id: "args_inout_rejected",
    group: "args-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INOUT INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "error",
    call: "skip",
    notes: "INOUT parameters are not supported.",
  },
  {
    id: "args_varargs",
    group: "args",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(VARARGS) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "1, 2, 3",
  },

  // ==========================================================================
  // DECLARE section
  // ==========================================================================
  {
    id: "decl_alias_for_dollar",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}(INT) RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v ALIAS FOR $1;
BEGIN
  RETURN v * 2;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    callArgs: "21",
  },
  {
    id: "decl_constant_not_null_default",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  a INT := 1;
  b INT DEFAULT 2;
  c CONSTANT INT := 3;
  d INT NOT NULL := 4;
BEGIN
  RETURN a + b + c + d;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "decl_varray",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v VARRAY(3) OF INT;
BEGIN
  v(1) := 9;
  RETURN v(1);
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "decl_percent_type",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v ${T}.id%TYPE;
BEGIN
  v := 8;
  RETURN v;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "decl_rowtype",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r ${T}%ROWTYPE;
BEGIN
  r.id := 4;
  RETURN r.id;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "decl_record_for_select",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r RECORD;
  n INT;
BEGIN
  n := 0;
  FOR r IN SELECT id FROM ${T} LOOP
    n := n + r.id;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "Cursor-style FOR requires the loop variable to be declared RECORD.",
  },
  {
    id: "decl_varray_methods",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v VARRAY(3) OF INT;
BEGIN
  v.EXTEND(1);
  v(1) := 9;
  RETURN v(1);
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "VARRAY EXTEND and subscript assignment are supported.",
  },
  {
    id: "decl_record_select_into",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r RECORD;
BEGIN
  SELECT id, name INTO r FROM ${T} WHERE id = 1;
  RAISE NOTICE 'STEP_01 id=%', r.id;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 id=1"],
  },
  {
    id: "decl_rowtype_select_into",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r ${T}%ROWTYPE;
BEGIN
  SELECT id, name INTO r FROM ${T} WHERE id = 1;
  RAISE NOTICE 'STEP_01 id=%', r.id;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 id=1"],
  },
  {
    id: "decl_nested_block_shadow",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v INT := 1;
BEGIN
  DECLARE
    v INT := 2;
  BEGIN
    RAISE NOTICE 'STEP_01 inner=%', v;
  END;
  RAISE NOTICE 'STEP_02 outer=%', v;
  RETURN v;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 inner=2", "STEP_02 outer=1"],
    notes: "Inner DECLARE shadows the outer variable for the sub-block only.",
  },
  {
    id: "decl_double_precision",
    group: "declare",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v DOUBLE PRECISION := 1.5;
BEGIN
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "decl_constant_reassign",
    group: "declare-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  c CONSTANT INT := 1;
BEGIN
  c := 2;
  RETURN c;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    errorIncludes: "CONSTANT",
    notes: "Assigning to a CONSTANT fails at runtime.",
  },
  {
    id: "decl_not_null_assign_null",
    group: "declare-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  d INT NOT NULL := 1;
BEGIN
  d := NULL;
  RETURN d;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    errorIncludes: "NOT NULL",
    notes: "Assigning NULL to a NOT NULL variable fails at runtime.",
  },
  {
    id: "decl_missing_semicolon_lenient",
    group: "declare-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v1 INT v2 INT;
BEGIN
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "Grammar leniently reads the declaration as a multi-word type.",
  },

  // ==========================================================================
  // Control flow
  // ==========================================================================
  {
    id: "ctrl_if_elsif_else",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 5;
  IF n < 1 THEN
    RAISE NOTICE 'STEP_01 low';
    RETURN 1;
  ELSIF n < 10 THEN
    RAISE NOTICE 'STEP_02 mid';
    RETURN 2;
  ELSE
    RAISE NOTICE 'STEP_03 high';
    RETURN 3;
  END IF;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_02 mid"],
  },
  {
    id: "ctrl_elseif_alias",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 5;
  IF n < 1 THEN
    RETURN 1;
  ELSEIF n = 5 THEN
    RETURN 2;
  END IF;
  RETURN 9;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "Netezza accepts ELSEIF as a synonym for ELSIF.",
  },
  {
    id: "ctrl_while",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  i INT;
BEGIN
  i := 0;
  WHILE i < 5 LOOP
    i := i + 1;
  END LOOP;
  RETURN i;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "ctrl_loop_exit_when",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  i INT;
BEGIN
  i := 0;
  LOOP
    i := i + 1;
    EXIT WHEN i = 4;
  END LOOP;
  RETURN i;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "ctrl_labeled_loop",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  i INT;
BEGIN
  i := 0;
  <<l>> LOOP
    i := i + 1;
    EXIT l WHEN i = 3;
  END LOOP;
  RETURN i;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "ctrl_for_range",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 0;
  FOR i IN 1..3 LOOP
    n := n + i;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "ctrl_for_reverse",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 0;
  FOR i IN REVERSE 3..1 LOOP
    n := n + i;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "REVERSE requires descending bounds (3..1); 1..3 iterates zero times.",
  },
  {
    id: "ctrl_for_select_undeclared",
    group: "control-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 0;
  FOR r IN SELECT id FROM ${T} LOOP
    n := n + r.id;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes:
      "The loop variable must be declared RECORD; the parser is currently lenient.",
  },
  {
    id: "ctrl_case_rejected",
    group: "control-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 2;
  CASE n WHEN 1 THEN NULL; ELSE NULL; END CASE;
  RETURN n;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "CASE is not an NZPLSQL statement; use IF/ELSIF.",
  },
  {
    id: "ctrl_for_in_execute_dynamic",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r RECORD;
  n INT := 0;
BEGIN
  FOR r IN EXECUTE 'SELECT id FROM ${T}' LOOP
    n := n + r.id;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "Dynamic record-set FOR over EXECUTE requires a RECORD loop variable.",
  },
  {
    id: "ctrl_elseif_chain",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT := 7;
BEGIN
  IF n < 3 THEN
    RETURN 1;
  ELSEIF n < 5 THEN
    RETURN 2;
  ELSEIF n < 9 THEN
    RETURN 3;
  ELSE
    RETURN 4;
  END IF;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "ctrl_continue_rejected",
    group: "control-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  i INT := 0;
  n INT := 0;
BEGIN
  WHILE i < 5 LOOP
    i := i + 1;
    CONTINUE WHEN i = 3;
    n := n + i;
  END LOOP;
  RETURN n;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    errorIncludes: "CONTINUE",
    notes: "CONTINUE is not part of NZPLSQL iterative control (LOOP/WHILE/FOR/EXIT only).",
  },
  {
    id: "ctrl_nested_begin",
    group: "control",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  n := 0;
  BEGIN
    n := n + 5;
  END;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },

  // ==========================================================================
  // Embedded SQL
  // ==========================================================================
  {
    id: "sql_select_into",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM ${T};
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "sql_insert_update_delete",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  INSERT INTO ${T} VALUES (50, 'x');
  UPDATE ${T} SET name = 'y' WHERE id = 50;
  DELETE FROM ${T} WHERE id = 50;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "sql_execute_immediate_ddl",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  s VARCHAR(300);
BEGIN
  s := 'CREATE TEMP TABLE jbl_tmp_' || 'matrix (a INT)';
  EXECUTE IMMEDIATE s;
  RAISE NOTICE 'STEP_01 ddl done';
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 ddl done"],
  },
  {
    id: "sql_found_rowcount",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  SELECT id INTO n FROM ${T} WHERE id = 1;
  IF FOUND THEN
    RAISE NOTICE 'STEP_01 found';
  END IF;
  RETURN ROW_COUNT;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 found"],
  },
  {
    id: "sql_select_into_multi",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v_id INT;
  v_name VARCHAR(20);
BEGIN
  SELECT id, name INTO v_id, v_name FROM ${T} WHERE id = 1;
  RAISE NOTICE 'STEP_01 %/%', v_id, v_name;
  RETURN v_id;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 1/a"],
  },
  {
    id: "sql_truncate",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  CREATE TEMP TABLE jbl_matrix_trunc (a INT);
  TRUNCATE TABLE jbl_matrix_trunc;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "sql_commit_in_proc",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  COMMIT;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "COMMIT is accepted in a singleton CALL (verified live).",
  },
  {
    id: "sql_rollback_in_proc",
    group: "sql",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  ROLLBACK;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "ROLLBACK is accepted in a singleton CALL (verified live).",
  },
  {
    id: "exec_immediate_into_rejected",
    group: "sql-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT;
BEGIN
  EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ${T}' INTO n;
  RETURN n;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    errorIncludes: "INTO",
    notes: "EXECUTE IMMEDIATE ... INTO is not supported; use SELECT ... INTO.",
  },
  {
    id: "insert_returning_into_rejected",
    group: "sql-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v INT;
BEGIN
  INSERT INTO ${T} (id, name) VALUES (99, 'z') RETURNING id INTO v;
  RETURN v;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    errorIncludes: "RETURNING",
    notes: "INSERT ... RETURNING ... INTO is not supported.",
  },
  {
    id: "sql_perform_rejected",
    group: "sql-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  PERFORM do_work();
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    notes: "PERFORM is not supported by NZPLSQL.",
  },
  {
    id: "sql_execute_using_rejected",
    group: "sql-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  EXECUTE IMMEDIATE 'UPDATE ${T} SET name = ? WHERE id = 1' USING 'Drama';
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    notes: "EXECUTE IMMEDIATE ... USING is not supported; use concatenation.",
  },
  {
    id: "sql_null_rejected",
    group: "sql-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  NULL;
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    notes: "A bare NULL statement is not accepted.",
  },

  // ==========================================================================
  // Exceptions
  // ==========================================================================
  {
    id: "exc_when_others",
    group: "exception",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  RAISE NOTICE 'STEP_99 unreachable';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'STEP_01 caught';
      RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 caught"],
  },
  {
    id: "exc_when_transaction_aborted",
    group: "exception",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  EXCEPTION
    WHEN TRANSACTION_ABORTED THEN
      RETURN 0;
    WHEN OTHERS THEN
      RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "exc_sqlerrm_notice",
    group: "exception",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'STEP_01 err=%', SQLERRM;
      RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 err=boom"],
    notes: "SQLERRM is available inside the OTHERS handler.",
  },
  {
    id: "exc_sqlstate_var_rejected",
    group: "exception-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'STEP_01 state=%', SQLSTATE;
      RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    errorIncludes: "SQLSTATE",
    notes: "SQLSTATE is not exposed as a variable in the OTHERS handler.",
  },
  {
    id: "exc_nested_catch",
    group: "exception",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  BEGIN
    RAISE EXCEPTION 'inner';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'STEP_01 inner caught';
  END;
  RAISE NOTICE 'STEP_02 outer continues';
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 inner caught", "STEP_02 outer continues"],
    notes: "An inner block handler catches the exception and the outer block continues.",
  },
  {
    id: "exc_named_rejected",
    group: "exception-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "Only OTHERS and TRANSACTION_ABORTED handlers are supported.",
  },
  {
    id: "exc_sqlstate_rejected",
    group: "exception-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE EXCEPTION 'boom';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "WHEN SQLSTATE is not supported.",
  },
  {
    id: "exc_without_handler_rejected",
    group: "exception-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 0;
  EXCEPTION
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    notes: "EXCEPTION requires at least one WHEN handler.",
  },

  // ==========================================================================
  // RAISE
  // ==========================================================================
  {
    id: "raise_notice_variable",
    group: "raise",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v INT;
BEGIN
  v := 3;
  RAISE NOTICE 'STEP_01 v=%', v;
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 v=3"],
  },
  {
    id: "raise_debug",
    group: "raise",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE DEBUG 'debug only';
  RETURN 0;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "raise_record_field",
    group: "raise",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  r RECORD;
BEGIN
  SELECT id, name INTO r FROM ${T} WHERE id = 1;
  RAISE NOTICE 'STEP_01 id=%', r.id;
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 id=1"],
    notes: "RAISE arguments may be record fields.",
  },
  {
    id: "raise_expression_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v INT := 1;
BEGIN
  RAISE NOTICE 'STEP_01 v=%', v + 1;
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "RAISE arguments must be variables/record fields, not expressions.",
  },
  {
    id: "raise_function_call_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  v VARCHAR(10) := 'a';
BEGIN
  RAISE NOTICE 'STEP_01 v=%', UPPER(v);
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "syntax error",
    notes: "Function calls are not valid RAISE arguments.",
  },
  {
    id: "raise_no_message_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE;
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "STRING",
    notes: "RAISE requires a message string (verified live).",
  },
  {
    id: "raise_literal_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE 'STEP_01 x=%', 1;
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    notes: "RAISE arguments must be variables, record fields, or special vars.",
  },
  {
    id: "raise_warning_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE WARNING 'warn';
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    notes: "Only DEBUG, NOTICE and EXCEPTION severities exist.",
  },
  {
    id: "raise_error_rejected",
    group: "raise-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE ERROR 'fatal';
  RETURN 0;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    notes: "Only DEBUG, NOTICE and EXCEPTION severities exist.",
  },

  // ==========================================================================
  // System / misc
  // ==========================================================================
  {
    id: "sys_autocommit_on",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  AUTOCOMMIT ON;
  RAISE NOTICE 'STEP_01 autocommit';
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 autocommit"],
  },
  {
    id: "sys_comments",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  n INT; -- line comment
  /* block comment */
BEGIN
  n := 1;
  RETURN n;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
  },
  {
    id: "sys_autocommit_off",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  AUTOCOMMIT OFF;
  RAISE NOTICE 'STEP_01 off';
  RETURN 1;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectNotices: ["STEP_01 off"],
  },
  {
    id: "sys_return_no_expr",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "Bare RETURN yields a NULL scalar result.",
  },
  {
    id: "sys_trailing_semicolons",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC
;;;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    notes: "Extra trailing semicolons after END_PROC are tolerated.",
  },
  {
    id: "sys_reftable_resultset",
    group: "system",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS REFTABLE(${T}) LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  s VARCHAR(300);
BEGIN
  s := 'INSERT INTO ' || REFTABLENAME || ' SELECT id, name FROM ${T} ORDER BY id';
  EXECUTE IMMEDIATE s;
  RETURN REFTABLE;
END;
END_PROC;`,
    parse: "accept",
    create: "ok",
    call: "ok",
    expectRows: [[1, "a"], [2, "b"]],
    notes: "REFTABLE result sets are populated with dynamic SQL and returned via CALL.",
  },
  {
    id: "cursor_explicit_rejected",
    group: "cursor-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
DECLARE
  c CURSOR FOR SELECT id FROM ${T};
  v INT;
BEGIN
  OPEN c;
  FETCH c INTO v;
  CLOSE c;
  RETURN v;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "body-compile",
    errorIncludes: "CURSOR",
    notes: "Explicit cursors (DECLARE CURSOR/OPEN/FETCH/CLOSE) are not supported; use FOR ... IN SELECT.",
  },
  {
    id: "sys_goto_rejected",
    group: "system-negative",
    sql: `CREATE OR REPLACE PROCEDURE ${P}() RETURNS INT4 LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  GOTO lbl;
  RETURN 1;
END;
END_PROC;`,
    parse: "reject",
    create: "ok",
    call: "error",
    callPhase: "runtime",
    notes: "GOTO is not supported.",
  },
];

export function findProcedureMatrixCase(id: string): ProcedureMatrixCase | undefined {
  return PROCEDURE_MATRIX_CASES.find((entry) => entry.id === id);
}
