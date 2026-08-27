---
title: Query History and Favorites
description: Re-run useful work, preserve parameters and notes, and curate stable schema context for repeated SQL tasks.
audience: user
category: Product guides
status: Supported
last_verified: 2026-08-19
product_version: 3.17.2
---

# Query History and Favorites

## Query History

<figure class="figure-wide">
  <img src="screenshots/query-history.png" alt="Query History with executed SQL entries and filters">
  <figcaption>Query History records SQL with connection context, status, duration, and result information.</figcaption>
</figure>

Open **Query History** in the JustyBase explorer. Each entry records the SQL, connection/database context, status, duration, and row/affected-row information available from the execution. Select an entry to open it in a new SQL tab or re-run it.

Before rerunning a statement:

1. Check the connection and database shown by the entry.
2. Review variables/parameters and replace environment-specific values.
3. Add a predicate or `LIMIT` if the original was exploratory.
4. For writes, use preview/safe execution and confirm the target.

History is a convenience record, not a secret store. Do not put passwords or tokens in SQL literals. The Web Editor stores user history on the server and exposes it through its authenticated API; its retention follows the server data directory/session policy.

## Favorites

<figure class="figure-wide">
  <img src="screenshots/favorites.png" alt="Favorites tree with folders, SQL snippets, and notes in JustyBase">
  <figcaption>Favorites keep a curated route to objects, snippets, and notes.</figcaption>
</figure>

The Schema Browser can favorite tables, views, procedures, functions, and external tables. SQL snippets and folders can also be curated with notes. A favorite can carry:

- a qualified object reference;
- a folder and display note;
- a SQL snippet or description;
- a Copilot auto-include/enabled flag;
- an explicit **include now** action for one request.

The desktop workspace file is `.vscode/netezza-favorites.json`. It contains curated context, not connection passwords. Review it before committing: teams may intentionally commit sanitized favorites, but environment-specific names and notes can still be sensitive.

## Copilot context

Automatic inclusion is bounded by `justybase.copilot.maxWorkspaceProfilesInContext`. Disable a favorite’s Copilot flag when its columns, comments, or sample notes should not leave the local workspace. The [AI guide](guide/user/ai-assistant/) explains confirmation and data boundaries.

## Export and migration

History entries can be exported or copied for review. Favorites are workspace metadata and are not a database migration. Use [Migration Studio](guide/user/migration-etl/) for data movement and [Schema Compare](guide/user/test-data-compare/) for object differences.
