# SQL completion manual verification

This checklist covers the current cache-backed LSP completion path and window-function snippets.

## Prepare the editor

1. Connect to a database and refresh its schema metadata, including columns. Completion reads cached metadata; it does not fetch catalog rows while you type.
2. Open a SQL document on that connection and confirm ordinary `SELECT`, `INSERT`, table, column, CTE, and alias suggestions with `Ctrl+Space`.
3. For Netezza, ensure the cache contains the relevant tables and their key metadata. Type `JOIN ` after a table source. A cached related-table suggestion should include a unique alias and an `ON` predicate when cached key columns match. Type `ON ` after an existing join to see suggested equality predicates.
4. Repeat with two source tables that have similarly named keys. Confirm aliases remain unique and the generated table path retains the database/schema qualification required by the active connection.
5. Restart VS Code, reconnect, and repeat the checks. Persisted metadata should repopulate completion without a live catalog query during typing.

## Window function snippets

In a `SELECT` expression, invoke completion for `ROW_NUMBER`, `RANK`, or `LAG` and accept the item. The insertion should contain one `OVER (...)`; the cursor should stop inside its parentheses. For `LAG`, argument tab stops precede the `OVER` tab stop. Also accept the normal and window variants of `SUM` and `COUNT`; the normal variant remains a plain aggregate and the window variant inserts `OVER (...)`.

Check acceptance when text follows the cursor and when the identifier is already complete. Completion should replace only the typed prefix and must not append a second `OVER` clause.

## Automated checks

```bash
npm run test -- --runInBand --testPathPatterns="completionRenderer|completionEngine|completionJoinConditions"
npm run benchmark:lsp
```

Database-backed completion checks use the matching configured integration suite, for example `npm run test:netezza:integration`, `npm run test:db2:integration`, `npm run test:mssql:integration`, `npm run test:mysql:integration`, `npm run test:oracle:integration`, `npm run test:postgres:integration`, and `npm run test:vertica:integration`. They need valid environment configuration and privileges. Create only uniquely named disposable PK/FK fixtures in a scratch schema, drop them in `finally`, and verify cleanup if the process is interrupted; do not use existing tables or insert customer data.
