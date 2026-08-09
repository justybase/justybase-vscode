import type { DatabaseSqlFunctionSignature } from '../../../sql/authoring/types';
import { BASE_SQL_FUNCTION_SIGNATURES, mergeFunctionSignatures } from '../../../sql/authoring/baseProfiles';

const DUCKDB_SIGNATURE_OVERLAYS = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
  ['DATE_TRUNC', [{
    name: 'DATE_TRUNC',
    parameters: ['part', 'date_or_timestamp'],
    description: 'Truncates a date or timestamp to the requested part.',
  }]],
  ['GENERATE_SERIES', [{
    name: 'GENERATE_SERIES',
    parameters: ['start', 'stop', 'step?'],
    description: 'Generates a list or table of values between start and stop.',
  }]],
  ['QUANTILE_CONT', [{
    name: 'QUANTILE_CONT',
    parameters: ['value', 'quantile'],
    description: 'Computes a continuous quantile using interpolation.',
  }]],
  ['READ_CSV', [{
    name: 'READ_CSV',
    parameters: ['path', 'options...'],
    description: 'Reads CSV data as a DuckDB table function.',
  }]],
  ['READ_PARQUET', [{
    name: 'READ_PARQUET',
    parameters: ['path', 'options...'],
    description: 'Reads Parquet data as a DuckDB table function.',
  }]],
  ['REGEXP_REPLACE', [{
    name: 'REGEXP_REPLACE',
    parameters: ['source', 'pattern', 'replacement', 'options?'],
    description: 'Replaces text matching a regular expression.',
  }]],
  ['STRFTIME', [{
    name: 'STRFTIME',
    parameters: ['date_or_timestamp', 'format'],
    description: 'Formats a date or timestamp using a format string.',
  }]],
  ['STRPTIME', [{
    name: 'STRPTIME',
    parameters: ['text', 'format'],
    description: 'Parses text into a timestamp using a format string.',
  }]],
  ['STRUCT_PACK', [{
    name: 'STRUCT_PACK',
    parameters: ['named_values...'],
    description: 'Builds a DuckDB STRUCT from named arguments.',
  }]],
  ['UNNEST', [{
    name: 'UNNEST',
    parameters: ['list_or_struct'],
    description: 'Expands a list or struct into rows or columns.',
  }]],
]);

export const DUCKDB_FUNCTION_SIGNATURES = mergeFunctionSignatures(
  BASE_SQL_FUNCTION_SIGNATURES,
  DUCKDB_SIGNATURE_OVERLAYS,
);
