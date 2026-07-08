export interface NetezzaTypeSpec {
  canonical: string;
  paramsMin: number;
  paramsMax: number;
  warnIfNoLength?: boolean;
}

export const normalizeTypeName = (name: string): string =>
  name.toUpperCase().replace(/\s+/g, " ").trim();

const specsByAlias = new Map<string, NetezzaTypeSpec>();

const addType = (
  canonical: string,
  aliases: string[],
  paramsMin: number,
  paramsMax: number,
  warnIfNoLength = false,
): void => {
  const spec: NetezzaTypeSpec = {
    canonical,
    paramsMin,
    paramsMax,
    warnIfNoLength,
  };
  for (const a of aliases) {
    specsByAlias.set(normalizeTypeName(a), spec);
  }
};

// ---------------------------------------------------------------------------
// Core SQL + common Netezza type aliases
// (Extend as needed; we prefer explicit allow-lists to catch typos.)
// ---------------------------------------------------------------------------

addType("BOOLEAN", ["BOOLEAN", "BOOL"], 0, 0);

addType("INT1", ["INT1", "BYTEINT"], 0, 0);
addType("INT2", ["INT2", "SMALLINT", "INT16"], 0, 0);
addType("INT4", ["INT4", "INTEGER", "INT", "INT32"], 0, 0);
addType("INT8", ["INT8", "BIGINT", "INT64"], 0, 0);

addType("FLOAT4", ["FLOAT4", "REAL"], 0, 0);
addType("FLOAT8", ["FLOAT8", "DOUBLE", "DOUBLE PRECISION"], 0, 0);
addType("FLOAT", ["FLOAT"], 0, 1); // FLOAT(p) sometimes allowed

addType("NUMERIC", ["NUMERIC", "DECIMAL"], 0, 2);

addType("CHAR", ["CHAR", "CHARACTER", "FIXED"], 0, 1);
addType("VARCHAR", ["VARCHAR", "CHARACTER VARYING", "VARIABLE"], 0, 1, true);
addType("TEXT", ["TEXT"], 0, 0);

addType("NCHAR", ["NCHAR", "NATIONAL CHARACTER", "NATIONAL_FIXED"], 0, 1);
addType(
  "NVARCHAR",
  ["NVARCHAR", "NATIONAL CHARACTER VARYING", "NATIONAL_VARIABLE"],
  0,
  1,
  true,
);

addType("DATE", ["DATE"], 0, 0);
addType("TIME", ["TIME"], 0, 1);
addType("TIMETZ", ["TIMETZ", "TIME WITH TIME ZONE"], 0, 1);
addType("TIMESTAMP", ["TIMESTAMP"], 0, 1);
addType("TIMESTAMPTZ", ["TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE"], 0, 1);
addType("INTERVAL", ["INTERVAL"], 0, 1);
addType("ABSTIME", ["ABSTIME"], 0, 0);
addType("RELTIME", ["RELTIME"], 0, 0);

addType("OID", ["OID"], 0, 0);

addType("VARBYTE", ["VARBYTE"], 0, 1);
addType("BYTEA", ["BYTEA"], 0, 0);

addType("SERIAL", ["SERIAL"], 0, 0);
addType("BIGSERIAL", ["BIGSERIAL"], 0, 0);

addType("CLOB", ["CLOB"], 0, 1);
addType("NCLOB", ["NCLOB"], 0, 1);
addType("BLOB", ["BLOB"], 0, 1);

export const getNetezzaTypeSpec = (
  typeName: string,
): NetezzaTypeSpec | undefined => {
  if (!typeName) return undefined;
  const normalized = normalizeTypeName(typeName);
  const direct = specsByAlias.get(normalized);
  if (direct) {
    return direct;
  }

  // Accept qualified interval forms such as:
  // INTERVAL HOUR TO MINUTE, INTERVAL DAY TO SECOND, etc.
  if (normalized.startsWith("INTERVAL ")) {
    return specsByAlias.get("INTERVAL");
  }

  return undefined;
};

const PROCEDURE_ANY_SIZE_TEXT_TYPES = new Set([
  "CHAR",
  "VARCHAR",
  "NCHAR",
  "NVARCHAR",
  "TEXT",
]);

export const supportsProcedureAnySizeArgument = (typeName: string): boolean => {
  const spec = getNetezzaTypeSpec(typeName);
  return !!spec && PROCEDURE_ANY_SIZE_TEXT_TYPES.has(spec.canonical);
};
