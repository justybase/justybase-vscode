# PostgreSQL Support

PostgreSQL support is delivered as the optional sibling extension in [`extensions/postgresql`](../extensions/postgresql).

## Preview extension status

This pack is published with `"preview": true` in `extensions/postgresql/package.json`. It is a **companion runtime** for the JustyBase core extension — not a peer of the Netezza-first SQL stack.

**Netezza (core)** ships the full dialect tooling: dedicated Chevrotain grammar, NZPLSQL procedure diagnostics, semantic tokens, SQL/NZ/NZP linter depth, and Netezza-specific IDE workflows (GROOM, session monitor, ETL designer, and similar).

**PostgreSQL (this pack)** reuses the shared shell (connect, schema browser, query execution, results/export) and adds PostgreSQL-oriented features below. It ships a dedicated PostgreSQL Chevrotain lexer/parser in core (`src/dialects/postgresql/sql`) with **strict** syntax validation on the shared LSP stack. Editor depth is below Netezza (no NZPLSQL-equivalent procedure scope analysis, no PostgreSQL-specific TOIDs beyond shared codes), but SQL validation is first-class rather than best-effort.

## What this pack provides

- Shared connection form with standard host, port, database, user, and password fields
- PostgreSQL-specific connection fields — `searchPath`, `sslMode`/`sslServerName`, connect timeout, and session statement timeout — applied when a connection is established
- Metadata-driven schema explorer for schemas, tables, views, functions, procedures, and sequences
- Metadata-aware SQL completion through the shared LSP path, backed by the dedicated PostgreSQL parser
- Dedicated PostgreSQL lexer/parser in core (`src/dialects/postgresql/sql`) with strict syntax validation on the shared LSP stack
- PostgreSQL import flow backed by `COPY ... FROM STDIN`
- DDL generation for tables, views, routines, and sequences
- `EXPLAIN (FORMAT JSON)` parsing for the explain view and tuning-advisor scaffolding
- Table maintenance (VACUUM/ANALYZE/REINDEX and friends) and session monitor (`pg_terminate_backend`)

## Installation

1. Install the core extension: `krzysztof-d.justybaselite-netezza`
2. Install the optional PostgreSQL support extension from this repository packaging flow
3. For local packaging or development:

```bash
cd extensions/postgresql
npm install
npm run build
```

## Runtime Notes

- The extension uses the pure JavaScript `pg` driver. No native binaries are bundled.
- Each saved PostgreSQL connection targets a single database. Save separate connections for different databases.
- System schemas such as `pg_catalog`, `information_schema`, `pg_toast*`, and temp schemas are intentionally filtered from the main schema explorer.

## Explain and Tuning

- The explain command builds `EXPLAIN (FORMAT JSON, ...)` statements for PostgreSQL.
- The shared explain view consumes a PostgreSQL JSON plan after it is normalized into the common planner text shape.
- The PostgreSQL tuning advisor currently provides heuristic recommendations for:
    - `SELECT *`
    - large sequential/full scans
    - nested loop joins at larger row volumes
    - high overall planner cost
    - row-estimate drift when `EXPLAIN ANALYZE` output is supplied

## Streaming results

Regular PostgreSQL commands use incremental `pg/lib/query` row events. Column
names and PostgreSQL OID type names are available before the first row, result
sets are exposed through `nextResult()`, and closing a reader cancels an active
backend. A small socket-backed queue avoids materializing the complete result.

## Import and COPY

- PostgreSQL CSV import uses `COPY ... FROM STDIN`
- Import streams are kept in memory only for the duration of the import session
- No credentials or import artifacts are persisted in the repository

## Integration Testing

Optional local integration:

```bash
npm run test:postgres:integration
```

## PostgreSQL over HTTPS/WSS tunnel

TCP tunneling is implemented globally in the core extension and is also
available to Netezza and Oracle. The complete deployment, UI, security, and
live-test procedure is maintained in
[`docs/database-tunnel.md`](database-tunnel.md).

For PostgreSQL, the important detail is that database TLS is independent from
the outer WSS link: configure `sslMode` and (when needed) `sslServerName` in
the normal PostgreSQL connection profile. With `verify-full`, use
`127.0.0.1` as the driver Host and set the remote certificate DNS name as the
TLS server name.

The local relay test is:

```bash
npm run test:database:tunnel
```

The combined live relay test starts the FastAPI sample and requires credentials
for both targets under test:

```bash
npm run test:database:tunnel:live
```
