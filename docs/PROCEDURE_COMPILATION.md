# Procedure workflow with Copilot

Copilot exposes `netezza_repair_procedure` for one complete `CREATE PROCEDURE` or
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

The MCP server remains read-only. Procedure compilation and test execution are
available only through the explicitly confirmed VS Code Copilot tool.
