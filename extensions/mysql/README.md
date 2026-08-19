# JustyBase SQL Editor for MySQL

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the MySQL capability matrix and shared SQL workflows.

![JustyBase SQL Editor for MySQL](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**A practical MySQL workspace for connections, SQL authoring, schema browsing, and result analysis in VS Code.**

This companion extension adds MySQL runtime support to [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza is not required.

[![Marketplace](https://vsmarketplacebadges.dev/version/krzysztof-d.justybaselite-mysql.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=krzysztof-d.justybaselite-mysql)

## MySQL in the JustyBase workspace

![MySQL schema browser, SQL editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Connect to a MySQL database, browse schemas and objects, write queries, and review results without leaving VS Code.

## Features

- MySQL connection profile through the shared JustyBase login panel.
- `mysql2` runtime with streaming results and query cancellation.
- Metadata for databases, schemas, tables, views, procedures, functions, and columns.
- MySQL 8 authoring profile with a strict parser, completion, signatures, types, grammar, snippets, and dialect builtins.
- Syntax coverage for backtick identifiers, qualified names, CTEs, MySQL `LIMIT` forms, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`, and MySQL-specific types.
- DDL generation for tables and supported object types.

### Author and validate SQL

![MySQL SQL validation and assisted correction](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/sql-validation-and-copilot.png)

Use metadata-aware completion and parser diagnostics while writing. Copilot workflows can explain, rewrite, or optimize a query before you execute it.

### Analyze results

![MySQL result explorer](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Filter and sort rows, inspect profiles and distinct values, export data, or visualize a result set.

![MySQL query result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

## Quick start

1. Install **JustyBase SQL Editor (MySQL)**.
2. Open the **JustyBase** view and choose **Connect**.
3. Select **MySQL**, enter host, port, database, user, and password.
4. Open a `.sql` file and run the current statement or selection with `Ctrl+Enter` / `F5`.

Connection secrets are kept in VS Code Secret Storage. Use separate saved profiles when working with multiple databases.

## Runtime notes

The connection form supplies authentication and connection options. Large results stream through `mysql2`; cancelling a query aborts the active request. The optional pack focuses on MySQL SQL, metadata, execution, and shared result workflows.

## Development

```bash
cd extensions/mysql
npm install
npm run check-types
npm run build
```

Keep the external `mysql` / `mysql2` runtime dependency available when running a development or packaged extension.

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
