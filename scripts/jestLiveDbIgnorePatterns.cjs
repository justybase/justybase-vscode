/** Live-database integration suites excluded from default/validate unit test runs. */
module.exports = [
  "realDatabase.integration.test.ts",
  "optionalDialects.live.integration.test.ts",
  "postgres.integration.test.ts",
  "duckdb.integration.test.ts",
  "snowflake.integration.test.ts",
  "mysql.integration.test.ts",
  "mssql.integration.test.ts",
  "oracle.integration.test.ts",
  "db2.integration.test.ts",
  "vertica.integration.test.ts",
];
