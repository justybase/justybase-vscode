---
title: SQL completion: scope, settings, and verification
description: Understand SQL completion behavior, configure JOIN relationships, and verify cache-backed suggestions.
audience: user
category: Product guides
status: Supported
last_verified: 2026-11-11
product_version: 3.20.3
---

# SQL completion: scope, settings, and verification

The JustyBase SQL editor provides SQL completion through the language server. The server combines the active dialect's keyword and function catalog with parser-derived statement scope, local definitions, and database metadata. The editor can complete table and column names without asking the live database catalog while you type.

## What completion covers

### SQL structure and identifiers

- Dialect-aware keywords, built-in functions, types, and special values.
- Object targets after statements such as `SELECT ... FROM`, `INSERT INTO`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `CALL`, `EXEC`, and `EXECUTE` where the active dialect provides the corresponding path.
- Database, schema, and table paths, including Netezza `DATABASE..TABLE` paths and dialect-specific two- or three-part names.
- Tables, views, and other relation-like sources provided by the active dialect.
- Table and view suggestions include the cached catalog row estimate in the detail line, for example `Table (ADMIN) · ~18,484 rows`. The `~` marks a `reltuples` optimizer estimate, not an exact `COUNT(*)`. Objects without a cached estimate show only their type.
- Columns for a table or view, qualified columns after `alias.`, and partial qualified names such as `alias.CUST`.
- Table aliases and projected names resolved from the current statement, visible CTEs, nested queries, local definitions, and local or temporary tables tracked by the editor.
- `SELECT` and `INSERT` context suggestions, wildcard expansion, and scope-aware filtering. The parser keeps nested query scopes separate and only exposes CTEs that are visible at the cursor.
- Identifier matching by direct prefix, compact spelling, `snake_case`/`camelCase` word starts, delimited initials, and multi-character name fragments. Direct matches rank first; fuzzy matches are lower in the list. One-character fragments do not create broad substring matches.

### Position-aware suggestions

Completion follows the cursor position, so the list only contains items that can be typed there:

- After a completed operand, such as `WHERE D.QTY > 0 |`, `SELECT COL |`, or `ORDER BY COL |`, the list contains only operators and clause keywords. Examples are `AND`/`OR`, `GROUP`, `ORDER`, `HAVING`, `LIMIT`, `OFFSET`, `UNION`, `ASC`/`DESC`, `NULLS`, `OVER`, and `THEN` inside an open `CASE`. It contains no columns or functions. Columns and functions return where an operand is expected, for example after `WHERE`, `AND`, a comparison operator, `(`, or `,`.
- A word typed where an alias belongs, such as `FROM DIMDATE D|`, `SELECT COL X|`, or `AS |`, opens no list unless a clause keyword matches it, for example `W` → `WHERE`.
- Dialect snippets (Netezza `nz…`, `duckdb-…`, `sqlite-…`, and others) come from the language server. They are offered only for the active dialect and only where a new statement can start: the beginning of the document, after `;`, or at the start of a procedure block. Each snippet is listed once. Alternative prefixes, such as `DROP TABLE` for `nzdroptable`, still find the snippet.

Workspace snippets in `.vscode/justybase.code-snippets` are ordinary VS Code snippets. They are not filtered by position.

### Whole-phrase suggestions

- `GROUP BY |` puts all non-aggregated `SELECT` expressions first as a single item, without their output aliases. For example, `SELECT D.YEAR, UPPER(D.MONTH) M, COUNT(*) …` offers `D.YEAR, UPPER(D.MONTH)`. The item appears only when the `SELECT` list contains an aggregate.
- `ORDER BY |` also offers the output aliases of the `SELECT` list.
- `INSERT INTO T |` offers `(c1, c2, …) VALUES (…)`. Accepting it inserts the column list and one tab stop per value. Typing `V` after the table name still finds this item.
- `INSERT INTO T (|` offers all columns at once. Columns already in the list are not offered again.
- `INSERT INTO T (a, b) VALUES (|` offers one tab stop per listed column.
- At the start of a statement, the list contains only keywords that can open a statement. For example, `SE|` offers `SELECT` and `SET` but not `OFFSET` or `CASE`.
- `justybase.sql.completionKeywordCase` sets the case of inserted keywords: `upper` (default), `lower`, or `matchTyped`. With `matchTyped`, typing `sel` inserts `select`. The list always shows keywords in upper case.

### Expand `*` to a column list

Put the cursor on the `*` of a `SELECT` item and open the light bulb (`Ctrl+.`). Choose **Expand * to column list**. When the NZ001 diagnostic is reported, its quick fix **Expand SELECT * to explicit columns** does the same thing. Every column is qualified. A table without an alias gets a generated one, using the same rules as JOIN completion (`DIMDATE` → `D`; collisions become `D2`, and so on). An existing alias is reused. If the statement already refers to `TABLE.column`, the table name is kept as the qualifier and no alias is added. `X.*` expands only that source.

```sql
SELECT * FROM DIMDATE
-- becomes
SELECT 
    D.DATEKEY
    , D.FULLDATEALTERNATEKEY
    , …
 FROM DIMDATE D
```

`justybase.sql.expandStarLayout` selects the layout: `leadingComma` (default, as above), `trailingComma`, or `singleLine`. Columns come from the metadata cache. The action is not offered while the columns of any source are still unknown.

Quoted CTE names remain limited by the SQL grammar. Other quoted table, schema, alias, and column identifiers are supported where the active dialect parser accepts them.

### JOIN completion

Type `JOIN ` after a table source to see related-table suggestions. A suggestion can insert a dialect-qualified table path, a unique alias, and an `ON` predicate. Type `ON ` at an empty condition to see available predicates for the tables already in the statement.

The relation sources are ranked as follows:

1. Workspace `justybase.sql.joinRelations` entries. These are exact, explicit mappings, support composite keys and different column names, and work for dialects without catalog FK metadata (including virtual Netezza relationships).
2. User-confirmed relations created with `netezza.confirmJoinKnowledgeRelation`. Confirmation is the only way to rank an observed relation above a catalog FK; it is reversible with `netezza.revertJoinKnowledgeOverride`, and `netezza.blockJoinKnowledgeRelation` removes a relation from ranking. A block also suppresses a relation that is present in `justybase.sql.joinRelations`; `netezza.showJoinKnowledgeStatus` states this explicitly, and reverting the block restores the configured entry. These commands are an argument API in Stage 1; the manager UI arrives in Stage 3.
3. Declared catalog foreign keys, when the active dialect's metadata provider exposes them and the relationship is present in the refreshed cache. Composite constraints remain grouped together in catalog order. Exact FK targets in another cached schema are included by their endpoint identity; name/key heuristics remain limited to the source schema.
4. Optional name/key heuristics from cached columns. These compare normalized column names and cached PK/FK flags; they are suggestions, not proof of a database constraint.

Exact configured or declared pairs rank before heuristics. `joinNameHeuristics` controls only heuristic suggestions; turning it off keeps exact workspace and catalog relationships. Completion reads this data from metadata cache and does not query system catalogs while typing. Catalog FK adapters currently populate exact endpoint pairs for Netezza, Db2, MSSQL, MySQL, Oracle, PostgreSQL, and Vertica. Other dialects can use workspace relationships and any cached heuristic matches available to them.

Generated aliases are unique within the current statement. By default the editor uses a table-name initial (or initials for a multi-part name) and adds numeric suffixes for collisions. A workspace alias override takes priority. Disabling automatic aliases removes the generated alias; it does not change source aliases already present in the SQL.

### Function and window-function completion

Function items show available parameter signatures. Accepting a function inserts a snippet with argument tab stops. Window-required functions such as `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, and `LEAD` insert `OVER (...)` automatically. The cursor lands inside the `OVER` parentheses; for `LAG` and `LEAD`, argument stops come first.

Functions that support both ordinary aggregate and window use show separate items. `SUM` and `COUNT` keep their normal aggregate item and also offer a window variant such as `SUM(expression) OVER (...)`. A window item is inserted only when it is accepted. The completion edit replaces the typed prefix and preserves text to the right of the cursor. Window snippets add one `OVER` clause; signature examples are not inserted as extra clauses.

The available functions and keywords follow the active `DatabaseSqlAuthoring` profile, so dialect catalogs can differ.

### NZPLSQL procedures (Netezza)

Inside `CREATE PROCEDURE ... LANGUAGE NZPLSQL`, completion follows the
procedure's structure instead of offering every SQL keyword:

- after `RETURNS`: return types; after the type: `LANGUAGE NZPLSQL`,
  `EXECUTE AS OWNER`, `EXECUTE AS CALLER`;
- in `DECLARE`, after a variable name: types, `RECORD`, `ALIAS FOR`,
  `CONSTANT`, `VARRAY`;
- where a statement starts: first the closer of the innermost open block
  (`END IF;`, `END LOOP;`, `END;`, `ELSIF`, `ELSE`, `EXCEPTION`), then
  `IF`, `FOR`, `WHILE`, `LOOP`, `RAISE NOTICE`, `EXECUTE IMMEDIATE`, SQL
  statements and the procedure's variables;
- after `RAISE`: `NOTICE`, `EXCEPTION`, `DEBUG`; after `EXCEPTION WHEN`:
  `OTHERS`, `TRANSACTION_ABORTED` (the only handlers Netezza accepts);
- in `IF`, `WHILE`, `EXIT WHEN`, `RETURN` and after `:=`: variables,
  `NOT FOUND`, `FOUND`, `ROW_COUNT` (and `SQLERRM` in a handler), then
  functions; after `RAISE NOTICE '...',` only variables, because Netezza
  rejects expressions there;
- after `rec.`: the fields of the query that fills the record
  (`FOR rec IN SELECT ...` or `SELECT ... INTO rec`); nothing when the fields
  are unknown (`SELECT *`, `%ROWTYPE`).

Every suggestion is backed by a case that was created and called on a live
Netezza; constructs Netezza rejects (explicit cursors, named exceptions,
`RAISE ERROR`, `PERFORM`) are never offered.

## JOIN workspace settings

These examples can go in the workspace `.vscode/settings.json` or the VS Code workspace settings UI. Table identity fields are case-insensitive. Configured `database` and `schema` values act as exact identity constraints. When SQL names a table without a schema, a schema-qualified setting matches only if the active schema is known and matches; otherwise qualify the SQL source or omit `schema` from the setting when that table name is unique in the searched scope. An omitted setting component with no active context is a wildcard, so avoid it when names can collide.

```json
{
  "justybase.sql.joinNameHeuristics": true,
  "justybase.sql.autoJoinAliases": true,
  "justybase.sql.joinAliases": [
    {
      "table": { "database": "ANALYTICS", "schema": "PUBLIC", "table": "ORDERS" },
      "alias": "ord"
    }
  ],
  "justybase.sql.joinRelations": [
    {
      "left": { "database": "ANALYTICS", "schema": "PUBLIC", "table": "CUSTOMER" },
      "right": { "database": "ANALYTICS", "schema": "PUBLIC", "table": "ORDERS" },
      "columns": [
        { "left": "TENANT_KEY", "right": "TENANT_ID" },
        { "left": "CUSTOMER_KEY", "right": "CUSTOMER_ID" }
      ]
    }
  ]
}
```

The example produces both predicates, in the declared order. The relationship works in either table order. For Netezza, use the database and schema from the metadata browser; use a virtual relationship when Netezza objects have no declared FK constraint. Malformed entries and empty column pairs are ignored.

The JustyBase Settings panel (**Editor → Virtual JOIN Relationships** and **JOIN Table Alias Overrides**) shows both settings as JSON editors with an **Insert example** button. The button merges a template entry into the current value without removing existing entries, saves the result, and reports `Example already present` on a repeated click. Invalid JSON is reported and left untouched. The panel validates only the outer shape (array of objects); misspelled table or column names are ignored silently by JOIN completion, so verify names against the metadata browser.

## FROM object preferences

FROM-object personalization is a separate ranking domain. A confirmed JOIN never promotes a table in `FROM`, and a popular table never becomes JOIN evidence. Stage 1 supports explicit manual preferences only:

- `netezza.pinSqlObject` — move an object ahead of the normal `3_` buckets (sort text only; the inserted name and its qualification are unchanged).
- `netezza.boostSqlObject` — apply a band `00`–`09` inside the object's current match rank, scope and kind.
- `netezza.demoteSqlObject` — apply band `90` inside the same boundaries.
- `netezza.excludeSqlObject` — remove the object from FROM source suggestions only.
- `netezza.revertSqlObjectPreference` — undo one active preference by id.

Preferences are keyed by database + schema + name, so same-named objects in different schemas are independent. They are stored per workspace in workspace storage, like `justybase.sql.joinRelations`; a window without a workspace falls back to global storage, but two real workspaces never share decisions. Commands validate their arguments before writing: malformed or incomplete input is rejected without creating a partial record. `"justybase.sql.personalizeFromObjects": false` disables every object preference without touching JOIN ranking; set it to `true` (default) to apply them. Empty knowledge keeps the existing object order. Use `netezza.showJoinKnowledgeStatus` to review counts and whether personalization is enabled.

## Workspace SQL index (Stage 2, off by default)

Enable `"justybase.sql.joinKnowledgeIndex": true` to index workspace `.sql` files. The index is a
**lower-priority source** (`0_5_` for JOIN targets/predicates, learned `10`–`49` bands for FROM
objects). It never outranks a catalog FK, a confirmation or a configured relation.

- A JOIN is eligible only with at least two distinct files or three independent queries. Single
  observations are stored but not ranked.
- `a JOIN b ON ...` is parsed once per statement. `OR`, `USING`, non-equality predicates, subqueries,
  CTEs/derived-table targets, unqualified ON columns and DDL are skipped rather than guessed.
- Git is a **file-selection shortcut** only: `joinKnowledgeIndexGitWindowDays` defaults to `365`; `0`
  means all files. Dirty, untracked and open files are always included. Git history itself is never
  parsed as evidence.
- Indexing is incremental and resumable. A file edit re-parses only that file; delete/rename removes
  its evidence; a Git HEAD change refreshes the selection. `netezza.rebuildJoinKnowledgeIndex` clears
  the cache and rebuilds deterministically.
- No SQL text, literals or connection names are stored. The local `workspace-index.json` contains
  workspace-relative paths, hashes, identifiers and counters.

Use `netezza.rebuildJoinKnowledgeIndex` after changing the selection or to verify a clean rebuild.
`netezza.showJoinKnowledgeStatus` reports index files, eligible/below-threshold relations and objects,
skip reasons, truncation, Git mode/HEAD and the last error.

## Ranking inside a tier, column order and accepted FROM suggestions

- **Within-tier order.** Inside every JOIN tier the list is ordered by a bounded score: exact column
  pairs, same schema, broader and more recent evidence, and the query context come first. After
  `FROM A JOIN B ON … JOIN `, relations of `B` (the table written last) rank above relations of `A`,
  and a table already present in the statement moves to the end of its tier. The tier itself never
  changes, so a catalog FK still outranks any observed relation.
- **Column order.** With the index enabled, columns that workspace SQL and successful queries use
  most broadly are offered first after `alias.` and in WHERE/SELECT lists. Only the order changes;
  a typed prefix still decides first. Turn it off with `"justybase.sql.personalizeColumns": false`.
- **Accepted FROM suggestions.** Selecting a FROM table/view from the completion list is remembered
  as half-weight usage (six selections are needed before it ranks). It never pins, boosts or
  confirms anything.
- **Measure it.** `npm run benchmark:join-ranking` with `JOIN_REPLAY_DIR=/path/to/sql` replays your
  own SQL files (leave one file out) and reports Top-1/Top-3/Top-5/MRR.

## Export and import JOIN knowledge decisions

- **JustyBase: Export JOIN Knowledge Decisions…** writes confirmations, blocks, favorites, score
  adjustments and object pin/boost/demote/exclude to a JSON file. Observed evidence, history and SQL
  text are never included.
- **JustyBase: Import JOIN Knowledge Decisions…** validates the whole file first (an unknown version or
  any invalid item rejects it without changes), shows how many decisions are new or conflict with
  yours, and asks how to resolve conflicts: keep your decisions (default), prefer the imported ones,
  or choose individually.
- **JustyBase: Undo Last JOIN Knowledge Import** restores your decisions from before the import while
  keeping evidence recorded since then. It is refused after you changed a decision manually.

## Favorite a JOIN suggestion (`0_3_`, preference not confirmation)

The heart action is a persistent "show this more often" preference, **not** a claim that the JOIN is
semantically correct. It uses the same append-only relation store as confirm/block:

- run **Favorite JOIN Suggestion…** from the editor context menu (or the
  `netezza.favoriteJoinKnowledgeSuggestion` command) with the cursor on a JOIN suggestion;
- a native Quick Pick lists the current JOIN suggestions with a heart button per item;
- the favorite ranks at `0_3_` (below catalog FK, above workspace evidence);
- a block always wins; reverting the block restores the favorite;
- confirming a relation does not remove its favorite; reverting the confirmation restores the
  favorite tier;
- `netezza.favoriteJoinKnowledgeRelation` is the argument API used by tests/tools.

The completion list itself has no per-item action API in VS Code, so the heart is a Quick Pick
controller rather than a fake inline icon.

## JOIN Knowledge manager

Open the **JOIN Knowledge** view in the JustyBase activity bar. It has two tabs:

- **JOIN relations** — configured manual relations, confirmations, favorites and workspace evidence,
  with the canonical predicate, every source, the rank (`0_0_` … `0_5_`, below threshold, blocked)
  and a "why this rank?" explanation.
- **SQL objects** — FROM-object pin/boost/demote/exclude decisions and workspace usage counters.

Actions are written through the same append-only stores as the command API:

- **Confirm** → `0_1_`; **Block** → removed before tiering; **Favorite** → `0_3_`, never confirmation;
- **Pin / Move** (explicit order), **Boost** (band), **Demote**, **Exclude** for objects;
- **Revert** undoes the active decision from history; the last action also offers an inline Undo;
- **Delete observed evidence** removes only workspace contributions; manual decisions stay;
- **Add/Edit/Remove manual relation** edits `justybase.sql.joinRelations` at workspace scope behind a
  diff confirmation, with an inline Undo for the last change;
- bulk actions are limited to **Exclude** and **Delete evidence** for selected objects.

When `justybase.sql.joinKnowledgeIndex` is off, evidence actions are disabled and the banner explains
why, while manual confirm/block/favorite remain available. When
`justybase.sql.personalizeFromObjects` is off, the objects tab is read-only. Tab, filter, search and
selection are restored after hiding and reopening the view; the view does not use
`retainContextWhenHidden`.

Manual round-trip checklist: select a relation, read the explanation, confirm it, undo; block it,
request completion (it must disappear), undo; favorite it; pin an object, change its order, exclude
it, undo each; hide and reopen the view and confirm the tab/filter/selection survived. No JSON
editing is required.

## Manual verification

### Prepare metadata

1. Configure a connection in the JustyBase connection view and connect to the intended database.
2. Refresh schema metadata. For exact FK suggestions, make sure the selected tables' column metadata has been loaded. Metadata is retained in the disk cache when supported by the current connection/cache configuration.
3. Open a SQL file associated with that connection. Use `Ctrl+Space` to request completion. The LSP's cache-only completion path must not run catalog queries while you type.

### Verify ordinary completion

1. Type `SELECT * FROM ` and request completion. Expect visible tables and relation-like objects from the active database/schema.
2. Type `INSERT INTO ` and `UPDATE ` in separate statements. Expect valid object targets for the active dialect.
3. Type `SELECT u.` after `FROM USERS u`. Expect columns for `USERS`, not columns from unrelated tables.
4. Type a partial form such as `u.CUST`, `customerName`, `customer_name`, or `ai` for `ACCOUNT_ID`. Expect case-insensitive acronym matches below exact-prefix results. A one-letter fragment should not flood the list with arbitrary substring matches.
5. Add a CTE and a nested query. Expect only definitions visible at the cursor and aliases from the current query scope.
6. In schemas that require qualification, start from an unqualified table source and accept an object completion. Confirm the insertion uses the active dialect's normal database/schema path. For Netezza also check `DATABASE..TABLE` and schema-qualified paths.
7. For Netezza, create two schemas with an object of the same name. Type `SELECT * FROM DATABASE..` and expect only objects from that database's default schema (`DEFSCHEMA`); the same-named object in the other schema must not be offered under the unqualified `DATABASE..` prefix. Type `DATABASE.SCHEMA.` and expect the other schema's object. The accepted text must keep the `DATABASE..` or `DATABASE.SCHEMA.` prefix exactly as typed.

### Verify JOIN targets, aliases, and predicates

1. Type `SELECT * FROM CUSTOMER c JOIN ` and request completion. With a configured virtual relationship, expect `ORDERS`, its unique alias, and the two mapped predicates in the candidate. With catalog FK metadata, expect the exact FK columns. A matching-name heuristic may appear lower in the list.
2. Accept the candidate. Expect one table path, one alias, and one `ON` clause. Add another table that would produce the same default alias; expect a suffix such as `O2` rather than a duplicate alias.
3. Type `SELECT * FROM CUSTOMER c JOIN ORDERS o ON ` and request completion. Expect the configured/catalog composite predicate as one item with `AND` between pairs. Reverse the source/target table order and confirm the equality direction is reversed correctly.
4. Set `"justybase.sql.joinNameHeuristics": false`. Expect name/key-only matches to disappear while configured and declared FK relationships remain.
5. Set `"justybase.sql.autoJoinAliases": false`. Expect the target path and predicate with no generated target alias. Add a `joinAliases` override and confirm that alias is used when automatic aliasing is enabled.
6. For a schema-qualified dialect, verify the accepted target keeps the required schema/database qualification. For Netezza, verify default-schema targets retain the supported double-dot form where appropriate.
7. Repeat for a Netezza virtual relation, then repeat after changing a workspace relationship. The next completion request should use the new workspace setting without requiring a catalog query.
8. For a declared cross-schema FK, put the source table in one schema and its referenced table in another. Expect the exact target and FK predicate with target schema qualification; same-name/key heuristics from other schemas should not appear.

### Verify the workspace index and favorite action

1. Create two SQL files with the same JOIN (for example `USERS u JOIN ORDERS o ON u.USER_ID = o.OWNER_ID`) and a third with a different JOIN. Enable `"justybase.sql.joinKnowledgeIndex": true`, then run `netezza.rebuildJoinKnowledgeIndex`.
2. Type `SELECT * FROM USERS u JOIN ` and request completion. Expect the indexed relation at `0_5_` with detail `JOIN found in workspace SQL`.
3. Run **Favorite JOIN Suggestion…**, click the heart on that suggestion and request completion again. Expect the same relation at `0_3_` with a favorite marker.
4. Run `netezza.blockJoinKnowledgeRelation` for the relation and request completion. Expect it to disappear. Revert the block with `netezza.revertJoinKnowledgeOverride`; the favorite should return.
5. Edit one of the two files so it no longer contains the JOIN. Rebuild and confirm the `0_5_` evidence disappears; a single remaining observation must not rank.
6. Delete the file or switch Git branches and repeat. `netezza.showJoinKnowledgeStatus` must show the current file/relation/object counts, skip reasons, truncation and Git mode.
7. Disable `"justybase.sql.joinKnowledgeIndex"` and confirm the workspace tier disappears from completion without touching manual confirmations, favorites or object preferences.

### Verify executed-query learning

1. Use a Netezza connection; `"justybase.sql.learnFromExecutedQueries"` is on by default (the workspace index setting is not needed).
2. Run `SELECT * FROM USERS u JOIN ORDERS o ON u.USER_ID = o.OWNER_ID;` once. Completion for the JOIN should not yet show the relation with a `successful executions` detail (one execution is below threshold).
3. Run the same statement again on a different UTC day, or run it twice on the same day. Completion should show the relation at `0_4_` with detail `JOIN found in successful executions`.
4. Run a statement that fails, and one that you cancel. Neither should increase the count (`netezza.showJoinKnowledgeStatus` shows `recorded` and `duplicate` counters).
5. Block the relation; it must disappear even though executions remain. Revert the block; it returns.
6. Disable `"justybase.sql.learnFromExecutedQueries"`; new executions are no longer counted (`observed` stays flat in `netezza.showJoinKnowledgeStatus`). Already stored executed evidence is not removed by the switch; use the service clear action (not yet exposed in the UI) to remove it.

### Verify JOIN ghost text and history learning

1. With catalog metadata loaded, type `SELECT * FROM FACT F JOIN DIMPRODUCT P ` (trailing space). Expect grey ghost text `ON F.PRODUCTKEY = P.PRODUCTKEY`; `Tab` inserts it. With two equally likely conditions (for example role-playing date keys to `DIMDATE`) expect no ghost.
2. Type `SELECT * FROM FACT F JOIN `. Expect no ghost for catalog or workspace targets. Run a JOIN twice and repeat: it ranks first (`0_4_`) but still has no ghost. Star it (or configure it in `justybase.sql.joinRelations`) and repeat: the target appears as ghost text when it is the only one in its tier.
3. Set `"justybase.sql.joinGhostText": "afterJoinAndNewLine"`, put the cursor at the end of the `FROM FACT F` line and press `Enter`. With a confident target expect `JOIN …` as ghost text; inside a sub-query, after `WHERE`, or with `"off"` expect none.
4. With `"justybase.sql.learnFromExecutedQueries"` on (default), run **JustyBase: Learn JOINs from Query History**. Expect a cancellable progress notification, then a plain summary such as “Learned from N past queries: X JOINs and Y tables … now rank higher” with **Show What Was Learned** (opens the manager on *Executed evidence*). Run it again: “nothing new to learn from”. JOINs executed at least twice in the history now rank at `0_4_`. Counters per skip reason are in the JustyBase output log.
5. In a new workspace with an existing query history, wait ~5 s after activation: expect only a status-bar progress, then (first time ever, and only if something was learned) one notification with **Show What Was Learned** / **Turn Off**. **Turn Off** sets `learnFromExecutedQueries` to false and explains that learned data stays until cleared.
6. Run **JustyBase: Show JOIN Knowledge Status**. Expect one `Ghost text, …: N shown, M accepted (P%)` line per position (target after JOIN, ON condition, JOIN on a new line); accepting a ghost with `Tab` increases `accepted`.
8. Type `SELECT p.COLOR, SUM(f.SALESAMOUNT) FROM FACT f JOIN DIMPRODUCT p ON … GROUP BY ` (trailing space). Expect ghost text `p.COLOR`; `Tab` inserts it. Without an aggregate in the SELECT, or with `"justybase.sql.groupByGhostText": false`, expect none.
7. Type `SELECT SUM(F.` for a fact table with numeric measures. Expect non-key numeric columns (for example `SALESAMOUNT`) before keys and text columns.

### Verify function snippets and cursor behavior

1. Type `SELECT ROW_NUM` and accept `ROW_NUMBER`. Expect `ROW_NUMBER() OVER (...)` with the caret inside the parentheses.
2. Accept `LAG` and `LEAD`. Expect argument tab stops before the `OVER` tab stop.
3. Request `SUM` and `COUNT`. Confirm there is a plain aggregate item and a separate window item. Accept each variant and confirm only the window variant inserts `OVER (...)`.
4. Repeat with a partial function prefix and SQL text after the cursor, for example `SELECT ROW| + 1`. Accept `ROW_NUMBER`; expect the suffix ` + 1` to remain and exactly one `OVER` in the inserted snippet.

### Verify cache after restart

1. Refresh metadata and run the `JOIN ` and empty `ON ` checks once so columns and relation endpoint metadata are cached.
2. Close and reopen VS Code, reconnect, and repeat completion without manually forcing a new schema refresh.
3. Expect the same table, column, and exact FK suggestions from disk-backed metadata. Completion must not perform a live catalog query while typing.

## Automated checks

Focused completion and cache checks:

```bash
npm run test -- --runInBand --testPathPatterns="completionEngine.test.ts|completionRenderer.test.ts|completionJoinConditions.test.ts|joinCompletionSettings.test.ts|columnMetadataService.test.ts|metadataColumnCodec.test.ts"
npm run test:metadata-cache:integration
npm run benchmark:lsp
LSP_BENCHMARK_ENFORCE=1 npm run benchmark:lsp
```

The LSP benchmark includes ordinary and JOIN completion with 200 and 1000 cached tables, for cold and warm cache. It reports median and p95 request time, metadata reads per request, and maximum read concurrency. Completion uses the existing limits: median at most 150 ms and p95 at most 300 ms.

Live catalog completion/relationship checks:

```bash
npm run test:netezza:integration
npm run test:mssql:integration
npm run test:mysql:integration
npm run test:oracle:integration
npm run test:postgres:integration
npm run test:db2:integration
npm run test:vertica:integration
```

The suites use their dialect-specific `*_LIVE_TEST_*` variables; Netezza uses `NZ_DEV_HOST`, `NZ_DEV_PORT`, `NZ_DEV_USER`, `NZ_DEV_PASSWORD`, and `NZ_DEV_DATABASE` for the main integration gate. A configured test must connect and execute the catalog query with the test user's permissions. Missing configuration is reported as unavailable rather than treated as a passing live test.

Live fixtures use unique table names in a scratch schema, create only their own tables, avoid inserts and existing user objects, and are removed in `finally`. The FK suites create parent/child tables with PK/FK constraints. The Netezza live suite creates parent/child tables without an FK and verifies the workspace-style virtual composite mapping. For a manual Netezza check, add the `joinRelations` entry only to the test workspace and remove it afterward. If a process is interrupted, inspect and drop only the uniquely named fixture tables created by that run.
