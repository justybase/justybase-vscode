# JustyBase SQL Editor for Microsoft Access

Read the [JustyBase documentation portal](https://justybase.github.io/justybase-vscode/guide/), including the [Access capability matrix](https://justybase.github.io/justybase-vscode/guide/reference/database-support/) and [Data Workspace guide](https://justybase.github.io/justybase-vscode/guide/user/data-workspace/).

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
- Supported native DDL: `CREATE TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`, `CREATE VIEW`, `DROP VIEW`, `ALTER TABLE ADD/DROP CONSTRAINT`, and `TRUNCATE TABLE`.
- Browse table keys and indexes in the schema tree.
- Preserve required values and index uniqueness while writing; updated files are installed atomically.
- No Java runtime, JAR, ODBC driver, Maven build, or Access installation is needed.

### Explore data visually

![Access data in the result explorer](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-explorer.png)

Profile columns, check nulls and distinct values, filter and sort rows, export to common formats, or turn a result into a chart.

![Interactive result chart](https://raw.githubusercontent.com/justybase/justybase-vscode/master/docs/screenshots/results-chart.png)

### Completion and saved queries

Access connections use the shared SQL editor, completion, result grid, filtering, profiling, and export tools. Saved non-parameterized `SELECT` QueryDefs appear as views; other query types remain read-only metadata.

## Open an Access file

1. Install **JustyBase SQL Editor (Microsoft Access)**.
2. Open **Connect to Database** from the JustyBase view.
3. Choose **Microsoft Access**, select an `.mdb` or `.accdb`, and optionally enter its password.
4. Keep **Open database as read-only** enabled for inspection. Disable it only for the supported write/DDL subset.
5. Save and connect, or right-click the file in Explorer and choose **Save Access File as Connection**.

The optional password is stored in VS Code Secret Storage. The source file is not uploaded or copied into the repository.

## Locks and recovery

Writable connections create the same lock file Microsoft Access uses (`.ldb` for
MDB, `.laccdb` for ACCDB) and hold it open while the connection is active. The
companion also writes `<database>.justybase-lock.json` next to the file with the
owning process ID, host, and start time.

- A lock left by a crashed JustyBase process on the same machine is reclaimed on
  the next writable connect.
- A lock held by Microsoft Access, another machine, or an unknown process is
  never removed automatically. When no Access window is open, run
  **JustyBase Access: Clear Stale Lock File** from the Command Palette or the
  Explorer context menu of the `.mdb`/`.accdb` file. The command refuses to
  remove a lock that the operating system still reports as open.
- If a staged write cannot be installed or restored, the error names the
  preserved `.bak` file. Move it back into place after closing the process that
  holds the database.
- Password-protected files remain read-only, and the error explains why.

## Important boundaries

- Parameterized, crosstab/PIVOT, action, pass-through, and Access-only saved queries remain read-only metadata.
- Jet 3 row writes are supported; Jet 3 DDL is not (the DDL engine targets Jet 4/ACE layouts).
- Password-protected files are read-only in this release: the reader decrypts pages in memory, but the staged writer mutates raw pages, so writes to encrypted files are refused to protect the database.
- Schema changes do not cover `ALTER TABLE ADD/DROP COLUMN`, `CREATE TABLE AS SELECT`, calculated fields, or complex/multivalue column writes.
- `TRUNCATE TABLE` deletes every row but does not reset an AutoNumber seed.
- Multi-file source editing is not part of Access support; export query results when you need a separate file.

## Runtime and development

The platform-specific VSIX includes the locked native DuckDB runtime for Windows x64, Linux x64, or macOS arm64. No Java bridge is packaged.

```bash
npm run install:access
npm run check-types:access
npm run build:access
npm run test:access:read-parity  # all fixtures compared with Jackcess (JDK 11+)
```

The read-parity gate compares every shipped fixture table, column, index and
cell value with [Jackcess](https://jackcess.sourceforge.io/), while
`scripts/access-java-crosscheck.cjs` verifies that Jackcess can read a file
written by the TypeScript writer. On Windows with Microsoft Access installed,
`npm run test:access:com` and `npm run test:access:sql` additionally compare
metadata, writes and query semantics with DAO (set `ACCESS_COM_VALIDATE=1`).
Written files can also be cross-checked with the optional readers in
`tools/access-ddl-compare` and `tools/access-java-verify`.

## License

Apache-2.0. The Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
