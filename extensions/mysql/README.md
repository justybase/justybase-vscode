# JustyBase SQL Editor (MySQL)

MySQL support for JustyBase SQL Editor. The base JustyBase SQL Editor extension is installed automatically as a technical dependency; Netezza is not required, and you do not need to install or use it.

This extension adds the `MySQL` dialect to JustyBase SQL Editor and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- The base extension is installed automatically as a technical dependency; no separate Netezza installation is required.
- VS Code Desktop
- Network access to your MySQL instance

## What This Extension Adds

- MySQL connection type in the shared login panel
- MySQL runtime integration via the `mysql2` package with **streaming** result readers and cancel
- Metadata queries for databases, schemas, tables, views, procedures, functions, and column lookup
- MySQL 8 Chevrotain parser runtime (strict validation: backtick identifiers, `DATABASE.TABLE` qualification, CTEs, MySQL `LIMIT` forms, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`, MySQL-specific types) and dialect registration
- MySQL authoring assets (builtins with signatures, functions), grammar injection, and snippets
- DDL generation for tables and supporting object types where available

## Current Runtime Notes

- MySQL authentication and connection options are provided through the shared connection form.
- Schema browsing focuses on user databases and catalog objects that are safe to expose in the explorer.
- Large query results stream row-by-row via `mysql2`; `cancel()` aborts the active query.
- The optional package exposes DDL and authoring features, but other database-specific workflows remain intentionally conservative.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `JustyBase SQL Editor (MySQL)`; VS Code installs the base extension automatically.

`JustyBase SQL Editor (MySQL)` can declare `extensionDependencies` on the core extension so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\\mysql`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle may externalize `mysql`/`mysql2`, so the package should keep the runtime dependency available when running in a development or packaged environment.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
