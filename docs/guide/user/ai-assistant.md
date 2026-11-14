---
title: AI SQL Assistant
description: Use GitHub Copilot agent mode, JustyBase language-model tools, skills, and the read-only MCP surface in a reviewable workflow that keeps data transmission and execution explicit.
audience: user
category: Product guides
status: Supported
last_verified: 2026-11-12
product_version: 3.20.8
---

# AI SQL Assistant

JustyBase exposes its database knowledge to the Copilot agent instead of running its own chat orchestration. The agent decides when to call a tool, the tools return only the requested metadata, and you review every edit or write action.

```text
diagnostic → tool context → agent explanation → suggested change → diff review → user execution
```

## Available workflows

<figure class="figure-wide">
  <img src="screenshots/copilot-chat.png" alt="AI-assisted SQL correction in JustyBase">
  <figcaption>Copilot explains, fixes, optimizes, or generates SQL while the final decision stays with you.</figcaption>
</figure>

- **Fix SQL** — use the `/justybase-fix` prompt or ask the agent to fix the active query.
- **Optimize SQL** — use `/justybase-optimize`; the agent combines `#netezza_explain_sql`, table statistics, and dependencies.
- **Explain SQL** — use `/justybase-explain`.
- **Best Practices** — use `/justybase-best-practices`.
- **Custom question or SQL generation** — ask in Copilot Chat; the agent can call JustyBase tools as needed.
- **Repair Netezza procedure** — the agent uses `#netezza_repair_procedure`, which compiles a complete procedure and bounds retries. `compile_and_call` requires a separate confirmation.
- **Describe result data** — from the Results panel. The extension shows a privacy confirmation and opens Copilot Chat with a markdown table.
- **Review a SQL error** — the error card and linter quick fix open a preview of the exact prompt and offer **Copy prompt**. The extension never sends it automatically.

## Tools: the current contract

Language-model tools are registered from `src/contracts/copilotTools/contracts.ts` and the activation registry. They are read-only except the explicitly guarded procedure repair tool.

| Tool | Purpose |
| --- | --- |
| `#netezza_get_context` | Active SQL, dialect, connection, referenced DDL, and diagnostics |
| `#netezza_search_catalog` | Databases, schemas, tables, views, procedures, external tables, columns, and table locations |
| `#netezza_get_object_details` | DDL, columns, comments, statistics, dependencies, and workspace favorites |
| `#netezza_explain_sql` | Read-only EXPLAIN with plan nodes, hotspots, and risk |
| `#netezza_validate_sql` | Parser/linter validation without a database |
| `#netezza_validate_sql_on_database` | Read-only database-side validation |
| `#netezza_repair_procedure` | Guarded procedure compile/repair loop |
| `#netezza_inspect_import_file` | Delimiter, type, and sample-row inference |
| `#netezza_propose_import_mapping` | Source-to-target mapping and CREATE guidance |
| `#netezza_get_dialect_reference` | Netezza SQL, optimization, and NZPLSQL reference rules |

The agent adds JustyBase skills automatically:

- `justybase-sql` — dialect rules, naming conventions, safe change workflow.
- `justybase-performance` — EXPLAIN, statistics, dependencies, rewrite validation.
- `justybase-procedure` — NZPLSQL constraints and guarded repair.
- `justybase-import` — file inspection and mapping workflow.

## Context and privacy

Tools return only what the agent requests. `#netezza_get_context` can include the active SQL, referenced table DDL, and diagnostics; `#netezza_get_object_details` can include comments, statistics, and favorites. Tool invocations are approved by the chat host, and write-capable tools add their own confirmation.

`justybase.copilot.enabled` controls whether JustyBase registers its language-model tools. The read-only MCP server is controlled separately by `justybase.mcp.enabled`. `justybase.ddl.maxTablesForContext` and `justybase.copilot.maxWorkspaceProfilesInContext` bound context size.

Do not attach secrets, passwords, tokens, regulated row data, or an unreviewed production dump as AI context. Prefer a read-only connection and a sanitized query. Copilot’s own retention, account, model, and organization policies still apply; JustyBase cannot override them.

## MCP: read-only by design

The bundled Netezza MCP server exposes catalog introspection, DDL, safe `EXPLAIN`, plan analysis, and parser validation. Its tools are catalog-built and read-only: no arbitrary SQL, DML, DDL, table scans, or password files. Stdio mode serves Copilot Chat; optional HTTP mode binds to `127.0.0.1` only while VS Code is open. The selected MCP connection is explicit and independent of the active editor tab.

Enable MCP under **JustyBase Settings → MCP Server**, choose the saved Netezza connection, and enable only the transport needed. Read the [MCP technical appendix](guide/legacy/mcp_server/) for client examples and the complete generated tool catalog.

## Review before applying a fix

1. Read the diagnostic and inspect the affected source range.
2. Ask the agent to use `#netezza_get_context` for the SQL and schema context.
3. Compare the proposed diff, including identifiers, predicates, joins, and transaction behavior.
4. Validate the rewrite with `#netezza_validate_sql`.
5. Use `#netezza_explain_sql` or `#netezza_validate_sql_on_database` for a read-only plan check where appropriate.
6. For a Netezza procedure, prefer `compile_only` unless a controlled test `CALL` is intended; review the separate `CALL` confirmation and typed arguments.
7. Save the corrected procedure only after reviewing the editor diff.

## Troubleshooting

- No AI tools: check `justybase.copilot.enabled`, Copilot availability, and that the extension is running.
- Missing schema context: refresh metadata and confirm the selected connection/database.
- Tool not available: use `#` in chat to inspect the registered tool list; tools appear while the extension is active.
- Privacy prompt rejected: the action stops without sending the context.
- MCP sees the wrong database: select the MCP connection explicitly; it never follows a tab change.
