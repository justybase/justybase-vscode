# MSSQL Tools (justybase)

Optional Microsoft SQL Server support for Netezza SQL Tools (justybase).

This extension adds the `MSSQL` dialect to Netezza SQL Tools (justybase) and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `Netezza SQL Tools (justybase)`
- VS Code Desktop
- Network access to your Microsoft SQL Server instance

## What This Extension Adds

- Microsoft SQL Server connection type in the shared login panel
- MSSQL runtime integration via the `mssql` package
- Metadata queries for databases, schemas, tables, views, procedures, functions, and column lookup
- MSSQL SQL authoring profile and dialect registration
- DDL generation for tables and supporting object types where available

## Current Runtime Notes

- SQL Server authentication and connection options are provided through the shared connection form.
- Schema browsing focuses on user databases and catalog objects that are safe to expose in the explorer.
- The optional package exposes DDL and authoring features, but other database-specific workflows remain intentionally conservative.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `Netezza SQL Tools (justybase)`
2. Install `MSSQL Tools (justybase)`

`MSSQL Tools (justybase)` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\mssql`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `mssql`, so the package must keep `node_modules\mssql` available at runtime.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
