---
name: justybase-explain
description: Explain what the SQL in the active editor does.
---

Use the `justybase-sql` skill.

Explain the SQL in the active editor.

1. Call `#netezza_get_context` to read the SQL, dialect, and diagnostics.
2. Summarize the statement's purpose, inputs, joins, filters, and output.
3. Call out dialect-specific behavior and any risky operations.
4. Mention diagnostics that affect correctness or performance.
5. Do not rewrite or execute the query unless the user asks.
