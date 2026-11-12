---
name: justybase-fix
description: Fix the SQL in the active editor using JustyBase context and diagnostics.
---

Use the `justybase-sql` skill.

Fix the SQL in the active editor.

1. Call `#netezza_get_context` to read the SQL and diagnostics.
2. Identify the root cause of each error.
3. Propose the corrected SQL as a diff or SQL block.
4. Call `#netezza_validate_sql` on the corrected SQL.
5. Explain what changed and why. Do not apply the edit or execute SQL without asking.
