# Db2 LUW Support

Db2 support is delivered as the optional sibling extension in [`extensions/db2`](../extensions/db2) plus a dedicated Db2 SQL lexer/parser in core (`src/dialects/db2/sql`), TextMate grammar, and snippets.

## Status

The Db2 pack is published with `"preview": true`. Treat it as a **near-full companion**:

- **Runtime:** Advanced — connect, SYSCAT metadata (including aliases/nicknames/federated groups), DDL fallback, import/export, explain/tuning, RUNSTATS/REORG, session monitor, dedicated live suite + optional `JBL_LIVE` fixture.
- **Editor:** Advanced (LUW SQL + CST linter/semantic) — **DB2001–DB2008** quality rules, strict Chevrotain runtime (`FETCH FIRST`, `OPTIMIZE FOR`, isolation, `FOR READ ONLY`, `FINAL TABLE`, DGTT, thin SQL PL units), dialect-aware semantic tokens. Deep SQL PL (SQL037–039 visitor depth) remains a follow-on.

Maintainer labels: [plans/DIALECT_PARITY_MATRIX.md](../plans/DIALECT_PARITY_MATRIX.md).

**Netezza (core)** remains the reference full experience. Db2 does **not** expose Netezza distribution/skew/GROOM UI actions.

## What this pack provides

### Connection and metadata

- Shared connection UI: host/port/database/user, `currentSchema`, connect timeout, `ClientCodepage`, SSL options
- Native `ibm_db` + bundled clidriver (platform-specific VSIX)
- Schema explorer: TABLE, VIEW, NICKNAME, ALIAS, PROCEDURE, FUNCTION, plus read-only federated groups

### SQL editor

- Authoring keywords/types/signatures for Db2 LUW
- Quality rules **DB2001–DB2008** (`SELECT *`, DELETE/UPDATE without WHERE, reject `GROOM` / `DISTRIBUTE ON` / `LIMIT` / `DB..TABLE`, top-N without `ORDER BY`)
- Dedicated Db2 parser runtime (`DB2_SQL_PARSING_RUNTIME`) with **strict** syntax validation
- Dialect-aware semantic tokens (Db2 lexer + authoring builtins)
- Grammar: `dialects/db2/syntaxes/db2.tmLanguage.json`; snippets: `dialects/db2/snippets/db2.code-snippets`

### Data and operations

- Import type mapper (DECIMAL/DECFLOAT/GRAPHIC/CLOB/BLOB/…)
- Shared export with soft cancel via `Db2Command.cancel()`
- DDL reconstruction from `SYSCAT.*` (constraints, indexes, partitions, aliases, nicknames)
- Explain plan JSON parse + tuning advisor (`DB2TA-*`)
- Table maintenance: RUNSTATS, REORG, index/partition helpers
- Session monitor storage provider

## Environment variables (live)

| Variable | Required | Notes |
|----------|----------|--------|
| `DB2_LIVE_TEST_HOST` | yes | e.g. `localhost` |
| `DB2_LIVE_TEST_PORT` | no | default `50000` |
| `DB2_LIVE_TEST_DATABASE` | yes | e.g. `TESTDB` |
| `DB2_LIVE_TEST_USER` | yes | |
| `DB2_LIVE_TEST_PASSWORD` | yes | |
| `DB2_LIVE_TEST_CURRENT_SCHEMA` | no | |
| `DB2_LIVE_TEST_CLIENT_CODEPAGE` / `SECURITY` / … | no | connection options |
| `DB2_LIVE_FIXTURE_SCHEMA` | no | default `JBL_LIVE` |
| `DB2_LIVE_TEST_REQUIRED=false` | no | Soft-skip live suite locally. Default locally: **required** (fail if env/`ibm_db` missing). On GitHub Actions soft-skip when secrets absent (do not set REQUIRED). |

## Developer commands

```bash
npm run install:db2
npm run db2:runtime:napi          # shared Node-API runtime
npm run db2:connect-probe
npm run test:db2:integration      # dedicated live suite (auto-for-live-tests)
npm run verify:db2
DB2_VSCODE_TEST_VERSION=stable npm run test:db2:vscode-runtime
# Add DB2_VSCODE_RUNTIME_LIVE=true to run SELECT 1 against DB2_LIVE_TEST_*.
```

### Persistent live fixture

```bash
npm run db2:seed-live-fixture -- --force
npm run db2:verify-live-fixture
npm run db2:drop-live-fixture
```

See [`scripts-private/db2-live-fixture/manifest.json`](../scripts-private/db2-live-fixture/manifest.json). Optional IBM SAMPLE on the **Db2 host**: `db2sampl -name TESTDB -sql -force` (does not replace `JBL_LIVE`).

### Unit vs live vs manual

| Layer | Examples |
|-------|----------|
| Unit | explain parser, tuning advisor, quality rules DB2001–8, streaming cancel mocks, Db2 parser LUW + authoring |
| Live | `test:db2:integration` — metadata, DDL, completion E2E, DB2xxx + SQL004/SQL025 quality, explain/tuning soft-skip, maintenance, fixture |
| Manual | F5 Extension Host with Db2 VSIX + `db2:runtime:napi` |

## Packaging note

Root extension ships editor assets; the Db2 VSIX ships `ibm_db` + providers. Install order: core then Db2 pack (see [INTEGRATION_STEPS.md](./INTEGRATION_STEPS.md)).

## VS Code/Electron compatibility

The packaged `ibm_db` binding targets **Node-API 8**, so the VSIX is not tied
to a particular Electron ABI. Release CI loads the native driver from an
Extension Host on the minimum supported VS Code (`1.103.2`), current Stable,
and Insiders. Add `DB2_VSCODE_RUNTIME_LIVE=true` to make the same test perform
`SELECT 1 FROM SYSIBM.SYSDUMMY1` using `DB2_LIVE_TEST_*`; the compatibility
gate intentionally validates only native loading.
