# MySQL Tools (justybase)

Optional MySQL support for Netezza SQL Tools (justybase).

This extension adds the `MySQL` dialect to Netezza SQL Tools (justybase) and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `Netezza SQL Tools (justybase)`
- VS Code Desktop
- Network access to your MySQL instance

## What This Extension Adds

- MySQL connection type in the shared login panel
- MySQL runtime integration via the `mysql` (or `mysql2`) package
- Metadata queries for databases, schemas, tables, views, procedures, functions, and column lookup
- MySQL SQL authoring profile and dialect registration
- DDL generation for tables and supporting object types where available

## Current Runtime Notes

- MySQL authentication and connection options are provided through the shared connection form.
- Schema browsing focuses on user databases and catalog objects that are safe to expose in the explorer.
- The optional package exposes DDL and authoring features, but other database-specific workflows remain intentionally conservative.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `Netezza SQL Tools (justybase)`
2. Install `MySQL Tools (justybase)`

`MySQL Tools (justybase)` can declare `extensionDependencies` on the core extension so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\\mysql`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle may externalize `mysql`/`mysql2`, so the package should keep the runtime dependency available when running in a development or packaged environment.
