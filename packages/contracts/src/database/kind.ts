/** Portable database identity, independent of dialect implementations. */
export type DatabaseKind =
  | 'netezza'
  | 'oracle'
  | 'postgresql'
  | 'vertica'
  | 'snowflake'
  | 'sqlite'
  | 'duckdb'
  | 'db2'
  | 'mssql'
  | 'mysql'
  | 'clickhouse'
  | 'access'
  | (string & {});
