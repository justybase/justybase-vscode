import type { DatabaseSqlTypeSpec } from '../../../sql/authoring/types';

const DUCKDB_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
  BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
  BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 0 },
  BOOLEAN: { canonical: 'BOOLEAN', paramsMin: 0, paramsMax: 0 },
  DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
  DECIMAL: { canonical: 'DECIMAL', paramsMin: 0, paramsMax: 2 },
  DOUBLE: { canonical: 'DOUBLE', paramsMin: 0, paramsMax: 0 },
  HUGEINT: { canonical: 'HUGEINT', paramsMin: 0, paramsMax: 0 },
  INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
  INTERVAL: { canonical: 'INTERVAL', paramsMin: 0, paramsMax: 0 },
  JSON: { canonical: 'JSON', paramsMin: 0, paramsMax: 0 },
  LIST: { canonical: 'LIST', paramsMin: 1, paramsMax: 1 },
  MAP: { canonical: 'MAP', paramsMin: 2, paramsMax: 2 },
  REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 0 },
  SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
  STRUCT: { canonical: 'STRUCT', paramsMin: 1, paramsMax: Number.POSITIVE_INFINITY },
  TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 1 },
  TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 },
  TIMESTAMPTZ: { canonical: 'TIMESTAMPTZ', paramsMin: 0, paramsMax: 1 },
  TIMETZ: { canonical: 'TIMETZ', paramsMin: 0, paramsMax: 1 },
  TINYINT: { canonical: 'TINYINT', paramsMin: 0, paramsMax: 0 },
  UBIGINT: { canonical: 'UBIGINT', paramsMin: 0, paramsMax: 0 },
  UINTEGER: { canonical: 'UINTEGER', paramsMin: 0, paramsMax: 0 },
  UHUGEINT: { canonical: 'UHUGEINT', paramsMin: 0, paramsMax: 0 },
  USMALLINT: { canonical: 'USMALLINT', paramsMin: 0, paramsMax: 0 },
  UTINYINT: { canonical: 'UTINYINT', paramsMin: 0, paramsMax: 0 },
  UUID: { canonical: 'UUID', paramsMin: 0, paramsMax: 0 },
  VARCHAR: { canonical: 'VARCHAR', paramsMin: 0, paramsMax: 1 },
};

export function getDuckDbTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
  if (!typeName) {
    return undefined;
  }

  const normalized = typeName.trim().toUpperCase();
  const base = normalized.replace(/\s*\(.*\)$/, '').trim();
  if (base === 'INT' || base === 'INT4') {
    return DUCKDB_TYPE_SPECS.INTEGER;
  }
  if (base === 'FLOAT' || base === 'FLOAT4') {
    return DUCKDB_TYPE_SPECS.REAL;
  }
  if (base === 'FLOAT8') {
    return DUCKDB_TYPE_SPECS.DOUBLE;
  }
  if (base === 'STRING' || base === 'TEXT') {
    return DUCKDB_TYPE_SPECS.VARCHAR;
  }
  if (base === 'NUMERIC') {
    return DUCKDB_TYPE_SPECS.DECIMAL;
  }
  return DUCKDB_TYPE_SPECS[base];
}

export function supportsDuckDbProcedureAnySizeArgument(): boolean {
  return false;
}
