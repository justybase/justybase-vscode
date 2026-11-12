---
title: Schema Browser, DDL and metadata cache
description: Navigate databases, schemas, objects, columns, definitions, favorites, and refresh boundaries without losing catalog context.
audience: user
category: Product guides
status: Supported
last_verified: 2026-11-10
product_version: 3.20.5
---

# Schema Browser, DDL and metadata cache

The Schema view is a lazy tree: connection → database → schema → object group → object → columns. It does not eagerly fetch every column in a warehouse.

## Everyday workflow

<figure class="figure-wide">
  <img src="screenshots/schema-browser-tree.png" alt="Schema Browser tree with connection, database, schema, and table columns">
  <figcaption>The Schema view is a lazy tree: connection → database → schema → object group → object → columns.</figcaption>
</figure>

1. Connect and expand the database you need.
2. Expand a schema and choose Tables, Views, Procedures, External Tables, or another object group.
3. Expand an object for columns and type/nullability metadata.
4. Use context actions or inline actions to copy a qualified name, generate DDL, open object details, view/edit data, add a comment, compare schema, or add the object to favorites.
5. Use **Filter Visible Objects** in the Schema view toolbar to narrow already loaded object lists by name. This is local and does not run Schema Search; use the clear action to restore the full lists.
6. Use **Refresh Selected Metadata** after a targeted DDL change. Use **Refresh Schema** after a broad migration or catalog refresh.

## Object context menu

Right-clicking a table, view, procedure or other object opens the same menu layout for every database; an entry the connected dialect does not support is hidden, and so is a submenu with nothing in it.

| Position | Entries |
| --- | --- |
| Top | Object Details, Select Top 1000, Edit Data, Count Rows, Call Routine, Refresh Materialized View |
| Copy | Copy Name, Create DDL Code |
| **Data ▸** | Export Table Data, Migration Studio, Search Values, Find Duplicate Rows, Create Table From This, Create Table Like (Structure Only), Create View in Another Database, Generate Test Data |
| **Structure ▸** | Object Designer, columns, keys and constraints, indexes and partitions (Db2, PostgreSQL and MySQL add their designers here) |
| **Maintenance ▸** | Show Maintenance Status, statistics, space reclaim (Groom / Vacuum / Reorganize (REORG) / Optimize / Move — named after what the database runs), reindex, storage, data skew, Recreate Table |
| **Analysis ▸** | Compare With, Show Dependencies, Show Used By, Impact Analysis, Show Size & Row Count, Show Privileges |
| Admin | Grant, Change Owner, Rename, Comment |
| Favorites | Add to / remove from favorites, Edit Note… (a local note, also on columns — see [object notes](guide/user/history-favorites/#object-notes)) |
| Last | Truncate, Drop, Drop Constraint |

Destructive actions always sit in the last group, separated from everyday entries. A database node also offers **Lock waits** and **Invalid objects** where the dialect provides them. The per-dialect list is in the [database support matrix](guide/reference/database-support/).

## Object details

Object rows expose inline actions for refresh, copying the metadata comment, favorite, and **Object Details** (the magnifier). The magnifier opens the object panel on the **Structure** tab, showing the header with `database.schema.object` and the connection name.

- **Tables** keep the editable Data toolbar, Structure editor (comments, add/drop column), and DDL tabs.
- **Views** open read-only: data, columns, and comments can be inspected, but inline comment editing and column mutations are hidden.
- **Procedures** open on Structure with definition properties and positional argument types instead of columns, and expose only Structure and DDL tabs. DDL uses the procedure signature, so overloads open the correct definition.

The Structure tab is cache-first: columns (with key badges, nullability, defaults and comments) and the cached table comment render immediately, and a catalog refresh updates the tab in the background. The Data tab is loaded the first time it is activated, so opening Object Details does not run the row query.

Editing remains available from the regular **View/Edit Data** command for tables.

## DDL and navigation

**Create DDL Code** generates a reviewable `CREATE` statement for supported objects. **Go to Table DDL** opens the definition for a catalog object. DDL is generated through the selected dialect provider, so identifier quoting, procedure syntax, and external-table clauses vary by database kind.

Qualified names remain intact: `DB.SCHEMA.TABLE` identifies a three-part object, while `DB..TABLE` intentionally leaves the schema slot empty for Netezza notation. Quoted identifiers are not uppercased or normalized away.

## Cache behavior

The cache is cache-first, TTL-aware, and layered. Table-like objects (tables, views, nicknames, aliases) share refresh state; a refresh merges current objects instead of replacing unrelated cached entries. When a connection snapshot expires, its in-memory and persisted metadata are discarded before rebuilding, so stale tables cannot seed the new snapshot. Column loading is separate and can be warmed for completion. Disk persistence and cross-window synchronization are enabled by default.

Metadata warm-up is scoped to databases rather than the whole connection:

- VS Code warms the **active database** (the SQL editor's database override, or the profile database) and the **most used databases** from query history.
- `justybase.metadata.popularDatabases` (0–5, default `2`) controls how many recently used databases are warmed. Set it to `0` to warm only the active database.
- Every other database stays lazy: the first expansion, `DB..` reference, or explicit refresh builds that database's snapshot.
- **Refresh Selected Metadata** on a database rebuilds the full scope for that database only, including view definitions and procedure sources.
- Empty databases and schemas are remembered as empty, so reopening them does not repeat catalog queries.
- Table nodes show the optimizer's estimated row count from `_V_TABLE.RELTUPLES`, prefixed with `~`. It is an estimate, not an exact `COUNT(*)`, and it follows the same TTL, invalidation and disk-persistence policy as other table metadata.

`justybase.metadata.liveFallback` controls whether a cache miss may query the server:

| Value | Behavior |
| --- | --- |
| `never` | Reads only the local shadow cache; a missing scope starts a background database snapshot and shows a placeholder. |
| `onDemand` (default) | Completion is cache-only; expanding the schema tree, Edit Data, DDL sync, and explicit refresh may query live. |
| `always` | Any cache miss may query live (legacy behavior). |

DDL keeps the cache coherent without one query per statement: `COMMENT ON` patches cached comments with zero catalog SQL, the first `ALTER TABLE` refreshes the object, and repeated changes are coalesced into a single trailing refresh. A rollback discards pending changes.

| Action | Scope | Cost |
| --- | --- | --- |
| Expand a node | The selected child level | Low and lazy |
| Refresh selected metadata | Selected database/schema/object | Targeted catalog query |
| Refresh schema | Connection/database catalog | Broad; use after migrations |
| Clear autocomplete cache | Completion cache | Does not delete database objects |

## Schema Refresh Details

For a Netezza connection, open **JustyBase: Show Schema Refresh Details** from the Command Palette or click the metadata-refresh status item. The command is `netezza.showMetadataRefreshDetails`. The panel is a read-only diagnostic view: it displays catalog SQL generated by the extension and never accepts or executes SQL supplied by the webview.

The panel shows one card per Netezza connection involved in metadata loading, and each card follows the metadata work for that connection: automatic warm-up of the active and popular databases, a scoped database refresh, or a connection-wide refresh. It can show database discovery, schemas and type groups, table/view and external-table catalogs, procedures, columns, and external-table columns. The database, schema, object and procedure stages use one shared query runner. The column stage can use the configured `justybase.metadata.fullRefreshColumnConnections` pool (1 by default, up to 8) for independent databases while keeping each database's catalog scans serial. A statement can remain **Planned** when its cache layer is already valid or when there is no external table to inspect; planned work may then become **Skipped**. This is the broad refresh path used after **Refresh Schema**, not a replacement for ordinary lazy expansion.

Each catalog statement has one of these states: **Planned**, **Queued**, **Running**, **Completed**, **Failed**, or **Skipped**. **Connection** narrows the view to a single connection card (default **All connections**), which is how you reach the card of a second Netezza connection when several are configured in the schema tree. The filters also include **Timeout** (an error message containing a timeout) and **Slow** (more than five seconds). Sort by execution time, most-recent start time, or queue wait. The panel reports rows and accumulated time for table/view and external-object queries, the corresponding totals for column queries, total refresh elapsed time, and the longest individual SQL statement. Elapsed time stops at the terminal refresh event; the longest-SQL value remains the maximum even after shorter statements finish.

Each connection card has **Repeat full metadata refresh**. It clears that connection's in-memory metadata and starts the complete Netezza prefetch through `netezza.refreshSchema`; use it when a broad retry is more useful than a targeted refresh. **Refresh Selected Metadata**, database/type-group refreshes, and object refreshes are selective operations. They normally update only the selected catalog layer and are not the same full-refresh lifecycle shown here.

After all catalog queries succeed, the refresh verifies objects that did not return columns once per affected database. Objects that disappeared during the refresh are removed; surviving or unconfirmed objects receive an explicit empty column layer. Such a snapshot is **complete with warnings**, is cached normally, and cannot cause editor keystrokes to repeat the full refresh. A genuinely incomplete snapshot means that a required catalog query failed or timed out.

Automatic full-refresh failures use a connection-scoped circuit breaker: one retry is allowed after five minutes, then automatic retries stop for the current session. **Refresh Schema** remains available as an explicit retry and resets the circuit.

Details are retained only for the latest refresh per connection in the current VS Code extension-host session/window. A connection whose full prefetch never ran because its cached metadata is still fresh still gets a card, marked **Skipped** with the reason, so every connection in the schema tree is represented. Cards are not a historical audit log and are not persisted as part of the disk metadata cache. The disk cache may synchronize between windows, but the live diagnostics panel does not. Full-refresh diagnostics are implemented for Netezza; companion database providers have their own metadata and refresh boundaries.

## When a table is missing

- Verify the selected database and schema.
- Check database privileges and whether the object is a synonym/external table rather than a regular table.
- Refresh the selected metadata, then the full schema if necessary.
- Search by object or column name with [Schema Search](guide/user/schema-search/). The quick tree filter is intended only for narrowing the objects currently shown in expanded groups.
- Check the Output panel for catalog query errors and cache statistics.

## Favorites and recent objects

Favorites preserve a route to objects, SQL snippets, folders, notes, and optional Copilot context. Recent objects are a convenience index and can disappear when their source connection is removed. See [History and Favorites](guide/user/history-favorites/) for the workspace file and note policy.
