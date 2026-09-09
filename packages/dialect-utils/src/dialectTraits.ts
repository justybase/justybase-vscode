import {
  DEFAULT_DATABASE_KIND,
  DatabaseDialectTraits,
  DatabaseKind,
  tryNormalizeDatabaseKind,
} from "@justybase/contracts";
import { db2DialectTraits } from "./traits/db2";
import { duckdbDialectTraits } from "./traits/duckdb";
import { mssqlDialectTraits } from "./traits/mssql";
import { mysqlDialectTraits } from "./traits/mysql";
import { netezzaDialectTraits } from "./traits/netezza";
import { oracleDialectTraits } from "./traits/oracle";
import { postgresqlCompatibleDialectTraits } from "./traits/postgresql-compatible";
import { snowflakeDialectTraits } from "./traits/snowflake";
import { sqliteDialectTraits } from "./traits/sqlite";
import { verticaDialectTraits } from "./traits/vertica";
import { accessDialectTraits } from "./traits/access";
import { clickhouseDialectTraits } from "./traits/clickhouse";

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
  file: duckdbDialectTraits,
  db2: db2DialectTraits,
  mssql: mssqlDialectTraits,
  mysql: mysqlDialectTraits,
  clickhouse: clickhouseDialectTraits,
  access: accessDialectTraits,
};

export function getDatabaseDialectTraits(
  kind?: string | DatabaseKind,
): DatabaseDialectTraits {
  if (kind === undefined || kind.trim().length === 0) {
    return DIALECT_TRAITS_BY_KIND[DEFAULT_DATABASE_KIND];
  }

  const normalizedKind = tryNormalizeDatabaseKind(kind);
  if (!normalizedKind || !DIALECT_TRAITS_BY_KIND[normalizedKind]) {
    throw new Error(`Unsupported database kind '${kind}'.`);
  }

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
