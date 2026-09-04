# PostgreSQL Support

PostgreSQL support is delivered as the optional sibling extension in [`extensions/postgresql`](../extensions/postgresql).

## Preview extension status

This pack is published with `"preview": true` in `extensions/postgresql/package.json`. It is a **companion runtime** for the JustyBase core extension — not a peer of the Netezza-first SQL stack.

**Netezza (core)** ships the full dialect tooling: dedicated Chevrotain grammar, NZPLSQL procedure diagnostics, semantic tokens, SQL/NZ/NZP linter depth, and Netezza-specific IDE workflows (GROOM, session monitor, ETL designer, and similar).

**PostgreSQL (this pack)** reuses the shared shell (connect, schema browser, query execution, results/export) and adds PostgreSQL-oriented features below. It ships a dedicated PostgreSQL Chevrotain lexer/parser in core (`src/dialects/postgresql/sql`) with **strict** syntax validation on the shared LSP stack. Editor depth is below Netezza (no NZPLSQL-equivalent procedure scope analysis, no PostgreSQL-specific TOIDs beyond shared codes), but SQL validation is first-class rather than best-effort.

## What this pack provides

- Shared connection UI with PostgreSQL-specific fields such as `searchPath`, `sslMode`, and statement timeout
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

When the desktop machine can reach only an HTTPS server, while that server can
reach PostgreSQL, the PostgreSQL companion can expose a loopback TCP listener
and relay each connection through an authenticated WebSocket. PostgreSQL and
the `pg` driver remain unaware of the relay:

```text
JustyBase -> 127.0.0.1:15432 -> WSS/443 -> FastAPI -> private PostgreSQL:5432
```

The reference FastAPI server is in
[`samples/postgresql-tunnel`](../samples/postgresql-tunnel/). It uses named
server-side targets and never accepts an arbitrary host or port from the
client. Configure and start a tunnel from the Command Palette with:

- **PostgreSQL: Configure Tunnel**
- **PostgreSQL: Start Tunnel**
- **PostgreSQL: Stop Tunnel**
- **PostgreSQL: Tunnel Status**

Then create a normal PostgreSQL connection with host `127.0.0.1` (or
`localhost`) and the configured local port. Port `15432` is the default;
`5432` is also supported when it is free. The tunnel token is kept in VS Code
SecretStorage and is not part of the database connection profile.

Use `sslMode=require` or `verify-full` according to the remote PostgreSQL
deployment. With `verify-full`, use `127.0.0.1` and set the optional PostgreSQL
`TLS Server Name` field to the DNS name present in the database certificate.
The tunnel is desktop-only; a browser cannot open the local TCP listener.

The test is skipped unless `POSTGRES_LIVE_TEST_*` environment variables are set.

Optional docker-compose environment:

```bash
docker compose -f extensions/postgresql/docker-compose.integration.yml up -d
POSTGRES_LIVE_TEST_HOST=127.0.0.1 \
POSTGRES_LIVE_TEST_PORT=55432 \
POSTGRES_LIVE_TEST_DATABASE=justybase \
POSTGRES_LIVE_TEST_USER=justybase \
POSTGRES_LIVE_TEST_PASSWORD=justybase \
npm run test:postgres:integration
docker compose -f extensions/postgresql/docker-compose.integration.yml down -v
```
