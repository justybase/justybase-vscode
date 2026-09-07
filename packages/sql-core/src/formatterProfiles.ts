import type {
  DatabaseKind,
  DatabaseSqlFormatterProfile,
} from "@justybase/contracts";
import { NETEZZA_SQL_AUTHORING } from "./authoring";

const BASE_FORMATTER_PROFILE: DatabaseSqlFormatterProfile = {
  keywords: new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "HAVING", "LIMIT",
    "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
    "ALTER", "DROP", "TRUNCATE", "TABLE", "VIEW", "DATABASE", "SCHEMA", "SEQUENCE",
    "PROCEDURE", "REPLACE", "TEMP", "TEMPORARY", "EXPLAIN", "VERBOSE", "WITH",
    "RECURSIVE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS",
    "NATURAL", "ONLY", "ON", "AND", "OR", "NOT", "NULL", "NULLS", "IS", "IN",
    "BETWEEN", "LIKE", "ILIKE", "EXISTS", "AS", "DISTINCT", "ALL", "ANY", "SOME",
    "UNION", "INTERSECT", "EXCEPT", "CASE", "WHEN", "THEN", "ELSE", "END", "FETCH",
    "FIRST", "ROW", "ROWS", "RANGE", "OVER", "PARTITION", "ASC", "DESC", "BEGIN",
    "DECLARE", "EXCEPTION", "RETURN", "IF", "ELSIF", "LOOP", "WHILE", "EXIT", "RAISE",
    "CALL", "EXECUTE", "EXEC", "USING", "LANGUAGE", "RETURNS", "COMMENT", "ADD",
    "CONSTRAINT", "PRIMARY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK", "GRANT",
    "REVOKE", "TO", "PUBLIC", "OWNER", "MERGE", "MATCHED",
  ]),
  clauseKeywords: new Set(["SELECT", "FROM", "WHERE", "HAVING", "SET", "VALUES", "ON", "USING"]),
  newlineBeforeKeywords: new Set([
    "SELECT", "FROM", "WHERE", "HAVING", "SET", "VALUES", "ON", "USING", "UNION",
    "INTERSECT", "EXCEPT", "RETURNING", "LIMIT", "OFFSET",
  ]),
  joinModifiers: new Set(["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER"]),
  commaNewlineClauses: new Set(["SELECT", "FROM", "SET", "GROUP", "ORDER", "VALUES"]),
  logicalBreakKeywords: new Set(["AND", "OR"]),
};

function extendFormatterProfile(
  base: DatabaseSqlFormatterProfile,
  overlay: Partial<Record<keyof DatabaseSqlFormatterProfile, readonly string[]>>,
): DatabaseSqlFormatterProfile {
  return {
    keywords: new Set([...base.keywords, ...(overlay.keywords ?? [])]),
    clauseKeywords: new Set([...base.clauseKeywords, ...(overlay.clauseKeywords ?? [])]),
    newlineBeforeKeywords: new Set([
      ...base.newlineBeforeKeywords,
      ...(overlay.newlineBeforeKeywords ?? []),
    ]),
    joinModifiers: new Set([...base.joinModifiers, ...(overlay.joinModifiers ?? [])]),
    commaNewlineClauses: new Set([
      ...base.commaNewlineClauses,
      ...(overlay.commaNewlineClauses ?? []),
    ]),
    logicalBreakKeywords: new Set([
      ...base.logicalBreakKeywords,
      ...(overlay.logicalBreakKeywords ?? []),
    ]),
  };
}

const ACCESS_FORMATTER_PROFILE: DatabaseSqlFormatterProfile = {
  keywords: new Set([
    "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "TABLE", "VIEW",
    "ORDER BY", "GROUP BY", "LIMIT", "TOP", "DISTINCT", "DISTINCTROW", "INNER JOIN",
    "LEFT JOIN", "RIGHT JOIN",
  ]),
  clauseKeywords: new Set(["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT"]),
  newlineBeforeKeywords: new Set(["FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT"]),
  joinModifiers: new Set(["INNER", "LEFT", "RIGHT", "OUTER", "ON"]),
  commaNewlineClauses: new Set(["SELECT"]),
  logicalBreakKeywords: new Set(["AND", "OR"]),
};

const FORMATTER_PROFILES = new Map<string, DatabaseSqlFormatterProfile>([
  ["sqlite", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "ATTACH", "AUTOINCREMENT", "COLLATE", "CONFLICT", "DETACH", "GENERATED", "INDEX",
      "PRAGMA", "REINDEX", "RETURNING", "SAVEPOINT", "STRICT", "TRIGGER", "VACUUM",
      "VIRTUAL", "WINDOW", "WITHOUT",
    ],
    clauseKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "RETURNING", "WINDOW"],
    newlineBeforeKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "RETURNING", "WINDOW"],
  })],
  ["duckdb", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "ASOF", "ANTI", "ATTACH", "FUNCTION", "DETACH", "EXCLUDE", "INCLUDE", "INSTALL",
      "LATERAL", "LOAD", "PIVOT", "PIVOT_LONGER", "PIVOT_WIDER", "QUALIFY", "RENAME",
      "REPEATABLE", "SAMPLE", "SEMI", "TABLESAMPLE", "UNPIVOT", "USE", "WINDOW",
    ],
    clauseKeywords: ["GROUP BY", "HAVING", "QUALIFY", "ORDER BY", "LIMIT", "OFFSET", "USING SAMPLE"],
    newlineBeforeKeywords: ["GROUP BY", "HAVING", "QUALIFY", "ORDER BY", "LIMIT", "OFFSET", "USING SAMPLE"],
    joinModifiers: ["ASOF", "POSITIONAL"],
  })],
  ["file", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: ["READ_JSON", "READ_PARQUET"],
  })],
  ["postgresql", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: ["RETURNING", "FILTER", "WINDOW", "ILIKE", "LATERAL", "MATERIALIZED"],
    clauseKeywords: ["GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "RETURNING", "WINDOW"],
    newlineBeforeKeywords: ["GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "RETURNING", "WINDOW"],
  })],
  ["db2", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "FUNCTION", "TRIGGER", "ALIAS", "INDEX", "IDENTITY", "GENERATED", "ALWAYS", "BY DEFAULT",
      "FETCH FIRST", "OPTIMIZE FOR", "FOR READ ONLY", "FOR UPDATE", "WITH UR", "WITH CS", "WITH RS",
      "WITH RR", "FINAL TABLE", "DECLARE GLOBAL TEMPORARY", "ORGANIZE BY", "DATA CAPTURE",
      "LANGUAGE SQL", "CURRENT SCHEMA", "CURRENT SERVER", "CURRENT DATE", "CURRENT TIME",
      "CURRENT TIMESTAMP", "CURRENT USER",
    ],
    clauseKeywords: ["GROUP BY", "ORDER BY", "FETCH FIRST", "WITH UR", "WITH CS", "OPTIMIZE FOR"],
    newlineBeforeKeywords: ["GROUP BY", "ORDER BY", "FETCH FIRST", "WITH UR", "WITH CS", "OPTIMIZE FOR"],
  })],
  ["mssql", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "OUTPUT", "INDEX", "FUNCTION", "TRIGGER", "TOP", "FETCH NEXT", "CROSS APPLY", "OUTER APPLY",
      "BEGIN TRY", "BEGIN CATCH", "GO",
    ],
    clauseKeywords: ["GROUP BY", "ORDER BY", "OFFSET", "FETCH NEXT", "OUTPUT"],
    newlineBeforeKeywords: ["GROUP BY", "ORDER BY", "OFFSET", "FETCH NEXT", "OUTPUT"],
    joinModifiers: ["APPLY"],
  })],
  ["mysql", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: ["RETURNING", "INDEX", "FUNCTION", "TRIGGER", "EVENT"],
    clauseKeywords: ["GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "RETURNING"],
    newlineBeforeKeywords: ["GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "RETURNING"],
  })],
  ["clickhouse", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: ["PREWHERE", "ARRAY", "FINAL", "SAMPLE", "QUALIFY", "ENGINE", "TTL", "SETTINGS", "OPTIMIZE", "SYSTEM", "KILL", "ASOF"],
    clauseKeywords: ["PREWHERE", "ARRAY JOIN", "QUALIFY", "PARTITION BY", "PRIMARY KEY", "ORDER BY", "SAMPLE BY", "TTL", "SETTINGS", "LIMIT BY", "WITH FILL"],
    newlineBeforeKeywords: ["PREWHERE", "ARRAY JOIN", "QUALIFY", "PARTITION BY", "PRIMARY KEY", "ORDER BY", "SAMPLE BY", "TTL", "SETTINGS", "LIMIT BY", "WITH FILL"],
  })],
  ["oracle", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "FUNCTION", "PACKAGE", "TRIGGER", "SYNONYM", "INDEX", "MATERIALIZED", "COMMIT", "ROLLBACK",
      "SAVEPOINT", "RETURNING", "PIVOT", "UNPIVOT", "CONNECT", "BY", "START", "WITH", "NEXT",
      "PRIOR", "NOCYCLE", "SIBLINGS", "ROWNUM", "DUAL",
    ],
    clauseKeywords: ["GROUP BY", "ORDER BY", "CONNECT BY", "START WITH"],
    newlineBeforeKeywords: ["GROUP BY", "ORDER BY", "CONNECT BY", "START WITH"],
  })],
  ["snowflake", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: ["QUALIFY", "PIVOT", "UNPIVOT", "CLUSTER", "BY", "COPY", "INTO"],
    newlineBeforeKeywords: ["QUALIFY", "PIVOT", "UNPIVOT", "CLUSTER BY", "COPY INTO"],
  })],
  ["vertica", extendFormatterProfile(BASE_FORMATTER_PROFILE, {
    keywords: [
      "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "COPY", "EXPORT", "PROJECTION",
      "FUNCTION", "ANALYZE_STATISTICS", "SEGMENTED", "BY", "UNSEGMENTED", "ALL", "NODES", "KSAFE",
      "PARTITION BY", "PURGE_TABLE",
    ],
    clauseKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET"],
    newlineBeforeKeywords: ["GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET"],
  })],
  ["access", ACCESS_FORMATTER_PROFILE],
]);

export function getSqlFormatterProfile(databaseKind?: DatabaseKind): DatabaseSqlFormatterProfile {
  if (!databaseKind || databaseKind === "netezza") return NETEZZA_SQL_AUTHORING.formatter;
  return FORMATTER_PROFILES.get(databaseKind.toLowerCase()) ?? BASE_FORMATTER_PROFILE;
}
