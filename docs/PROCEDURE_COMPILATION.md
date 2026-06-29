# Procedure Compilation & Diagnostics (Copilot Tools)

JustyBase provides three Copilot language model tools that enable the AI agent to autonomously compile, execute, and validate stored procedures on Netezza in an interactive fix-and-test cycle.

## Tools

### `#compileProcedure`

Compiles a stored procedure by executing `CREATE OR REPLACE PROCEDURE` (or `ALTER`) DDL as a non-query statement.

**Parameters:**
- `sql` (required) — The full `CREATE OR REPLACE PROCEDURE ...` statement
- `database` (optional) — Database name for scoped execution

**Returns:**
- `Compilation SUCCESS: <message>` when the procedure compiles without errors
- `Compilation FAILED: <exception message>` when the database rejects the DDL

The agent uses the exception message to identify syntax or semantic errors and iterates on the fix.

---

### `#executeProcedure`

Executes a stored procedure via `CALL` statement.

**Parameters:**
- `procedureName` (required) — Procedure name. Supports `DB..PROC_NAME`, `SCHEMA.PROC_NAME`, or simple name notation
- `arguments` (optional) — Comma-separated arguments, e.g. `1, 'text', NULL`
- `database` (optional) — Database name for scoped execution

**Returns:**
- `Execution SUCCESS: <message>` when the CALL completes
- `Execution FAILED: <exception message>` on runtime errors

This tool returns status only — it does **not** capture result data. Use `#executeQuery` afterward if you need to inspect side effects.

---

### `#runDiagnosticQueries`

Runs one or more user-provided diagnostic SQL queries to validate that a procedure behaves correctly. Each query is reported as PASS or FAIL.

**Parameters:**
- `queries` (required) — Array of SQL query strings. Each must be a complete executable statement (typically `SELECT`).
- `database` (optional) — Database name for scoped execution

**Returns:**
```
Diagnostics complete: 2 passed, 0 failed out of 2 queries.

Diagnostic #1 PASS: <query result>
Diagnostic #2 PASS: <query result>
```

---

## Agent Workflow

When you ask the agent to fix or create a stored procedure, it follows this cycle:

```
User:  "Fix this procedure..."
Agent: "Do you have diagnostic SQL queries to validate correctness?"
User:  "SELECT COUNT(*) FROM ... WHERE ... HAVING ..."
Agent: ─────────────────────────────────────────────────────
       1. compileProcedure(sql)         → SUCCESS or FAILED
       2. if FAILED → analyze error → fix code → goto 1
       3. runDiagnosticQueries(queries) → PASS or FAIL
       4. if any FAIL → analyze results → fix code → goto 1
       5. executeProcedure(name, args)  → SUCCESS or FAILED
       6. if FAILED → analyze error → fix code → goto 1
```

The agent will keep iterating until all diagnostics pass and the procedure executes successfully, or until it determines it cannot resolve the issue.

---

## Example

```
User:
  Fix this procedure:
  
  CREATE OR REPLACE PROCEDURE MYDB..CALC_BONUS(INTEGER, INTEGER)
  LANGUAGE NZPLSQL
  AS BEGIN
    DECLARE v_base ALIAS FOR $1;
    DECLARE v_bonus ALIAS FOR $2;
    v_result := v_base + v_bonus * 1.2;
  END;

Agent:
  Do you have diagnostic SQL queries to validate correctness?

User:
  SELECT 1 AS test WHERE (5 + 3 * 1.2) = 8.6

Iteration 1:
  → compileProcedure → FAILED: variable V_RESULT is not declared
  → Agent adds DECLARE v_result INTEGER;

Iteration 2:
  → compileProcedure → SUCCESS
  → runDiagnosticQueries → PASS
  → executeProcedure(MYDB..CALC_BONUS, "100, 50") → SUCCESS
  → Agent reports: Procedure compiled and verified.
```

---

## Notes

- The agent will **ask** you for diagnostic queries before starting — you don't need to volunteer them unprompted.
- Diagnostic queries are stateless: pass them each time via `#runDiagnosticQueries`. The agent holds them in conversation context.
- All tools require an active Netezza database connection.
- Compilation errors from the database (variable scoping, type mismatches, syntax mistakes) are surfaced verbatim so the agent can act on them.
