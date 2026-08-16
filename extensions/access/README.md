# JustyBase SQL Editor (Microsoft Access)

Microsoft Access support for JustyBase SQL Editor. It lets you connect to local `.mdb` and `.accdb` files and query them with SQL. The base JustyBase SQL Editor extension is installed automatically as a technical dependency; Netezza is not required, and you do not need to install or use it.

The icon’s red Access-inspired mark and database cylinder are a small visual cue for the bridge between familiar desktop database files and SQL work in VS Code.

## Why use Access support?

Open a legacy Access database directly in VS Code, browse its tables in the familiar schema browser, and use SQL for investigation. No ODBC, Java runtime, or JAR is needed: JustyBase decodes the file in TypeScript and executes SQL against an embedded DuckDB mirror.

## Requirements

- The base extension is installed automatically as a technical dependency; no separate Netezza installation is required.
- VS Code Desktop
- Node.js runtime supplied by VS Code (the extension requires Node 22 or newer)

No ODBC driver, Java runtime, or external database server is required. The extension ships its native DuckDB runtime and uses `mdb-reader` for file decoding.

## How to connect

1. Install `JustyBase SQL Editor (Microsoft Access)`.
2. Open **Connect to Database** from the JustyBase view.
3. Choose **Microsoft Access**, select an `.mdb` or `.accdb` file, and optionally enter its database password.
4. Leave **Open database as read-only** enabled for inspection. Disable it only for the supported staged `INSERT`, `UPDATE`, and `DELETE` subset.
5. Save and connect, then open a SQL editor or use the schema browser.

You can also right-click an `.mdb` or `.accdb` file in the VS Code Explorer and choose **Save Access File as Connection**.

For a read-only first look, keep **Open database as read-only** enabled. Uncheck it only when you explicitly need `INSERT`, `UPDATE`, `DELETE`, or DDL.

## Supported workflow

- Run `SELECT` statements against the local Access file through the DuckDB mirror.
- Read non-parameterized saved `SELECT` QueryDefs as DuckDB views; their source is available to the schema search.
- Browse ordinary tables, saved-query views, columns, and table metadata in the shared schema browser.
- Use shared SQL authoring, diagnostics, results, import, and export surfaces where the Access dialect supports them.
- Access is a flat file catalog: the schema browser does not provide server-style database and schema levels.
- Query cancellation interrupts the embedded DuckDB mirror.
- Read support covers Jet 3, Jet 4, and ACE `.accdb` files through the TypeScript file boundary.
- The optional password is passed to the reader; newer encrypted/strong-encryption variants remain outside the first native support slice.
- The writer mutates the Jet 4/ACE file directly through a TypeScript port of the Jackcess page/row/usage-map/index format and installs the result atomically. It supports `INSERT`, `UPDATE`, and `DELETE` on ordinary tables, including row growth (in-page relocation), long `MEMO`/`OLE` values (LVAL pages and chains), appending rows beyond the existing data pages, and full B-tree index maintenance (primary-key, unique and plain indexes) with uniqueness and required-value enforcement.
- Native DDL is executed through the same staged engine: `CREATE TABLE` (with column types, primary keys and unique indexes), `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`, `CREATE VIEW`, and `DROP VIEW` are applied to the file and the DuckDB mirror is refreshed so the new schema is immediately queryable. Jet 3 writes remain disabled.
- Parameterized, crosstab/PIVOT, action, pass-through, and Access-only saved queries remain read-only metadata and are not mirrored as executable views.
- Written files are verified against independent readers: the `JustyBase.UCanAccessCs` C# port (`tools/access-ddl-compare`) and the Java Jackcess library (`tools/access-java-verify`), both runnable as optional cross-checks.

The saved connection uses VS Code secret storage for the optional Access password. The Access file itself is not copied into the repository or uploaded by the extension.

## Runtime and packaging notes

The end-user VSIX includes the locked native DuckDB runtime for its VS Code target
(Windows x64, Linux x64, or macOS arm64). Marketplace publishing produces one
targeted VSIX per platform, so the native addon matches the host instead of being
selected from the build machine. No Maven, JDK, or bridge build step is required.

For development from the repository root:

```bash
npm run install:access
npm run check-types:access
npm run build:access
```

## Status and boundaries

Access is a preview companion runtime, not a replacement for the Netezza-first feature set. Netezza-specific workflows such as GROOM, distribution/skew analysis, and NZPLSQL tooling do not apply to Access.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
