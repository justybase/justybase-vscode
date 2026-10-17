---
name: multidialect-conformance
description: Status and rules of the multidialect SQL conformance program for justybase-vscode, a local-only consumer of the JustyBase.SqlConformance corpus. Use when changing parser or linter behaviour covered by the shared corpus or running the local conformance tests.
---

# Multidialect conformance: justybase-vscode

Status as of 2026-10-17. The canonical, dated status is
`../JustyBase.SqlConformance/docs/MULTIDIALECT_STATUS.md`. Read it first; this
file is a working summary and may lag behind it.

## Role

SQL conformance tests are optional local developer tests. This repository does
not vendor the corpus and standard CI never uses it. Conformance tests read the
sibling checkout directly via `JUSTYBASE_SQL_CONFORMANCE_PATH`:

```bash
cd justybase-vscode
export JUSTYBASE_SQL_CONFORMANCE_PATH="$(realpath ../JustyBase.SqlConformance)"
npm run test:conformance
npm run test:postgresql:conformance
```

- `npm run test:conformance` runs `jest.conformance.config.js` (shared live
  baseline + PostgreSQL parser/editor contracts). The config self-limits via
  `testMatch`, so it cannot pick up regular unit tests.
- The same tests are excluded from the default Jest configs
  (`jest.config.js`, `jest.fast.config.js`, `jest.validate.config.js`), so
  `npm test`, `npm run test:coverage` and `npm run verify:pr` work without the
  corpus.
- A missing `JUSTYBASE_SQL_CONFORMANCE_PATH` on an explicit conformance run is
  a hard error, never a silent skip.

## Current state

- No committed corpus snapshot. Former `feac362` snapshot, sync scripts
  (`conformance:sync`, `conformance:check`, `conformance:postgresql:sync`,
  `conformance:postgresql:check`) and snapshot hash verification are removed.
- `postgresqlVersion.test.ts` keeps hand-maintained regression SQL and runs in
  standard CI. `postgresqlParser.test.ts` keeps the scanner/splitter and parser
  construction-budget checks.
- The transactional live probe
  (`src/__tests__/integration/postgresqlConformance.live.integration.test.ts`,
  `npm run test:postgresql:conformance:live`) loads cases from the env corpus
  and is not part of any CI workflow.

## Rules

- Parser changes update every file listed under "Parser Changes" in `AGENTS.md`
  and keep cold construction under 2000 ms for MSSQL and Oracle.
- Never list the same token in `commandTailToken` and in a dialect token list.
- Live checks read environment variables only. `POSTGRES_LIVE_TEST_*` is an
  alias for `PG_LIVE_TEST_*`, set in `~/.bashrc`; the PostgreSQL dev host is
  `192.168.0.61`.
- Do not commit corpus cases or regenerated fixtures into this repository.
- Commits pass through a `pre-commit` hook that builds the workspace, so a
  commit can take several minutes.

## Related projects

- `JustyBase.SqlConformance`: the corpus owner and the source of truth.
- `JustyBase.NetezzaSql` (C#): local-only consumer of the same corpus
  (`dotnet test --filter "Category=SqlConformance"` with
  `JUSTYBASE_SQL_CONFORMANCE_PATH` set).
- `justybase_rust_tauri` (Rust): still pins a snapshot under
  `crates/app-core/tests/fixtures/sql-conformance/` (out of scope here).
- `justybase` (C# application): routes Oracle, PostgreSQL and MySQL to the
  Netezza profile. This program does not change that routing.
