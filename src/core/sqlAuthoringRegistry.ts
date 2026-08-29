import {
  DEFAULT_DATABASE_KIND,
  DatabaseKind,
  tryNormalizeDatabaseKind,
} from "../contracts/database";
import type { DatabaseSqlAuthoring } from "../sql/authoring/types";
import { netezzaSqlAuthoring } from "../dialects/netezza/sql/authoring";
import { sqliteSqlAuthoring } from "../dialects/sqlite/sql/authoring";
import { duckdbSqlAuthoring } from "../dialects/duckdb/sql/authoring";
import { postgresqlSqlAuthoring } from "../../extensions/postgresql/src/postgresqlSqlAuthoring";
import { db2SqlAuthoring } from "../../extensions/db2/src/sql/authoring";
import { mssqlSqlAuthoring } from "../../extensions/mssql/src/sql/authoring";
import { mysqlSqlAuthoring } from "../../extensions/mysql/src/sql/authoring";
import { oracleSqlAuthoring } from "../../extensions/oracle/src/sql/authoring";
import { snowflakeSqlAuthoring } from "../../extensions/snowflake/src/sql/authoring";
import { verticaSqlAuthoring } from "../../extensions/vertica/src/sql/authoring";
import { accessSqlAuthoring } from "../dialects/access/sql/authoring";
import { fileSqlAuthoring } from "../dialects/file/sql/authoring";
import { clickhouseSqlAuthoring } from "../../extensions/clickhouse/src/sql/authoring";

const SQL_AUTHORING_BY_KIND = new Map<DatabaseKind, DatabaseSqlAuthoring>([
  ["netezza", netezzaSqlAuthoring],
  ["sqlite", sqliteSqlAuthoring],
  ["duckdb", duckdbSqlAuthoring],
  // File SQL (Excel/CSV/Parquet/Avro) is DuckDB under the hood — the LSP
  // server process needs the authoring entry without the companion pack.
  ["file", fileSqlAuthoring],
  ["postgresql", postgresqlSqlAuthoring],
  ["db2", db2SqlAuthoring],
  ["mssql", mssqlSqlAuthoring],
  ["mysql", mysqlSqlAuthoring],
  ["clickhouse", clickhouseSqlAuthoring],
  ["oracle", oracleSqlAuthoring],
  ["snowflake", snowflakeSqlAuthoring],
  ["vertica", verticaSqlAuthoring],
  ["access", accessSqlAuthoring],
]);

function resolveSqlAuthoringDatabaseKind(
  kind?: string | DatabaseKind,
): DatabaseKind {
  if (!kind) {
    return DEFAULT_DATABASE_KIND;
  }

  const normalizedKind = tryNormalizeDatabaseKind(kind);
  if (!normalizedKind) {
    throw new Error(`Unsupported database kind '${kind}'.`);
  }

  return normalizedKind;
}

export function registerDatabaseSqlAuthoring(
  kind: DatabaseKind,
  authoring: DatabaseSqlAuthoring,
): DatabaseSqlAuthoring {
  const existing = SQL_AUTHORING_BY_KIND.get(kind);
  if (existing) {
    return existing;
  }

  SQL_AUTHORING_BY_KIND.set(kind, authoring);
  return authoring;
}

export function tryGetDatabaseSqlAuthoring(
  kind?: string | DatabaseKind,
): DatabaseSqlAuthoring | undefined {
  const normalizedKind = kind
    ? tryNormalizeDatabaseKind(kind)
    : DEFAULT_DATABASE_KIND;
  if (!normalizedKind) {
    return undefined;
  }

  return SQL_AUTHORING_BY_KIND.get(normalizedKind);
}

export function getDatabaseSqlAuthoring(
  kind?: string | DatabaseKind,
): DatabaseSqlAuthoring {
  const normalizedKind = resolveSqlAuthoringDatabaseKind(kind);
  const authoring = SQL_AUTHORING_BY_KIND.get(normalizedKind);
  if (!authoring) {
    throw new Error(`No SQL authoring registered for '${normalizedKind}'.`);
  }

  return authoring;
}

export function __TEST_ONLY_resetDatabaseSqlAuthoringRegistry(): void {
  SQL_AUTHORING_BY_KIND.clear();
  SQL_AUTHORING_BY_KIND.set("netezza", netezzaSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("sqlite", sqliteSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("duckdb", duckdbSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("file", fileSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("postgresql", postgresqlSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("db2", db2SqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("mssql", mssqlSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("mysql", mysqlSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("clickhouse", clickhouseSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("oracle", oracleSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("snowflake", snowflakeSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("vertica", verticaSqlAuthoring);
  SQL_AUTHORING_BY_KIND.set("access", accessSqlAuthoring);
}
