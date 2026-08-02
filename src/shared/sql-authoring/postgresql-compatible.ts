import type {
  DatabaseSqlAuthoring,
  DatabaseSqlFunctionSignature,
  DatabaseSqlTypeSpec,
  DatabaseSqlValidationProfile,
} from "../../sql/authoring/types";
import {
  BASE_SQL_BUILTIN_FUNCTIONS,
  BASE_SQL_COMPLETION_KEYWORDS,
  BASE_SQL_FORMATTER_PROFILE,
  BASE_SQL_FUNCTION_SIGNATURES,
  BASE_SQL_SPECIAL_BUILTIN_VALUES,
  extendFormatterProfile,
  mergeFunctionSignatures,
  mergeStringSets,
  mergeUniqueStrings,
} from "../../sql/authoring/baseProfiles";

const POSTGRESQL_COMPATIBLE_KEYWORD_OVERLAYS = [
  "DISTINCT ON",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "LATERAL",
  "RETURNING",
  "ON CONFLICT",
  "UPSERT",
  "ANALYZE",
  "VACUUM",
  "MATERIALIZED VIEW",
  "INDEX",
  "FUNCTION",
  "TRIGGER",
  "COPY",
  "HAVING",
  "WINDOW",
  "ORDER BY",
  "GROUP BY",
] as const;

const POSTGRESQL_COMPATIBLE_KEYWORDS = mergeUniqueStrings(
  BASE_SQL_COMPLETION_KEYWORDS,
  POSTGRESQL_COMPATIBLE_KEYWORD_OVERLAYS,
);

const POSTGRESQL_COMPATIBLE_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
  "ARRAY_AGG",
  "CURRENT_DATE",
  "CURRENT_CATALOG",
  "CURRENT_SCHEMA",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_USER",
  "GENERATE_SERIES",
  "JSONB_AGG",
  "JSONB_BUILD_OBJECT",
  "JSON_BUILD_OBJECT",
  "REGEXP_REPLACE",
  "STRING_AGG",
]);

const POSTGRESQL_COMPATIBLE_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>([
  "NULL",
  "TRUE",
  "FALSE",
]);

const POSTGRESQL_COMPATIBLE_TYPE_SPECS: Readonly<
  Record<string, DatabaseSqlTypeSpec>
> = {
  SMALLINT: { canonical: "SMALLINT", paramsMin: 0, paramsMax: 0 },
  INTEGER: { canonical: "INTEGER", paramsMin: 0, paramsMax: 0 },
  BIGINT: { canonical: "BIGINT", paramsMin: 0, paramsMax: 0 },
  NUMERIC: { canonical: "NUMERIC", paramsMin: 1, paramsMax: 2 },
  DECIMAL: { canonical: "DECIMAL", paramsMin: 1, paramsMax: 2 },
  REAL: { canonical: "REAL", paramsMin: 0, paramsMax: 0 },
  "DOUBLE PRECISION": {
    canonical: "DOUBLE PRECISION",
    paramsMin: 0,
    paramsMax: 0,
  },
  BOOLEAN: { canonical: "BOOLEAN", paramsMin: 0, paramsMax: 0 },
  SERIAL: { canonical: "SERIAL", paramsMin: 0, paramsMax: 0 },
  BIGSERIAL: { canonical: "BIGSERIAL", paramsMin: 0, paramsMax: 0 },
  SMALLSERIAL: { canonical: "SMALLSERIAL", paramsMin: 0, paramsMax: 0 },
  CHAR: { canonical: "CHAR", paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
  VARCHAR: {
    canonical: "VARCHAR",
    paramsMin: 1,
    paramsMax: 1,
    warnIfNoLength: true,
  },
  CHARACTER: {
    canonical: "CHARACTER",
    paramsMin: 1,
    paramsMax: 1,
    warnIfNoLength: true,
  },
  "CHARACTER VARYING": {
    canonical: "CHARACTER VARYING",
    paramsMin: 1,
    paramsMax: 1,
    warnIfNoLength: true,
  },
  TEXT: { canonical: "TEXT", paramsMin: 0, paramsMax: 0 },
  DATE: { canonical: "DATE", paramsMin: 0, paramsMax: 0 },
  TIME: { canonical: "TIME", paramsMin: 0, paramsMax: 1 },
  TIMESTAMP: { canonical: "TIMESTAMP", paramsMin: 0, paramsMax: 1 },
  TIMESTAMPTZ: { canonical: "TIMESTAMPTZ", paramsMin: 0, paramsMax: 1 },
  "TIMESTAMP WITH TIME ZONE": {
    canonical: "TIMESTAMP WITH TIME ZONE",
    paramsMin: 0,
    paramsMax: 0,
  },
  "TIMESTAMP WITHOUT TIME ZONE": {
    canonical: "TIMESTAMP WITHOUT TIME ZONE",
    paramsMin: 0,
    paramsMax: 0,
  },
  JSON: { canonical: "JSON", paramsMin: 0, paramsMax: 0 },
  BYTEA: { canonical: "BYTEA", paramsMin: 0, paramsMax: 0 },
  UUID: { canonical: "UUID", paramsMin: 0, paramsMax: 0 },
  JSONB: { canonical: "JSONB", paramsMin: 0, paramsMax: 0 },
  XML: { canonical: "XML", paramsMin: 0, paramsMax: 0 },
};

const POSTGRESQL_COMPATIBLE_SIGNATURE_OVERLAYS = new Map<
  string,
  readonly DatabaseSqlFunctionSignature[]
>([
  [
    "COUNT",
    [
      {
        name: "COUNT",
        parameters: ["expression"],
        description:
          "Returns the number of input rows where the expression is not null.",
      },
    ],
  ],
  [
    "COALESCE",
    [
      {
        name: "COALESCE",
        parameters: ["value1", "value2", "..."],
        description: "Returns the first non-null argument.",
      },
    ],
  ],
  [
    "NOW",
    [
      {
        name: "NOW",
        parameters: [],
        description: "Returns the current timestamp with time zone.",
      },
    ],
  ],
  [
    "ARRAY_AGG",
    [
      {
        name: "ARRAY_AGG",
        parameters: ["expression"],
        description: "Aggregates input values into a PostgreSQL array.",
      },
    ],
  ],
  [
    "DATE_TRUNC",
    [
      {
        name: "DATE_TRUNC",
        parameters: ["precision", "source"],
        description:
          "Truncates a timestamp or interval to the requested precision.",
      },
    ],
  ],
  [
    "GENERATE_SERIES",
    [
      {
        name: "GENERATE_SERIES",
        parameters: ["start", "stop", "step?"],
        description:
          "Set-returning function that generates a numeric or timestamp series.",
      },
    ],
  ],
  [
    "JSONB_BUILD_OBJECT",
    [
      {
        name: "JSONB_BUILD_OBJECT",
        parameters: ["key1", "value1", "..."],
        description: "Builds a JSONB object from alternating key/value pairs.",
      },
    ],
  ],
  [
    "STRING_AGG",
    [
      {
        name: "STRING_AGG",
        parameters: ["expression", "delimiter"],
        description:
          "Concatenates grouped values using the supplied delimiter.",
      },
    ],
  ],
]);

const postgresqlCompatibleFormatterProfile = extendFormatterProfile(
  BASE_SQL_FORMATTER_PROFILE,
  {
    keywords: POSTGRESQL_COMPATIBLE_KEYWORD_OVERLAYS,
    clauseKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "RETURNING"],
    newlineBeforeKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "RETURNING"],
    joinModifiers: ["LATERAL"],
  },
);

const postgresqlCompatibleValidationProfile: DatabaseSqlValidationProfile = {
  builtinFunctions: mergeStringSets(
    BASE_SQL_BUILTIN_FUNCTIONS,
    POSTGRESQL_COMPATIBLE_BUILTIN_FUNCTION_OVERLAYS,
  ),
  systemColumns: new Set(["CTID", "TABLEOID", "XMIN", "XMAX", "CMIN", "CMAX"]),
  specialBuiltinValues: mergeStringSets(
    BASE_SQL_SPECIAL_BUILTIN_VALUES,
    POSTGRESQL_COMPATIBLE_SPECIAL_BUILTIN_VALUE_OVERLAYS,
  ),
  getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
    if (!typeName) return undefined;
    return POSTGRESQL_COMPATIBLE_TYPE_SPECS[typeName.trim().toUpperCase()];
  },
  supportsProcedureAnySizeArgument(): boolean {
    return false;
  },
  syntaxValidationMode: "bestEffort",
};

export const postgresqlCompatibleSqlAuthoring: DatabaseSqlAuthoring = {
  completionKeywords: POSTGRESQL_COMPATIBLE_KEYWORDS,
  signatures: mergeFunctionSignatures(
    BASE_SQL_FUNCTION_SIGNATURES,
    POSTGRESQL_COMPATIBLE_SIGNATURE_OVERLAYS,
  ),
  formatter: postgresqlCompatibleFormatterProfile,
  validation: postgresqlCompatibleValidationProfile,
  qualityRules: [],
};
