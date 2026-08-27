---
title: SQL Console, notebooks and macros
description: Use focused SQL surfaces for ad-hoc sessions, repeatable notebooks, and SAS-like macro expansion.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.2
---

# SQL Console, notebooks and macros

## SQL Console

**JustyBase: Open SQL Console** opens a scratch-oriented SQL surface from a connection or database node. It is useful for a quick catalog check, a one-off `EXPLAIN`, or a small read-only query without first creating a project file. The console still uses the selected connection, parser, linter, result panel, and safe-execute policy.

Use a normal `.sql` file when the query needs review history, source control, CodeLens, or a repeatable workflow.

## Notebooks

SQL notebooks group narrative text, SQL cells, parameters, and result cells. Run one cell while keeping the surrounding explanation visible, then export or share the notebook according to your workspace policy. A cell’s connection/database context must be reviewed before execution; notebook convenience does not override tab context.

Notebooks are **Partial** across dialects: parser and execution support follow the selected database and the current notebook surface. Consult the technical [Notebooks appendix](guide/legacy/notebooks/) when diagnosing a provider-specific behavior.

## SAS-like macros

The macro layer supports variable substitution and selected SQL/file helpers for teams migrating repeatable SAS-like workflows. Macro expansion is parser-aware where possible; an expanded statement still goes through normal diagnostics before execution. File/export helpers can run a query and write XLSX/XLSB/Parquet/CSV/XPT depending on the macro form and runtime.

Keep macro input deterministic and avoid putting secrets in macro variables. Inspect the expanded SQL and output path before running a macro that writes a file or database object.

## Troubleshooting

- If a notebook cell has no completion, set its dialect and connection explicitly.
- If a macro expands to an unexpected object name, verify quoting and `DB..TABLE` notation after expansion.
- If a console query uses stale objects, refresh selected metadata; the console shares the cache but not necessarily the editor’s visible tree state.
