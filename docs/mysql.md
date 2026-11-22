# MySQL Support

MySQL support is delivered as the optional sibling extension in
[`extensions/mysql`](../extensions/mysql). The structural tooling described here
targets MySQL 8.0+; MariaDB is not part of this capability boundary.

## Index and partition webviews

For a MySQL table in the Schema Explorer, the companion adds:

- **MySQL: Index Designer** — reads `information_schema.STATISTICS`, groups
  metadata by index, and displays key order, prefix lengths, cardinality,
  visibility, comments, and index type. It creates standard and `UNIQUE`
  indexes from table columns. Existing `FULLTEXT`, `SPATIAL`, expression, or
  other advanced indexes remain visible for review but do not get an advanced
  creation form. Secondary indexes can be dropped; `PRIMARY` cannot be dropped
  from the panel.
- **MySQL: Partition Manager** — reads `information_schema.PARTITIONS` and
  displays partition/subpartition names, method, expressions, bounds, estimated
  rows, and storage sizes. The panel is deliberately method-specific:

  | Table shape | Supported write operations |
  | --- | --- |
  | `RANGE` / `LIST` without a `MAXVALUE` tail | Add a named partition and drop a named partition |
  | `HASH` / `LINEAR HASH` / `KEY` / `LINEAR KEY` | Add partitions by count and reduce the count with `COALESCE PARTITION` |
  | Non-partitioned or subpartitioned | Read-only explanation; no conversion or recursive subpartition DDL |
  | `NDB` partitioned table | Add where the method allows it; partition drops disabled |

  DDL is shown before execution and can be copied or opened in a SQL editor.
  Execute actions require an explicit confirmation. Dropping a partition is
  destructive because MySQL removes the rows stored in that partition.

## Intentional boundaries

The first version does not generate `REORGANIZE PARTITION`, `EXCHANGE
PARTITION`, attach/detach operations, or conversion of a non-partitioned table.
When the last RANGE/LIST partition is `MAXVALUE`, adding a partition is disabled
because it requires a reorganization of that tail partition. Subpartitions are
loaded and displayed but not modified.

Descending index keys are exposed only when the loaded table is InnoDB and the
server version supports them. The [MySQL descending-index documentation](https://dev.mysql.com/doc/refman/8.4/en/descending-indexes.html)
describes the engine/version boundary; the UI disables the option when the
capability cannot be established.

Metadata comes from the [MySQL `STATISTICS` table](https://dev.mysql.com/doc/refman/8.4/en/information-schema-statistics-table.html)
and [MySQL `PARTITIONS` table](https://dev.mysql.com/doc/refman/8.4/en/information-schema-partitions-table.html).
The companion does not expose connection passwords to the webviews: SQL is
loaded and executed through the core extension API.

## Verification boundary

Unit coverage exercises DDL generation, metadata mapping, capability gating,
host validation, and the rendered webview entry points. Live database coverage
should be run separately with a MySQL 8.0+ instance and a user that can read
`information_schema` and perform the selected DDL. Do not commit credentials or
generated database reports.

From the repository root:

```bash
npm run check-types
npm run lint
npm run build
npm run verify:mysql
```

## Integration Testing

Optional local integration against a live MySQL 8.4 LTS server:

```bash
npm run test:mysql:integration
```

The suite is opt-in: set `RUN_MYSQL_INTEGRATION=1` (or
`MYSQL_LIVE_TEST_ENABLED=1`) together with `MYSQL_LIVE_TEST_HOST`,
`MYSQL_LIVE_TEST_DATABASE`, `MYSQL_LIVE_TEST_USER` and
`MYSQL_LIVE_TEST_PASSWORD`. `MYSQL_LIVE_TEST_PORT` defaults to `3306`.

### Ephemeral local server (Docker in WSL2)

A throwaway server is defined in
[`extensions/mysql/docker-compose.integration.yml`](../extensions/mysql/docker-compose.integration.yml).
It uses `mysql:8.4` (LTS), maps host port `53306` to container port `3306`, and
creates the `TESTDB` database with a `justybase` user, matching the version and
database names asserted by the live suite. Run the commands below from WSL2 with
a running Docker daemon; `127.0.0.1:53306` is reachable from the same WSL shell
(Remote-WSL is a separate host placement and must be checked separately):

```bash
docker compose -f extensions/mysql/docker-compose.integration.yml up -d --wait

export RUN_MYSQL_INTEGRATION=1
export MYSQL_LIVE_TEST_HOST=127.0.0.1
export MYSQL_LIVE_TEST_PORT=53306
export MYSQL_LIVE_TEST_DATABASE=TESTDB
export MYSQL_LIVE_TEST_USER=justybase
export MYSQL_LIVE_TEST_PASSWORD=justybase

npm ci
(cd extensions/mysql && npm ci)
node scripts/mysql-integration-fixture.cjs create
npm run test:mysql:integration
node scripts/mysql-integration-fixture.cjs drop

docker compose -f extensions/mysql/docker-compose.integration.yml down -v
```

The `--wait` flag relies on the compose healthcheck (`mysqladmin ping`), so the
tests start only after the server is ready. `down -v` removes the container and
its data volume, leaving no durable database state. The fixture script creates
and drops the `departments` table used by the read-only View Data test; the
suite itself creates its remaining objects with unique suffixes and removes
them in `finally`. The credentials above are throwaway local values — never
commit real credentials or generated database reports.

Do not run `npm ci` from WSL against a checkout shared with Windows: it replaces
platform-specific modules and breaks the other side. Either install
dependencies for the platform you run on, or use a separate Linux clone. The
MySQL runtime (`mysql2`) is pure JavaScript, so the existing
`extensions/mysql/node_modules` also works from WSL.
