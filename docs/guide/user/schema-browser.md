---
title: Schema Browser, DDL and metadata cache
description: Navigate databases, schemas, objects, columns, definitions, favorites, and refresh boundaries without losing catalog context.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.16.35
---

# Schema Browser, DDL and metadata cache

The Schema view is a lazy tree: connection → database → schema → object group → object → columns. It does not eagerly fetch every column in a warehouse.

## Everyday workflow

1. Connect and expand the database you need.
2. Expand a schema and choose Tables, Views, Procedures, External Tables, or another object group.
3. Expand an object for columns and type/nullability metadata.
4. Use context actions to copy a qualified name, generate DDL, view/edit data, add a comment, compare schema, or add the object to favorites.
5. Use **Refresh Selected Metadata** after a targeted DDL change. Use **Refresh Schema** after a broad migration or catalog refresh.

## DDL and navigation

**Create DDL Code** generates a reviewable `CREATE` statement for supported objects. **Go to Table DDL** opens the definition for a catalog object. DDL is generated through the selected dialect provider, so identifier quoting, procedure syntax, and external-table clauses vary by database kind.

Qualified names remain intact: `DB.SCHEMA.TABLE` identifies a three-part object, while `DB..TABLE` intentionally leaves the schema slot empty for Netezza notation. Quoted identifiers are not uppercased or normalized away.

## Cache behavior

The cache is cache-first, TTL-aware, and layered. Table-like objects (tables, views, nicknames, aliases) share refresh state; a refresh merges current objects instead of replacing unrelated cached entries. Column loading is separate and can be warmed for completion. Disk persistence and cross-window synchronization are enabled by default.

| Action | Scope | Cost |
| --- | --- | --- |
| Expand a node | The selected child level | Low and lazy |
| Refresh selected metadata | Selected database/schema/object | Targeted catalog query |
| Refresh schema | Connection/database catalog | Broad; use after migrations |
| Clear autocomplete cache | Completion cache | Does not delete database objects |

## When a table is missing

- Verify the selected database and schema.
- Check database privileges and whether the object is a synonym/external table rather than a regular table.
- Refresh the selected metadata, then the full schema if necessary.
- Search by object or column name with [Schema Search](guide/user/schema-search/).
- Check the Output panel for catalog query errors and cache statistics.

## Favorites and recent objects

Favorites preserve a route to objects, SQL snippets, folders, notes, and optional Copilot context. Recent objects are a convenience index and can disappear when their source connection is removed. See [History and Favorites](guide/user/history-favorites/) for the workspace file and note policy.
