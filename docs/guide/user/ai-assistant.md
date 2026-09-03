---
title: AI SQL Assistant
description: Use Copilot and the read-only MCP surface in a reviewable workflow that keeps data transmission and execution explicit.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.11
---

# AI SQL Assistant

JustyBase adds SQL context to GitHub Copilot workflows without making the model the executor. The intended loop is:

```text
diagnostic → schema/DDL context → Copilot explanation → suggested fix → diff review → user execution
```

## Available workflows

<figure class="figure-wide">
  <img src="screenshots/copilot-chat.png" alt="AI-assisted SQL correction in JustyBase">
  <figcaption>Copilot explains, fixes, optimizes, or generates SQL while the final decision stays with you.</figcaption>
</figure>

- **Fix SQL** — explain diagnostics and propose a corrected query.
- **Optimize SQL** — discuss joins, predicates, distribution, and database-specific trade-offs.
- **Explain SQL** — summarize a statement using its actual aliases, CTEs, tables, and diagnostics.
- **Best Practices** — rewrite toward the selected dialect’s documented practices.
- **Custom Question** — ask about the selected SQL and its context.
- **Generate SQL** — describe a query goal and review the generated SQL before saving or running it.

These actions produce text, chat interaction, or a guarded rewrite proposal. The user decides whether to apply, save, or execute the result.

## Context that may be gathered

Depending on the action and confirmation, the context builder may include:

- selected SQL and parser/linter diagnostics;
- database kind, connection/database/schema scope, and referenced object names;
- table profiles, DDL, column types, comments, and dependencies;
- current query history summary and workspace notes/favorites;
- locally analyzed procedure context;
- the selected result or import profile when the workflow requests it.

`justybase.ddl.maxTablesForContext` and `justybase.copilot.maxWorkspaceProfilesInContext` bound context size. Empty or unavailable metadata is reported as unavailable; it is not fabricated.

## Privacy and confirmation

<figure>
  <img src="screenshots/security-panel.png" alt="Privacy confirmation before an AI action transmits SQL or metadata">
  <figcaption>Confirmations describe what is sent before a supported AI action transmits context.</figcaption>
</figure>

When an action would send SQL or metadata to the Copilot service, JustyBase shows a confirmation describing the operation and context. `justybase.copilot.skipPrivacyConfirmation` can skip that prompt only when the user and organization have made that policy decision. `justybase.copilot.enabled` is the broad off switch; when false, AI features are unavailable and the extension does not send their context.

Do not select secrets, passwords, tokens, regulated row data, or an unreviewed production dump as AI context. Prefer a read-only connection and a sanitized query. Copilot’s own retention, account, model, and organization policies still apply; JustyBase cannot override them.

## Tools: current contract

Language Model Tools are registered from the current tool contracts in `src/contracts/copilotTools/contracts.ts` and activation registry. They provide schema/table/column discovery, DDL, dependencies, comments, favorites, diagnostics, import inspection/mapping, tuning advice, and database validation. They are not arbitrary SQL execution tools.

`validateSqlOnDatabase` is a guarded database-side validation/`EXPLAIN` path. It is not a general-purpose “run whatever SQL Copilot writes” operation. The user still reviews the SQL and decides whether to execute a statement through the normal query workflow.

The exact names and current count are generated in the [AI and MCP reference](guide/reference/web-api/), so examples do not drift from the registered code.

## MCP: read-only by design

The bundled Netezza MCP server exposes catalog introspection, DDL, safe `EXPLAIN`, plan analysis, and parser validation. Its tools are catalog-built and read-only: no arbitrary SQL, DML, DDL, table scans, or password files. Stdio mode serves Copilot Chat; optional HTTP mode binds to `127.0.0.1` only while VS Code is open. The selected MCP connection is explicit and independent of the active editor tab.

Enable MCP under **JustyBase Settings → MCP Server**, choose the saved Netezza connection, and enable only the transport needed. Read the [MCP technical appendix](guide/legacy/mcp_server/) for client examples and the complete generated tool catalog.

## Review before applying a fix

1. Read the diagnostic and inspect the affected source range.
2. Ask Copilot for a fix with schema/DDL context.
3. Compare the proposed diff, including identifiers, predicates, joins, and transaction behavior.
4. Re-run parser/linter diagnostics.
5. Use `EXPLAIN` or `validateSqlOnDatabase` for a read-only plan check where appropriate.
6. Execute manually with the correct connection and safe-execute confirmation.

## Troubleshooting

- No AI action: check `justybase.copilot.enabled`, Copilot availability, and the request timeout.
- Missing schema context: refresh metadata and confirm the selected connection/database.
- Tool not available: use the generated names in the reference page and verify that the required database connection and Copilot surface are enabled.
- Privacy prompt rejected: the action stops without sending the context.
- MCP sees the wrong database: select the MCP connection explicitly; it never follows a tab change.
