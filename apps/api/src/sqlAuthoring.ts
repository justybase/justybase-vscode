import { tryNormalizeDatabaseKind, type DatabaseKind, type DatabaseSqlAuthoring } from '@justybase/contracts';
import { NETEZZA_SQL_AUTHORING } from '@justybase/sql-core';
import { accessSqlAuthoring } from '@justybase/dialect-utils/authoring/access';
import { clickhouseSqlAuthoring } from '@justybase/dialect-utils/authoring/clickhouse';
import { db2SqlAuthoring } from '@justybase/dialect-utils/authoring/db2';
import { duckdbSqlAuthoring } from '@justybase/dialect-utils/authoring/duckdb/authoring';
import { mssqlSqlAuthoring } from '@justybase/dialect-utils/authoring/mssql';
import { mysqlSqlAuthoring } from '@justybase/dialect-utils/authoring/mysql';
import { oracleSqlAuthoring } from '@justybase/dialect-utils/authoring/oracle';
import { postgresqlSqlAuthoring } from '@justybase/dialect-utils/authoring/postgresql';
import { snowflakeSqlAuthoring } from '@justybase/dialect-utils/authoring/snowflake';
import { verticaSqlAuthoring } from '@justybase/dialect-utils/authoring/vertica';

/**
 * SQL authoring is independent from query execution. A profile can therefore
 * provide dialect-aware completion and diagnostics even when its native API
 * runtime is not installed in the current deployment.
 */
const AUTHORING_BY_KIND: ReadonlyMap<string, DatabaseSqlAuthoring> = new Map([
  ['netezza', NETEZZA_SQL_AUTHORING],
  ['oracle', oracleSqlAuthoring],
  ['postgresql', postgresqlSqlAuthoring],
  ['db2', db2SqlAuthoring],
  ['mssql', mssqlSqlAuthoring],
  ['clickhouse', clickhouseSqlAuthoring],
  ['mysql', mysqlSqlAuthoring],
  ['snowflake', snowflakeSqlAuthoring],
  ['vertica', verticaSqlAuthoring],
  ['access', accessSqlAuthoring],
  ['duckdb', duckdbSqlAuthoring],
  ['sqlite', duckdbSqlAuthoring],
  ['file', duckdbSqlAuthoring],
]);

export function getSqlAuthoring(databaseKind?: DatabaseKind): DatabaseSqlAuthoring {
  const normalized = tryNormalizeDatabaseKind(databaseKind);
  return AUTHORING_BY_KIND.get(normalized ?? 'netezza') ?? NETEZZA_SQL_AUTHORING;
}
