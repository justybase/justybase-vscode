---
title: Query Flow and File Search
description: Trace table flow through a SQL statement and find files, paths, or workspace data without leaving VS Code.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.8
---

# Query Flow and File Search

## Query Flow visualization

Run **Visualize Query Flow** on a statement to inspect source tables, joins, filters, projections, CTEs, and downstream result flow. The visualization is derived from parsed SQL; dynamic SQL and malformed statements can produce an incomplete graph. Use it for orientation and review, then inspect actual plans with `EXPLAIN` where the dialect supports it.

## File Search

Open **File Search** in the JustyBase explorer to search SQL/workspace files and quickly locate a query, table reference, or saved workflow. Search results open the file at the matching range. Keep project-level searches narrow for large generated directories and exclude secret/config directories through the normal VS Code workspace settings.

File Search is local and does not query a database. It complements Schema Search: use File Search for source files and Schema Search for catalog objects and database source code.

## Reliable investigation

1. Use File Search to find every local reference to a table or procedure.
2. Use Query Flow on the candidate statement to understand scope.
3. Use Schema Search to inspect the live object definition and dependencies.
4. Compare the local SQL and live DDL before changing either.
