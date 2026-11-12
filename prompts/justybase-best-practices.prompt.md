---
name: justybase-best-practices
description: Rewrite the SQL in the active editor to follow Netezza best practices.
---

Use the `justybase-sql` and `justybase-performance` skills.

Rewrite the SQL in the active editor to follow Netezza best practices.

1. Call `#netezza_get_context`.
2. Collect referenced object details with `#netezza_get_object_details` when they affect the rewrite.
3. Apply dialect-aware improvements: explicit joins, sargable predicates, sensible distribution and statistics, and readable structure.
4. Preserve valid Netezza-specific syntax and naming.
5. Validate the rewrite with `#netezza_validate_sql` and, when performance is affected, compare plans with `#netezza_explain_sql`.
6. Present the diff and rationale. Do not apply or execute it without asking.
