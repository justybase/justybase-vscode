# JustyBase Db2 Support


Optional Db2 Support for JustyBase Core.

This extension adds the `Db2 LUW` dialect to the JustyBase Core extension and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry.

## Requirements

- Install the core extension first: `JustyBase Core`
- VS Code Desktop
- Network access to your Db2 LUW server

## Supported Platforms

`JustyBase Db2 Support` is built and packaged per target platform:

- Windows (`win32-x64`)
- Linux (`linux-x64`)
- macOS Apple Silicon (`darwin-arm64`)

Each platform requires its own DB2 VSIX artifact because `ibm_db` and `clidriver` are native/runtime-platform specific.

## What This Extension Adds

- Db2 LUW connection type in the login panel
- Db2-aware connection factory and runtime driver integration, including a UTF-8 `ClientCodepage=1208` default that can be overridden from the connection form
- Schema metadata queries for Db2 system catalogs, including separate runtime groups for nicknames, aliases, procedures, functions, servers, server options, wrappers, wrapper options, user mappings, and passthru auth
- Db2 SQL authoring profile and dialect registration
- Db2 table DDL fallback reconstruction from catalog metadata when direct runtime DDL is unavailable, plus catalog-based DDL for aliases and nicknames

## Current Runtime Notes

- Nicknames and aliases are treated as table-like objects for tree expansion and SQL completion.
- Servers, server options, wrappers, wrapper options, user mappings, and passthru auth are exposed as read-only catalog groups in the schema browser.
- Db2 type groups are split between schema-scoped objects (`TABLE`, `VIEW`, `NICKNAME`, `ALIAS`, `PROCEDURE`, `FUNCTION`) and global federated groups (`SERVER`, `SERVER OPTION`, `WRAPPER`, `WRAPPER OPTION`, `USER MAPPING`, `PASSTHRU AUTH`).
- Db2 procedures are enabled in runtime capabilities; table maintenance and session monitor remain intentionally disabled in this iteration.
- Fallback table DDL now reconstructs constraints, check constraints, comments, secondary indexes, and key partition metadata from `SYSCAT.*`; storage/compression details that cannot be rendered as safe SQL are emitted as metadata comments in the fallback output.

## Installation Order

Marketplace or manual VSIX installation should end with both extensions installed:

1. Install `JustyBase Core`
2. Install `JustyBase Db2 Support`

`JustyBase Db2 Support` declares `extensionDependencies` on the core extension, so VS Code can resolve the dependency automatically in Marketplace scenarios.

## Development Notes

For local debugging and native runtime refresh after `ibm_db` or Electron changes:

```powershell
npm run rebuild:db2
```

Then start the debug profile:

```powershell
F5 -> Run Core + Db2 Support
```

For Linux/macOS development, runtime library loading may require unixODBC setup and `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` visibility. See `extensions/DB2_DEBUG_AND_INSTALL.md` for platform-specific diagnostics.

## Packaging

From the repository root:

```powershell
npm run package:db2:full
```

This runs clean, lint, typecheck, build, and creates the DB2 VSIX.

For CI multi-platform builds and artifact names, see `.github/workflows/db2-build.yml`. Marketplace publication of the core VSIX plus the three Db2 target VSIX files is handled separately by `.github/workflows/publish-marketplace.yml` when a GitHub Release is published.
