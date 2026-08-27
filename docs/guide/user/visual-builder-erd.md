---
title: Visual Query Builder and ERD
description: Build a query from tables and relationships, then inspect structure and dependencies visually.
audience: user
category: Product guides
status: Partial
last_verified: 2026-08-19
product_version: 3.17.2
---

# Visual Query Builder and ERD

## Visual Query Builder

<figure class="figure-wide">
  <img src="screenshots/visual_query_builder.png" alt="Visual Query Builder with joined sources, selected columns, filter and sort controls, and SQL preview">
  <figcaption>Drag tables onto the canvas, connect columns, and open the generated SQL in the editor.</figcaption>
</figure>

<figure>
  <img src="gifs/query_builder.gif" alt="Building a joined SQL query visually in JustyBase">
  <figcaption>Add sources, joins, predicates, grouping, and limits, then generate the query.</figcaption>
</figure>

Open **Visual Query Builder** from a table/view group or the Command Palette. Add tables, select columns, draw joins, add predicates, grouping, ordering, and limits, then generate SQL into the editor. Review the generated identifiers and dialect before execution.

The builder is strongest for Netezza and DuckDB/File SQL workflows. It uses metadata to populate columns and relationships; a stale cache can make a real table appear empty. It does not infer business semantics from arbitrary SQL and should not be treated as a visual guarantee that a join is correct.

## ERD

<figure class="figure-wide">
  <img src="gifs/erd.gif" alt="Generating and exploring an ERD in JustyBase">
  <figcaption>ERDs make relationships and dependencies visible from catalog metadata.</figcaption>
</figure>

Open **Show ERD** for a table group or selected object. The diagram uses available catalog constraints and related object metadata. It is useful for orientation and dependency review; missing foreign keys mean missing edges, not proof that no business relationship exists.

## Review checklist

1. Confirm the connection/database before loading objects.
2. Refresh metadata if the diagram predates a migration.
3. Inspect join cardinality and null behavior in the generated SQL.
4. Use the parser/linter to review the SQL, then use `EXPLAIN` where supported.
5. Save the generated query in source control rather than relying on a canvas snapshot.

The ERD is a read-only visualization. The builder generates text; it does not execute or alter tables until the user runs the resulting SQL.
