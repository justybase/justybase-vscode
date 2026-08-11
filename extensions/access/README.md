# JustyBase SQL Editor (Microsoft Access)

Microsoft Access support for JustyBase SQL Editor. It lets you connect to local `.mdb` and `.accdb` files and query or edit them with SQL. The base JustyBase SQL Editor extension is installed automatically as a technical dependency; Netezza is not required, and you do not need to install or use it.

The icon’s red Access-inspired mark and database cylinder are a small visual cue for the bridge between familiar desktop database files and SQL work in VS Code.

## Why use Access support?

Open a legacy Access database directly in VS Code, browse its tables in the familiar schema browser, and use SQL for investigation or controlled updates. No ODBC configuration is needed: JustyBase launches the bundled UCanAccess bridge locally.

## Requirements

- The base extension is installed automatically as a technical dependency; no separate Netezza installation is required.
- VS Code Desktop
- Java 11 or newer available as `java` on `PATH`, through `JAVA_HOME`, or configured with `justybase.access.javaPath`

No ODBC driver is required. The extension ships a prebuilt Java bridge based on [UCanAccess](https://github.com/spannm/ucanaccess) and launches it locally when an Access connection is opened.

## How to connect

1. Install `JustyBase SQL Editor (Microsoft Access)`.
2. Open **Connect to Database** from the JustyBase view.
3. Choose **Microsoft Access**, select an `.mdb` or `.accdb` file, and optionally enter its database password.
4. Leave **Open database as read-only** enabled unless the connection must write to the file. Existing profiles without this option are treated as read-only; only an explicit unchecked value enables `INSERT`, `UPDATE`, `DELETE`, or DDL.
5. Save and connect, then open a SQL editor or use the schema browser.

You can also right-click an `.mdb` or `.accdb` file in the VS Code Explorer and choose **Save Access File as Connection**.

For a read-only first look, keep **Open database as read-only** enabled. Uncheck it only when you explicitly need `INSERT`, `UPDATE`, `DELETE`, or DDL.

## Supported workflow

- Run `SELECT`, `INSERT`, `UPDATE`, and `DELETE` statements against the local Access file.
- Browse tables, saved queries/views, columns, and table metadata in the shared schema browser.
- Use shared SQL authoring, diagnostics, results, import, and export surfaces where the Access dialect supports them.
- Access is a flat file catalog: the schema browser does not provide server-style database and schema levels.
- Query cancellation is intentionally limited by the single-worker Access bridge process.
- The Java path setting is machine-scoped, accepts only an absolute `java`/`java.exe` executable path without arguments, and the bundled bridge JAR is SHA-256 verified before launch.

The saved connection uses VS Code secret storage for the optional Access password. The Access file itself is not copied into the repository or uploaded by the extension.

## Runtime and packaging notes

The end-user VSIX includes `resources/access-bridge.jar`; users do not need Maven or a JDK to use the bundled bridge. Contributors rebuilding it need JDK 11+ and Maven:

```bash
npm run build:access-jar
```

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
