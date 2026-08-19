# JustyBase SQL Editor for Microsoft Access

Read the [canonical documentation portal](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) for the Access capability matrix and [Data Workspace guide](https://justybase.github.io/justybase-vscode/guide/user/data-workspace/).

![JustyBase SQL Editor for Microsoft Access](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/marketplace-hero.png)

**Open, query, inspect, and carefully edit `.mdb` and `.accdb` files directly in VS Code.**

The Access companion brings local Microsoft Access files into [JustyBase SQL Editor](../../README.md). The core extension is installed automatically; Netezza, ODBC, Java, and an external database server are not required.

<img src="https://raw.githubusercontent.com/justybase/justybase-vscode/master/extensions/access/icon.png" alt="Microsoft Access companion icon" width="96">

## A practical Access-to-SQL workflow

![JustyBase workspace with schema browser, SQL editor, and results](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/workspace-overview.png)

Select a local file, browse tables and saved queries, write SQL, and inspect the result without leaving VS Code. The reader decodes the file in TypeScript and queries an embedded DuckDB mirror.

## Highlights

- Read Jet 3, Jet 4, and ACE `.mdb` / `.accdb` files through the native TypeScript reader.
- Browse ordinary tables, columns, table metadata, and non-parameterized saved `SELECT` QueryDefs.
- Run `SELECT` queries and use the shared completion, diagnostics, result grid, filtering, profiling, and export tools.
- Optional staged editing for ordinary-table `INSERT`, `UPDATE`, and `DELETE` operations.
- Supported native DDL: `CREATE TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`, `CREATE VIEW`, and `DROP VIEW`.
- Preserve required values and index uniqueness while writing; updated files are installed atomically.
- No Java runtime, JAR, ODBC driver, Maven build, or Access installation is needed.

### Explore data visually

![Access data in the result explorer](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Profile columns, check nulls and distinct values, filter and sort rows, export to common formats, or turn a result into a chart.

![Interactive result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

### Build a query without starting from scratch

![Visual Query Builder](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/visual_query_builder.png)

Use the shared Visual Query Builder to join tables, choose columns, add filters, and open generated SQL in the editor.

## Open an Access file

1. Install **JustyBase SQL Editor (Microsoft Access)**.
2. Open **Connect to Database** from the JustyBase view.
3. Choose **Microsoft Access**, select an `.mdb` or `.accdb`, and optionally enter its password.
4. Keep **Open database as read-only** enabled for inspection. Disable it only for the supported write/DDL subset.
5. Save and connect, or right-click the file in Explorer and choose **Save Access File as Connection**.

The optional password is stored in VS Code Secret Storage. The source file is not uploaded or copied into the repository.

## Important boundaries

- Parameterized, crosstab/PIVOT, action, pass-through, and Access-only saved queries remain read-only metadata.
- Jet 3 writes are disabled; the staged writer targets Jet 4/ACE files.
- Password-protected files using newer strong-encryption variants may be outside the first native support slice.
- Multi-file source editing is not part of Access support; export query results when you need a separate file.

## Runtime and development

The platform-specific VSIX includes the locked native DuckDB runtime for Windows x64, Linux x64, or macOS arm64. No Java bridge is packaged.

```bash
npm run install:access
npm run check-types:access
npm run build:access
```

Written files can be cross-checked with the optional readers in `tools/access-ddl-compare` and `tools/access-java-verify`.

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
