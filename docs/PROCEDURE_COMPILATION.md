# Procedure workflow with Copilot

Copilot exposes `netezza_compile_procedure` for one complete `CREATE PROCEDURE` or
`CREATE OR REPLACE PROCEDURE` block from the active SQL editor.

The tool supports two modes:

- `compile_only` compiles the procedure and returns the database diagnostic when
  compilation fails. Copilot can prepare a corrected complete procedure and
  retry, with a hard limit of three attempts.
- `compile_and_call` performs the same compilation workflow and then asks for a
  separate explicit confirmation before executing a typed-argument test `CALL`.
  A failed test call can guide another correction within the same three-attempt
  limit, but every retry may repeat database side effects.

Arguments for `CALL` are typed values (`string`, `number`, `boolean`, `null`,
`date`, or `timestamp`); raw SQL fragments are not accepted. The tool updates
the active editor after a successful compilation but never saves the file
automatically.

The MCP server exposes the same `compile_procedure` tool only when the MCP
surface is granted the write tier and the selected connection is in
`writableConnections`. HTTP mode additionally requires its bearer token. The
compile call executes procedure DDL; `compile_and_call` also executes the test
`CALL` and may repeat its side effects on each retry.
