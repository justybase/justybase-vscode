# PostgreSQL authoring validation

## Scope

The editor targets PostgreSQL 16–18 with an independent Chevrotain parser
derived from the shared ANSI base. Netezza statement rules are not inherited.
The parser accepts the implemented union of these releases; connected older
servers receive warning `PG001` for recognized newer forms. An unknown server
version does not produce version warnings.

Covered forms include dollar-quoted and escape strings, Unicode identifiers,
positional parameters, casts, arrays/subscripts, JSON operators, DISTINCT ON,
VALUES queries, materialized and data-modifying CTEs, lateral/function sources,
ordinality, ordered aggregates, named windows, ON CONFLICT, RETURNING,
UPDATE FROM, DELETE USING, MERGE, basic JSON_TABLE, EXPLAIN options, identity
and generated columns, common ALTER TABLE actions, enum/composite/domain
types, indexes, and routine envelopes.

PL/pgSQL string bodies are opaque. Their syntax and procedural semantics remain
the server's responsibility. BEGIN ATOMIC SQL bodies are parsed structurally.
This is a tested SQL subset, not a complete implementation of PostgreSQL's
grammar. Advanced routine options, nested JSON_TABLE clauses, index operator
classes/storage options and some DDL forms remain outside the covered subset.

## Identity and session context

Unquoted SQL identifiers fold to lower case. Quoted identifiers retain case.
Alias scopes and column checks distinguish `i` from `"I"`. LSP table-info
cache keys preserve catalog spelling. Unqualified LSP table lookup follows the
known session search_path in order, including implicit schemas; an unresolved
earlier schema cannot silently select a later match.

The existing persistent connection publishes server_version_num and
current_schemas(true). Reads are coalesced, refreshed after commands, and
deferred while a command is active. Closing or losing a connection clears this
context. LSP context changes invalidate incremental diagnostics and warm-up
state. Authoring does not open a database connection just to discover context.

The older desktop metadata cache still has shared legacy key normalization.
The LSP identity tests cover its own table-info boundary; they do not prove
that all host cache/explorer paths distinguish two quoted catalog objects whose
names differ only by case. That broader metadata migration remains a separate
acceptance item.

## Lexical and execution contract

Source scans, statement boundaries, semantic-token guards and completion
understand PostgreSQL quoting. Dollar bodies remain one statement and keep
original UTF-16 offsets. Macro-looking text inside protected PostgreSQL SQL
regions is preserved during execution preprocessing, including queued and
single-query execution. These checks must continue passing for Netezza macro
completion and preprocessing.

## Test ownership

| Repository | Responsibility |
| --- | --- |
| JustyBase.SqlConformance | Neutral parser/editor expectations, synthetic catalog fixtures, source references, live oracle evidence, dialect-aware adapter and P0 completeness gate |
| justybase-vscode | Local-only conformance tests against production APIs via `JUSTYBASE_SQL_CONFORMANCE_PATH`, hand-maintained regression tests, scanner/splitter and performance tests, session/runtime tests, built LSP protocol test, live PostgreSQL matrix (local only) |

SQL conformance tests are optional local developer tests. Set
`JUSTYBASE_SQL_CONFORMANCE_PATH` to a local JustyBase.SqlConformance checkout
(e.g. `export JUSTYBASE_SQL_CONFORMANCE_PATH="$(realpath ../JustyBase.SqlConformance)"`
from this repository) and run `npm run test:conformance` or
`npm run test:postgresql:conformance`. The corpus is not vendored into this
repository and is not used by standard CI. A missing variable on an explicit
conformance run is a hard error. The transactional live probe
(`npm run test:postgresql:conformance:live`) likewise loads its cases from the
env corpus and never runs in CI.

Common cases in a PostgreSQL report must have executionDialect=postgresql.
A successful common case executed with Netezza is not PostgreSQL evidence.

## Commands

```sh
npm run test:postgresql:authoring
npm run test:postgresql:conformance
npm run test:postgresql:conformance:live
npm run test:lsp:postgresql
npm run test:postgres:integration
npm run verify:postgresql
```

`test:postgresql:authoring` runs the hand-maintained regression tests in
standard CI without any corpus. `test:postgresql:conformance` and
`test:postgresql:conformance:live` are explicit local-only commands requiring
`JUSTYBASE_SQL_CONFORMANCE_PATH`; the live command additionally requires
POSTGRES_LIVE_TEST_HOST, POSTGRES_LIVE_TEST_DATABASE,
POSTGRES_LIVE_TEST_USER and POSTGRES_LIVE_TEST_PASSWORD; PORT defaults to 5432.
Missing configuration is an error on explicit invocation. Conformance and live
suites are excluded from the default root Jest run. The CI PostgreSQL workflow
runs live integration, authoring and built LSP checks; it does not verify the
SQL corpus.

The conformance suite creates a random schema inside a transaction, substitutes
that schema for canonical public fixture references, plans SELECT/WITH queries,
binds positional parameters, executes fixture DDL/DML behind savepoints, and
rolls everything back. It verifies that the schema is absent afterward.
Missing relations, permissions and timeouts cannot count as syntax rejection.
Reports in artifacts/postgresql contain IDs, version, verdicts, SQLSTATE and
cleanup status, without credentials or row values.

The PostgreSQL CI workflow runs live integration, authoring and built LSP
checks against PostgreSQL 16, 17 and 18. Corpus verification
(`test:postgresql:conformance`, `test:postgresql:conformance:live`) is a local
developer gate only and never runs in CI. Local live evidence was obtained on
16.13; results on 17 and 18 must come from equivalent local runs.
Do not relabel documentation-backed 17/18 cases as server-verified on the basis
of a 16 run.

## Evidence and references

The 2026-10-14 live run corrected the initially assumed rejection of an empty
ENUM: PostgreSQL 16.13 accepts it. The canonical positive case records that
result; the negative case contains a genuinely malformed list.

Reference documentation:

- [PostgreSQL 16 lexical syntax](https://www.postgresql.org/docs/16/sql-syntax-lexical.html)
- [PostgreSQL 16 EXPLAIN](https://www.postgresql.org/docs/16/sql-explain.html)
- [PostgreSQL 17 MERGE](https://www.postgresql.org/docs/17/sql-merge.html)
- [PostgreSQL 17 JSON functions](https://www.postgresql.org/docs/17/functions-json.html)
- [PostgreSQL 18 RETURNING](https://www.postgresql.org/docs/18/dml-returning.html)
- [PostgreSQL 18 generated columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html)
