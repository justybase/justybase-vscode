---
name: justybase-procedure
description: Author, review, or repair Netezza NZPLSQL procedures with JustyBase tools. Use for CREATE PROCEDURE blocks, procedure compile errors, NZPLSQL syntax questions, or guarded procedure repair.
---

# JustyBase NZPLSQL workflow

1. Call `#netezza_get_context` for the procedure body and its diagnostics.
2. Call `#netezza_get_dialect_reference` with `topic: "nzplsql"` before rewriting syntax.
3. Use `#netezza_validate_sql` for parser validation. It does not prove database compilation.
4. Use `#netezza_repair_procedure` when the procedure must be compiled. This tool is write-capable and requires user confirmation. Prefer `compile_only`; use `compile_and_call` only when the user understands that a test CALL may repeat side effects.
5. Review the compile diagnostics before proposing another attempt. The tool stops after three attempts.

## NZPLSQL constraints

- The body is `BEGIN_PROC ... END_PROC` or a quoted string. `AS` is required; `IS` is rejected.
- `RETURNS` and `LANGUAGE NZPLSQL` are required in the header.
- Arguments are input types only. Named parameters and `OUT`/`INOUT` are rejected. Use `ALIAS FOR $n` in `DECLARE`.
- Explicit cursors are not supported. `FOR r IN SELECT ... LOOP` requires `r` declared as `RECORD`.
- Exception handlers: only `WHEN OTHERS` and `WHEN TRANSACTION_ABORTED`. `SQLERRM` is available; `SQLSTATE` is not.
- `RAISE` supports `DEBUG`, `NOTICE`, and `EXCEPTION`; a message string is required and trailing arguments must be variables or record fields.
- `RETURNS REFTABLE(t)` populates the special `REFTABLENAME` variable with dynamic SQL and returns `RETURN REFTABLE`.
- Unsupported: `PERFORM`, `EXECUTE IMMEDIATE ... USING`, `EXECUTE IMMEDIATE ... INTO`, `INSERT ... RETURNING ... INTO`, `CASE`, `CONTINUE`, `GOTO`, `GET DIAGNOSTICS`, argument `DEFAULT`, bare `NULL;`, `$$` bodies.
- A plain `EXIT` leaves only the current nested block; use `EXIT label` to leave a loop.
- Qualified routine calls in a SELECT list are not parsed by the shared grammar. Use an unqualified call or `CALL`.

Do not save or execute a procedure unless the user explicitly asks.
