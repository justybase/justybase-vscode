import { postgresqlCompatibleSqlAuthoring } from "../../../src/shared/sql-authoring/postgresql-compatible";

/** PostgreSQL uses the dedicated parser and therefore validates its supported syntax strictly. */
export const postgresqlSqlAuthoring = {
  ...postgresqlCompatibleSqlAuthoring,
  validation: {
    ...postgresqlCompatibleSqlAuthoring.validation,
    databaseKind: 'postgresql' as const,
    syntaxValidationMode: 'strict' as const,
  },
};
