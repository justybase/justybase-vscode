---
name: justybase-performance
description: Analyze Netezza query performance with JustyBase tools. Use when asked to optimize a query, explain a plan, investigate skew or distribution, or compare a rewrite against the original plan.
---

# JustyBase performance workflow

1. Call `#netezza_get_context` to capture the SQL and diagnostics.
2. Call `#netezza_explain_sql` with the query. Inspect nodes, hotspots, risk, and the raw plan.
3. Collect metadata for referenced tables with `#netezza_get_object_details` using `sections: ["stats", "dependencies", "columns"]`.
4. Check table distribution, row counts, skew, and join keys. Call `#netezza_search_catalog` when a referenced table cannot be resolved.
5. Propose changes one at a time: predicate pushdown, join order, distribution, statistics refresh, or set-based rewrites.
6. Re-run `#netezza_validate_sql` and `#netezza_explain_sql` on the rewrite.
7. Report the plan delta, not only the rewritten SQL. If cost markers are unavailable, say so.

## Guidelines

- Do not claim a speedup without evidence from the plan or statistics.
- Distinguish estimated cost from measured runtime.
- Prefer catalog-based statistics; do not scan user tables.
- Keep Netezza-specific features when they are valid.
- If the query is procedural, load the `justybase-procedure` skill first.
