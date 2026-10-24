---
title: Query History and Favorites
description: Re-run useful work, preserve parameters and notes, and curate stable schema context for repeated SQL tasks.
audience: user
category: Product guides
status: Supported
last_verified: 2026-10-21
product_version: 3.19.8
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

History is a convenience record, not a secret store. Do not put passwords or tokens in SQL literals. Its retention and location follow the VS Code extension's local storage behavior.

## Search Query History (keyboard-first)

Press `Ctrl+R` (`Cmd+R` on macOS) in a SQL editor or in the **Query History** view — `Ctrl+Alt+R` / `Cmd+Alt+R` also works — or run **JustyBase: Search Query History…** from the Command Palette — for a terminal-style reverse search over query history (active entries plus archive, newest first).

- Typing filters fuzzily across SQL text, connection, database, schema, tags, and description; favorites are boosted and marked with `$(star-full)`.
- Each row shows timestamp, connection/database, and an SQL preview.
- Pressing `Enter` inserts the SQL at the cursor. It is **never executed automatically**. Macro variables (`${VAR}`/`$VAR`/`&VAR`) resolve through the standard parameter prompt; QuickRerun-style `:name`/`@name` placeholders insert verbatim.

### Ctrl+R scope

`Ctrl+R` is claimed only while a SQL editor (`sql`, `mssql`, `netezza-sql`) or the Query History view has focus. Everywhere else it keeps VS Code's native **Open Recent**. To give `Ctrl+R` back to Open Recent everywhere, add to your `keybindings.json`:

```json
{
  "key": "ctrl+r",
  "command": "-netezza.searchQueryHistory"
}
```

`Ctrl+Alt+R` keeps working either way.

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

## Object notes

Right-click any table, view, procedure or other object — or one of its columns — in the Schema Browser and choose **Edit Note…** to attach a short note, for example *"Loaded nightly by the ETL job; do not truncate"*. Clearing the text removes the note. A noted node shows 📝 in its description, and the note opens its tooltip. The same note appears on the object in Favorites.

Notes are stored only on this computer, in `object-notes.json` in the extension's global storage — never in the workspace, a favorites file, or the database. A note belongs to one connection profile, database, schema, object type and name; renaming the object in the database leaves the note behind.

- **JustyBase: Open Object Notes File** opens the file for review.
- **JustyBase: Export Object Notes…** and **JustyBase: Import Object Notes…** move notes between machines. Import merges: when both sides have a note for the same object, the more recently edited one is kept.
- Copilot's **Get Comments** tool adds the notes of the table and its columns to the database comments, marked as local user notes. Leave sensitive information out of notes if Copilot is in use.

## Copilot context

Automatic inclusion is bounded by `justybase.copilot.maxWorkspaceProfilesInContext`. Disable a favorite’s Copilot flag when its columns, comments, or sample notes should not leave the local workspace. The [AI guide](guide/user/ai-assistant/) explains confirmation and data boundaries.

## Export and migration

History entries can be exported or copied for review. Favorites are workspace metadata and are not a database migration. Use [Migration Studio](guide/user/migration-etl/) for data movement and [Schema Compare](guide/user/test-data-compare/) for object differences.
