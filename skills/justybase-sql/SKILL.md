---
name: justybase-sql
description: Review, fix, explain, or rewrite Netezza SQL with JustyBase tools. Use for SQL diagnostics, query corrections, dialect-specific naming, and safe change workflows in a JustyBase workspace.
---

# JustyBase SQL workflow

Use this skill when the user asks about the SQL in the active editor, a diagnostic, a query rewrite, or Netezza syntax.

## Safe workflow

1. Call `#netezza_get_context` first. It returns the active SQL, connection, referenced table DDL, and parser/linter diagnostics.
2. If the SQL references tables that are not in the context, call `#netezza_search_catalog` and then `#netezza_get_object_details` for columns, DDL, comments, or dependencies.
3. Validate a proposed rewrite with `#netezza_validate_sql` before presenting it as ready.
4. Use `#netezza_explain_sql` when performance is part of the request.
5. Show the proposed change as a diff or a SQL block. Do not claim it was applied unless the user applied it.
6. Never execute DML, DDL, or arbitrary SQL. JustyBase tools are read-only except `#netezza_repair_procedure`, which requires an explicit user confirmation.

## Netezza naming rules

- `DATABASE.SCHEMA.OBJECT` is fully qualified.
- `DATABASE..OBJECT` means the object is resolved in the specified database (schema defaults to `ADMIN` in many contexts).
- `SCHEMA.OBJECT` uses the current database.
- `OBJECT` uses the current database and schema.
- `_V_TABLE`, `_V_VIEW`, and `_V_PROCEDURE` exist in each database. Use `DATABASE.._V_TABLE` to inspect a specific database.
- Do not rewrite valid Netezza naming patterns into ANSI two-part names.

## Review rules

- Preserve Netezza-specific syntax and extensions.
- Prefer explicit joins and predicates.
- When fixing an error, explain the cause, then the corrected SQL, then the behavior change.
- If metadata is unavailable, say so instead of inventing columns or tables.
- For NZPLSQL bodies, also load the `justybase-procedure` skill.
