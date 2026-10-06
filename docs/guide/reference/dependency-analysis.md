---
title: Dependencies and impact analysis
description: Inspect Netezza object references and bounded change impact using catalog definitions and the SQL parser.
audience: reference
category: Reference
status: Supported
last_verified: 2026-10-04
product_version: 3.18.6
---

# Dependencies and impact analysis

In Schema Browser, right-click a Netezza table, view, procedure or external table:

- **Show Dependencies** shows objects referenced by that object.
- **Show Used By** shows objects referencing it.
- **Impact Analysis** prompts for the proposed change kind (drop object, drop
  column, rename column, change column type, rename object) with a classified
  free-text fallback, and shows direct and indirect objects to review. It does
  not apply the change.

On a column, **Find Column References** filters the first hop to references to
that column, including uncertain wildcard references. **Impact Analysis** on a
column keeps every dependent but derives severity from the proposed change:
references to the affected column are high, wildcard exposure is medium, and
object-only references are low. Removing or renaming the whole object is high
for direct references. A free-text description that cannot be classified falls
back to the conservative drop interpretation.

The panel has a list and a graph. Arrows point **from the referencing object to
its dependency**. Colors distinguish tables, views and procedures. Click a node
or list item to use the existing object DDL action. Drag the graph to pan; use
its wheel to zoom. Depth defaults to two hops; choose 1, 2, 3 or All. All remains
bounded to 100 hops, 300 objects and 3,000 evidence edges (edges are unique
object-to-object relations; multiple columns on one relation are evidence on a
single edge). Cycles terminate.

High means a direct parsed or catalog dependency, medium an indirect dependency,
and low a probable reference, such as a wildcard or literal dynamic SQL.
These indicate objects to review, not proof that every proposed change breaks them.

## Identity and scoping

Object identity includes an identity namespace: **relation** (table, view,
external table), **routine** (procedure) and **sequence**. A procedure and a
table with the same name in one schema remain separate nodes, so
`PUBLIC.X` as a routine never merges with `PUBLIC.X` as a relation. Parser
references that do not carry a catalog type resolve to the relation namespace
first, then the routine namespace, against the loaded snapshot.

A bare `SELECT *` contributes wildcard exposure only for the relation set of
its own `SELECT` scope, resolved from that query's FROM clause; it does not mark
every object in the statement. A qualified `alias.*` contributes only for the
aliased relation. Sibling subqueries and `EXISTS` scopes therefore keep their
own wildcard exposure.

Only exact `column = column` comparisons count as equality joins. An operand
must be a single column reference with no literals, arithmetic, casts or
function calls, so `A.X + B.Y = 100` is not treated as `A.X = B.Y`.

## Coverage and limitations

Analysis loads view definitions and procedure bodies in bulk from the selected
object's database. It uses the existing Netezza Chevrotain parser and semantic
alias/CTE scopes. Qualified names, aliases, joins, nested queries, views referencing
views and CALL statements are supported. CTEs are excluded as physical objects.
Foreign-key relationships contribute table and referenced-column edges. Analysis
reuses the shared cache, loading the existing bulk catalog query when necessary;
they describe declared constraints, including Netezza's informational constraints.
External tables can be referenced as relations, but external-file dependencies
are not inferred. Sequence and function dependencies are not resolved.

Column references can be resolved through aliases and a single unambiguous
source. Complex projection lineage, ambiguous unqualified columns, USING joins,
procedure variables and overloaded CALL signatures remain partial. Overloaded
routine bodies are aggregated under their routine name. No signature-specific
impact guarantee is made.

Quoted names preserve case. References such as `DATABASE..TABLE` retain an
unknown schema rather than silently assuming the selected object's schema.

Literal dynamic SQL is parsed where possible and marked probable. Constructed
SQL is reported as unknown coverage. Parse errors, unavailable definitions,
permissions and catalog limits appear in **Coverage and limitations**. Empty
results do not establish absence of dependencies.

Incoming references from **other databases** and local SQL files are not scanned.
Cross-database outgoing references retain their qualified target identity, but
transitive definitions outside the loaded database remain unavailable.

Definitions are owned by the existing MetadataCache, expire after five minutes,
and are invalidated by metadata refresh/change events. Derived indexes reuse
unchanged definitions by hash and retain edges rather than ASTs. Up to four
catalog slices are retained; each bulk catalog is bounded to 20,000 rows per type
and 32 MB of SQL. Refresh the schema after external DDL changes, then refresh the
report. Nothing is persisted for automatic analysis after restart.
