---
name: multidialect-conformance
description: Status and rules of the multidialect SQL conformance program for justybase-vscode, a consumer of the pinned JustyBase.SqlConformance snapshot. Use when changing parser or linter behaviour covered by the shared corpus, regenerating conformance fixtures, or deciding what is safe to commit.
---

# Multidialect conformance: justybase-vscode

Status as of 2026-10-17. The canonical, dated status is
`../JustyBase.SqlConformance/docs/MULTIDIALECT_STATUS.md`. Read it first; this
file is a working summary and may lag behind it.

## Role

The extension consumes a pinned snapshot of the shared corpus in
`src/__tests__/sqlParser/fixtures/sqlConformance/`.

- Regenerate: `npm run conformance:sync`. Check: `npm run conformance:check`.
- Do not edit files under `fixtures/sqlConformance/` by hand.
- A snapshot must come from a committed corpus revision with `corpusDirty: false`.

## Current state

- The pinned snapshot is `feac362`, `corpusDirty: false`, 2471 cases.
- Commits on `origin/master`: `2f16a00f` (Netezza ISNULL builtin),
  `df81ecca` (legacy PostgreSQL test renders `{{cf}}`), `c6d85f3d` (dialect
  parser alignment), `1246d1ca` (snapshot consumer tests and sync scripts).
- Last gate: `npm run verify:pr` exited 0 on the pinned snapshot before the
  parser commits were split out.

## Rules

- Parser changes update every file listed under "Parser Changes" in `AGENTS.md`
  and keep cold construction under 2000 ms for MSSQL and Oracle.
- Never list the same token in `commandTailToken` and in a dialect token list.
- Live checks read environment variables only. `POSTGRES_LIVE_TEST_*` is an
  alias for `PG_LIVE_TEST_*`, set in `~/.bashrc`; the PostgreSQL dev host is
  `192.168.0.61`.
- Do not commit fixtures that were not regenerated from a clean corpus commit.
- Commits pass through a `pre-commit` hook that builds the workspace, so a
  commit can take several minutes.

## Related projects

- `JustyBase.SqlConformance`: the corpus owner and the source of truth.
- `JustyBase.NetezzaSql` (C#) and `justybase_rust_tauri` (Rust): consumers of
  the same pinned-snapshot model.
- `justybase` (C# application): routes Oracle, PostgreSQL and MySQL to the
  Netezza profile. This program does not change that routing.
