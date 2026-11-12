---
name: justybase-optimize
description: Optimize the SQL in the active editor for Netezza performance.
---

Use the `justybase-performance` skill.

Optimize the SQL in the active editor.

1. Call `#netezza_get_context`.
2. Call `#netezza_explain_sql` on the current query.
3. Collect table statistics and dependencies with `#netezza_get_object_details`.
4. Propose focused changes and explain the expected effect.
5. Validate the rewrite with `#netezza_validate_sql` and compare its plan with `#netezza_explain_sql`.
6. Report plan deltas and any uncertainty. Do not apply or execute the rewrite without asking.
