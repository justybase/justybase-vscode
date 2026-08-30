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
