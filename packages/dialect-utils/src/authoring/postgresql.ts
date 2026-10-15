import { postgresqlCompatibleSqlAuthoring } from "@justybase/dialect-utils/authoring/postgresql-compatible";

const optionalParameters = new Set(['NUMERIC', 'DECIMAL', 'VARCHAR', 'CHARACTER VARYING', 'CHAR', 'CHARACTER']);
/** PostgreSQL uses the dedicated parser and therefore validates its supported syntax strictly. */
export const postgresqlSqlAuthoring = {
  ...postgresqlCompatibleSqlAuthoring,
  completionKeywords: postgresqlCompatibleSqlAuthoring.completionKeywords.filter(word => word !== 'UPSERT'),
  validation: {
    ...postgresqlCompatibleSqlAuthoring.validation,
    databaseKind: 'postgresql' as const,
    syntaxValidationMode: 'strict' as const,
    getTypeSpec(name: string) {
      const spec = postgresqlCompatibleSqlAuthoring.validation.getTypeSpec(name);
      return spec && optionalParameters.has(spec.canonical) ? { ...spec, paramsMin: 0, warnIfNoLength: false } : spec;
    },
  },
};
