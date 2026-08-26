---
title: Schema Search
description: Search object names, columns, and source code across one database or an entire connection, then jump directly to the definition.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.16.40
---

# Schema Search

Schema Search is a separate search surface from the tree. It is useful when you know a name fragment, a column but not its table, or a procedure/view source fragment but not the object that contains it.

## Search workflow

1. Open **Object Search** in the JustyBase explorer.
2. Select the connection. Search never guesses a different server from the active editor tab.
3. Enter at least two characters. Shorter input is rejected to avoid an accidental warehouse-wide scan.
4. Choose the object scope: tables, views, procedures, functions/aggregates, columns, or all supported objects.
5. Choose the database scope. `justybase.schemaSearch.searchAllDatabases` searches all accessible databases; the default searches the active/default database and is recommended for large Netezza warehouses.
6. For source searches choose **Raw**, **Objects + Source Raw**, **No Comments**, or **No Comments / Strings**.
7. Review results, open the definition/DDL, or reveal the object in Schema Browser. Use the export action to write the result list to XLSB.

## Source modes

| Mode | Searches |
| --- | --- |
| Raw | Stored source as returned by the catalog. |
| Objects + Source Raw | Object-name matches plus source-text matches. |
| No Comments | Source after comments are removed. |
| No Comments / Strings | Source after comments and string literals are removed, useful for structural SQL fragments. |

The source modes are normalization choices, not a parser guarantee. A fragment inside a dynamic SQL string may disappear in the last mode by design.

## Cache-first behavior

The first results can come from the local metadata/search index while the database query is still running. Later database-backed results may add objects not in the cache. A refresh or connection/database change invalidates the affected scope. Recent objects are shown when the search box is empty and provide a quick route back to a definition.

## Example 1: find a column

Search for `ORDER_DATE`, set scope to **Columns**, choose the reporting connection, and leave the database scope at the default. Open a result to see database, schema, table, type, and nullability, then select **Reveal in Schema Browser** or insert the qualified object name into the editor.

## Example 2: find a procedure by source

Search for `LOAD_STAGE`, select **Procedures**, and use **No Comments / Strings** with the source search enabled. When the result identifies the procedure, open its DDL and jump to the object. This finds a source reference even when the procedure name does not contain the fragment.

## Cancellation and warehouse limits

Use **Cancel Search** when the connection is slow or all-database search is broader than intended. Cancellation stops the client workflow and asks the active catalog query to stop; a database/driver may take a short time to release the server session. Search results are capped and time out rather than silently running without a boundary.

For a large warehouse:

- search the active database first;
- use a longer, distinctive pattern;
- narrow the object type before enabling all databases;
- refresh metadata once, then reuse cache-first results;
- avoid running multiple all-database source searches in parallel.

## Related actions

Schema Search can open DDL, reveal a tree object, add an object to favorites, and export the result rows to XLSB. [Schema Browser](guide/user/schema-browser/) explains refresh and DDL; [History and Favorites](guide/user/history-favorites/) explains durable workspace context.
