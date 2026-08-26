---
title: Connections and tab context
description: Keep credentials, active database scope, and connection lifetime predictable across SQL tabs.
audience: user
category: Start here
status: Supported
last_verified: 2026-08-19
product_version: 3.16.41
---

# Connections and tab context

JustyBase has two related choices: the connection selected for a SQL tab and the optional global active connection used by commands that do not have an editor context. Making this distinction explicit prevents a query, schema action, or AI request from going to the wrong database.

## Create and test a profile

Open **JustyBase: Connect…**, select the database kind, fill in the connection form, and choose **Test** before saving. Profiles are stored by the extension; passwords go through the VS Code Secrets API. Rename profiles so production and non-production environments are immediately distinguishable.

## Select context per tab

Use **Select Connection for SQL Tab** and **Select Database for SQL Tab** when a document needs a different scope from the global connection. The tab context is shown in the SQL editor and is used by completion, diagnostics, DDL, execution, and metadata lookup. `DB.SCHEMA.TABLE`, `DB..TABLE`, `SCHEMA.TABLE`, and quoted identifiers remain distinct object forms; do not remove qualification merely to make a suggestion appear.

## Keep a connection open

The default lifecycle opens a connection when work needs it and releases it when possible. Use **Toggle Keep Connection Open (Global)** for a stable interactive session, or **Toggle Keep Connection for Tab** when only one editor needs a persistent session. Persistent sessions can consume server slots; turn the option off when a warehouse has strict session limits.

## Switching and failure behavior

- Changing a tab’s connection invalidates its metadata and language context, then repopulates it from the new connection.
- A lost connection is surfaced in the query and Output panels. Retry reuses the selected profile; it does not silently switch tabs.
- Cancellation requests the driver cancellation and stops further UI rendering. A database that cannot cancel immediately may finish server-side before the connection is reusable.
- Metadata sessions are separate from user query sessions. On Netezza, the optional metadata session sweep needs the configured privilege; user queries are never dropped by that sweep.

## Security checklist

1. Use a read-only database account for exploration and AI context.
2. Do not put passwords in `.sql`, `.vscode/netezza-favorites.json`, `.env`, or issue reports.
3. Keep MCP’s explicitly selected connection separate from the active editor connection.
4. Use a different profile for a database with write privileges and leave safe execution enabled.

## Related settings

`justybase.metadataCache.diskPersistence`, `justybase.metadataCache.crossWindowSync`, `justybase.metadata.sessionSweep.enabled`, `justybase.metadata.sessionSweep.maxAgeMinutes`, `justybase.safeExecute.enabled`, and `justybase.query.executionTimeout` are documented in the [settings reference](guide/reference/settings/).
