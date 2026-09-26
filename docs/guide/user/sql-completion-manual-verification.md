---
title: SQL completion: scope, settings, and verification
description: Understand SQL completion behavior, configure JOIN relationships, and verify cache-backed suggestions.
audience: user
category: Product guides
status: Supported
last_verified: 2026-09-26
product_version: 3.17.27
---

# SQL completion: scope, settings, and verification

The JustyBase SQL editor provides SQL completion through the language server. The server combines the active dialect's keyword and function catalog with parser-derived statement scope, local definitions, and database metadata. The editor can complete table and column names without asking the live database catalog while you type.

## What completion covers

### SQL structure and identifiers

- Dialect-aware keywords, built-in functions, types, and special values.
- Object targets after statements such as `SELECT ... FROM`, `INSERT INTO`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `CALL`, `EXEC`, and `EXECUTE` where the active dialect provides the corresponding path.
- Database, schema, and table paths, including Netezza `DATABASE..TABLE` paths and dialect-specific two- or three-part names.
- Tables, views, and other relation-like sources provided by the active dialect.
- Columns for a table or view, qualified columns after `alias.`, and partial qualified names such as `alias.CUST`.
- Table aliases and projected names resolved from the current statement, visible CTEs, nested queries, local definitions, and local or temporary tables tracked by the editor.
- `SELECT` and `INSERT` context suggestions, wildcard expansion, and scope-aware filtering. The parser keeps nested query scopes separate and only exposes CTEs that are visible at the cursor.
- Identifier matching by direct prefix, compact spelling, `snake_case`/`camelCase` word starts, delimited initials, and multi-character name fragments. Direct matches rank first; fuzzy matches are lower in the list. One-character fragments do not create broad substring matches.

Quoted CTE names remain limited by the SQL grammar. Other quoted table, schema, alias, and column identifiers are supported where the active dialect parser accepts them.

### JOIN completion

Type `JOIN ` after a table source to see related-table suggestions. A suggestion can insert a dialect-qualified table path, a unique alias, and an `ON` predicate. Type `ON ` at an empty condition to see available predicates for the tables already in the statement.

The relation sources are ranked as follows:

1. Workspace `justybase.sql.joinRelations` entries. These are exact, explicit mappings, support composite keys and different column names, and work for dialects without catalog FK metadata (including virtual Netezza relationships).
2. Declared catalog foreign keys, when the active dialect's metadata provider exposes them and the relationship is present in the refreshed cache. Composite constraints remain grouped together in catalog order. Exact FK targets in another cached schema are included by their endpoint identity; name/key heuristics remain limited to the source schema.
3. Optional name/key heuristics from cached columns. These compare normalized column names and cached PK/FK flags; they are suggestions, not proof of a database constraint.

Exact configured or declared pairs rank before heuristics. `joinNameHeuristics` controls only heuristic suggestions; turning it off keeps exact workspace and catalog relationships. Completion reads this data from metadata cache and does not query system catalogs while typing. Catalog FK adapters currently populate exact endpoint pairs for Netezza, Db2, MSSQL, MySQL, Oracle, PostgreSQL, and Vertica. Other dialects can use workspace relationships and any cached heuristic matches available to them.

Generated aliases are unique within the current statement. By default the editor uses a table-name initial (or initials for a multi-part name) and adds numeric suffixes for collisions. A workspace alias override takes priority. Disabling automatic aliases removes the generated alias; it does not change source aliases already present in the SQL.

### Function and window-function completion

Function items show available parameter signatures. Accepting a function inserts a snippet with argument tab stops. Window-required functions such as `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, and `LEAD` insert `OVER (...)` automatically. The cursor lands inside the `OVER` parentheses; for `LAG` and `LEAD`, argument stops come first.

Functions that support both ordinary aggregate and window use show separate items. `SUM` and `COUNT` keep their normal aggregate item and also offer a window variant such as `SUM(expression) OVER (...)`. A window item is inserted only when it is accepted. The completion edit replaces the typed prefix and preserves text to the right of the cursor. Window snippets add one `OVER` clause; signature examples are not inserted as extra clauses.

The available functions and keywords follow the active `DatabaseSqlAuthoring` profile, so dialect catalogs can differ.

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

### Verify JOIN targets, aliases, and predicates

1. Type `SELECT * FROM CUSTOMER c JOIN ` and request completion. With a configured virtual relationship, expect `ORDERS`, its unique alias, and the two mapped predicates in the candidate. With catalog FK metadata, expect the exact FK columns. A matching-name heuristic may appear lower in the list.
2. Accept the candidate. Expect one table path, one alias, and one `ON` clause. Add another table that would produce the same default alias; expect a suffix such as `O2` rather than a duplicate alias.
3. Type `SELECT * FROM CUSTOMER c JOIN ORDERS o ON ` and request completion. Expect the configured/catalog composite predicate as one item with `AND` between pairs. Reverse the source/target table order and confirm the equality direction is reversed correctly.
4. Set `"justybase.sql.joinNameHeuristics": false`. Expect name/key-only matches to disappear while configured and declared FK relationships remain.
5. Set `"justybase.sql.autoJoinAliases": false`. Expect the target path and predicate with no generated target alias. Add a `joinAliases` override and confirm that alias is used when automatic aliasing is enabled.
6. For a schema-qualified dialect, verify the accepted target keeps the required schema/database qualification. For Netezza, verify default-schema targets retain the supported double-dot form where appropriate.
7. Repeat for a Netezza virtual relation, then repeat after changing a workspace relationship. The next completion request should use the new workspace setting without requiring a catalog query.
8. For a declared cross-schema FK, put the source table in one schema and its referenced table in another. Expect the exact target and FK predicate with target schema qualification; same-name/key heuristics from other schemas should not appear.

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
