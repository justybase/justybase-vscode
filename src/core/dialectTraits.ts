import {
  DEFAULT_DATABASE_KIND,
  DatabaseDialectTraits,
  DatabaseKind,
  normalizeDatabaseKind,
} from "../contracts/database";
import { db2DialectTraits } from "../shared/dialect-traits/db2";
import { duckdbDialectTraits } from "../dialects/duckdb/traits";
import { mssqlDialectTraits } from "../shared/dialect-traits/mssql";
import { mysqlDialectTraits } from "../shared/dialect-traits/mysql";
import { netezzaDialectTraits } from "../dialects/netezza/traits";
import { oracleDialectTraits } from "../shared/dialect-traits/oracle";
import { postgresqlCompatibleDialectTraits } from "../shared/dialect-traits/postgresql-compatible";
import { snowflakeDialectTraits } from "../shared/dialect-traits/snowflake";
import { sqliteDialectTraits } from "../dialects/sqlite/traits";
import { verticaDialectTraits } from "../shared/dialect-traits/vertica";

const DIALECT_TRAITS_BY_KIND: Readonly<
  Record<DatabaseKind, DatabaseDialectTraits>
> = {
  netezza: netezzaDialectTraits,
  oracle: oracleDialectTraits,
  postgresql: postgresqlCompatibleDialectTraits,
  vertica: verticaDialectTraits,
  snowflake: snowflakeDialectTraits,
  sqlite: sqliteDialectTraits,
  duckdb: duckdbDialectTraits,
  db2: db2DialectTraits,
  mssql: mssqlDialectTraits,
  mysql: mysqlDialectTraits,
};

export function getDatabaseDialectTraits(
  kind?: string | DatabaseKind,
): DatabaseDialectTraits {
  const normalizedKind = kind
    ? normalizeDatabaseKind(kind)
    : DEFAULT_DATABASE_KIND;
  return DIALECT_TRAITS_BY_KIND[normalizedKind];
}

export function applyGeneratedIdentifierCase(
  value: string,
  kind?: string | DatabaseKind,
): string {
  const generatedNameCase =
    getDatabaseDialectTraits(kind).identifiers.generatedNameCase;

  if (generatedNameCase === "lower") {
    return value.toLowerCase();
  }

  if (generatedNameCase === "upper") {
    return value.toUpperCase();
  }

  return value;
}
