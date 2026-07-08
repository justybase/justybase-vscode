# JustyBase Oracle Support

Optional Oracle Support for JustyBase Core.

This extension adds the `Oracle` dialect to the JustyBase Core extension and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `JustyBase Core`
- VS Code Desktop
- Oracle Database 12.1 or later
- Network access to your Oracle service

## Runtime Model

`JustyBase Oracle Support` uses `node-oracledb` in **thin mode** by default:

- No Oracle Client installation is required for the baseline runtime path
- Standard Easy Connect strings (`host:port/service`) work out of the box
- Optional Oracle Net configuration directories can be supplied from the connection form when TNS aliases or wallet files are needed

## What This Extension Adds

- Oracle connection type in the shared JustyBase connection UI
- Oracle runtime integration via `node-oracledb`
- Metadata queries for schemas, tables, views, standalone procedures, functions, packages, triggers, sequences, and synonyms
- Oracle column lookup based on `ALL_TAB_COLUMNS`, `ALL_COL_COMMENTS`, `ALL_CONSTRAINTS`, and `ALL_CONS_COLUMNS`
- Best-effort Oracle SQL authoring profile
- Optional DDL extraction powered by `DBMS_METADATA.GET_DDL`, with `ALL_SOURCE` and catalog-based fallbacks for unsupported cases

## Current Runtime Notes

- The `database` field represents the Oracle service name by default.
- An optional **Connect String Override** can be used for full Easy Connect Plus strings or TNS aliases.
- `SELECT CURRENT_CATALOG`, `SELECT CURRENT_SCHEMA`, `SELECT CURRENT_SID`, and `SET CATALOG ...` are emulated for shared core compatibility. `SET CATALOG` does not create a new Oracle service connection; it only updates the compatibility state used by the JustyBase runtime.
- Schema browsing focuses on object discovery and metadata lookup. Unsupported areas stay intentionally conservative.
- Procedure discovery currently targets standalone procedures. Standalone functions, packages, triggers, sequences, and synonyms are available through object groups in the schema browser.

## Unsupported or Intentionally Deferred

- Oracle-specific static parser assets, grammar files, and snippets are not bundled in this package
- Explain graph, tuning advisor, session monitor, and external table workflows are not exposed
- Cross-service catalog switching is not supported through `SET CATALOG`

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `JustyBase Core`
2. Install `JustyBase Oracle Support`

`JustyBase Oracle Support` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

From `extensions\oracle`:

```powershell
npm install
npm run check-types
npm run build
```

The extension bundle externalizes `oracledb`, so the package must keep `node_modules\oracledb` available at runtime.
