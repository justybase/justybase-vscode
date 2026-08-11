# JustyBase SQL Editor (Db2)

Db2 LUW support for JustyBase SQL Editor. The base JustyBase SQL Editor extension is installed automatically as a technical dependency; Netezza is not required, and you do not need to install or use it.

This extension adds the `Db2 LUW` dialect and integrates with the shared connection UI, schema browser, SQL execution flow, and dialect registry. Core ships a dedicated Db2 SQL lexer/parser (strict), grammar, snippets, dialect-aware semantic tokens, and **DB2001–DB2008** quality rules; this VSIX supplies the native `ibm_db` driver and runtime providers.

## Requirements

- The base extension is installed automatically as a technical dependency; no separate Netezza installation is required.
- VS Code Desktop
- Network access to your Db2 LUW server

## Supported Platforms

Built and packaged per target platform (native `ibm_db` / clidriver):

- Windows (`win32-x64`)
- Linux (`linux-x64`)
- macOS Apple Silicon (`darwin-arm64`)

## What This Extension Adds

- Db2 LUW connection type (optional `currentSchema`, connect timeout, `ClientCodepage`, SSL)
- Runtime driver integration with UTF-8 `ClientCodepage=1208` default (overridable)
- Schema metadata for tables, views, nicknames, aliases, procedures, functions, and federated catalog groups
- DDL fallback from `SYSCAT.*` (constraints, indexes, partitions, comments, alias/nickname DDL)
- Explain plan parsing, tuning advisor, session monitor, and table maintenance (`RUNSTATS` / `REORG`, index/partition helpers)
- Import type mapping for Db2 types
- Copilot reference text for optimization and SQL PL

## Capabilities (aligned with `db2Dialect`)

| Capability | Enabled |
| --- | --- |
| Explain plan / graph | Yes |
| Tuning advisor | Yes |
| Procedures | Yes |
| Table maintenance | Yes |
| Session monitor | Yes |
| External tables / distribution metrics | No (Netezza-only surfaces stay hidden) |

Editor depth is **Advanced (LUW SQL + CST linter/semantic)**; deep SQL PL visitor (SQL037–039) remains a follow-on. See [docs/db2.md](../../docs/db2.md) and [plans/DIALECT_PARITY_MATRIX.md](../../plans/DIALECT_PARITY_MATRIX.md).

## Windows ODBC registration

The extension **never** registers an ODBC driver or changes the Windows registry automatically. If the driver reports **Data source name not found**, rebuild with `npm run db2:runtime:electron`. Only when approved by an administrator, register the bundled driver manually:

```powershell
<path-to-clidriver>\bin\db2cli.exe install -setup
```

## Installation Order

1. Install `JustyBase SQL Editor (Db2)`; VS Code installs the base extension automatically.

The extension dependency allows Marketplace resolution; no separate Netezza installation is required.

## Development

```powershell
npm run install:db2
npm run rebuild:db2          # Electron ABI for F5
# F5 -> Run Core + Db2 Support

npm run db2:runtime:node     # before Jest / live tests
npm run test:db2:integration
npm run verify:db2
```

Live env: `DB2_LIVE_TEST_*` — see [docs/db2.md](../../docs/db2.md). Persistent fixture: `npm run db2:seed-live-fixture`.

For Linux/macOS library path notes see `extensions/DB2_DEBUG_AND_INSTALL.md` when present.

## Packaging

```powershell
npm run package:db2:full
```

CI: `.github/workflows/db2-build.yml` (VSIX).

## License

Apache-2.0. Marketplace VSIX includes `THIRD_PARTY_NOTICES.md`.
