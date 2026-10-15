import { describe, expect, it, jest } from '@jest/globals';

jest.unmock('chevrotain');

import { getDatabaseSqlAuthoring } from '../../core/sqlAuthoringRegistry';
import { SqlValidator } from '../../sqlParser/validator';
import type { SchemaProvider } from '../../sqlParser/schemaProvider';
import { InMemorySchemaProvider } from '../../sqlParser/schemaProvider';

function codes(result: ReturnType<SqlValidator['validate']>): string[] {
  return [...result.errors, ...result.warnings].map((issue) => issue.code ?? '');
}

describe('DuckDB SQL validation', () => {
  const profile = getDatabaseSqlAuthoring('duckdb').validation;

  it('does not apply Netezza-only distribution advice to DuckDB CTAS', () => {
    const result = new SqlValidator(undefined, profile).validate(
      'CREATE TABLE copy AS SELECT 1 AS id;',
    );

    expect(codes(result)).not.toContain('SQL045');
  });

  it('visits DuckDB WHERE, QUALIFY, and FROM-first query clauses', () => {
    const schema = new InMemorySchemaProvider();
    schema.createTable(undefined, undefined, 't', ['id', 'region']);
    const validator = new SqlValidator(schema, profile);

    const where = validator.validate('SELECT id FROM t WHERE missing = 1;');
    const qualify = validator.validate(
      'SELECT id, row_number() OVER () AS rn FROM t QUALIFY missing = 1;',
    );
    const fromFirst = validator.validate('FROM t SELECT missing;');

    expect(codes(where)).toContain('SQL004');
    expect(codes(qualify)).toContain('SQL004');
    expect(codes(qualify)).not.toContain('SQL022');
    expect(codes(fromFirst)).toContain('SQL004');
  });

  it('carries CREATE OR REPLACE TABLE AS SELECT columns into later statements', () => {
    const validator = new SqlValidator(undefined, profile);
    const result = validator.validate(
      'CREATE OR REPLACE TABLE copy AS SELECT 1 AS id; SELECT copy.id FROM copy;',
    );

    expect(codes(result)).not.toContain('SQL005');
  });

  it('does not suggest Netezza double-dot qualification for DuckDB schema names', () => {
    const schema: SchemaProvider = {
      getTable: () => undefined,
      tableExists: () => false,
      getDatabases: () => ['memory'],
    };
    const result = new SqlValidator(schema, profile).validate(
      'SELECT * FROM memory.t;',
    );

    expect(codes(result)).not.toContain('SQL007');
  });

  it('recognizes DuckDB type aliases and the COLUMNS expression', () => {
    const schema = new InMemorySchemaProvider();
    schema.createTable(undefined, undefined, 't', ['id']);
    const validator = new SqlValidator(schema, profile);
    const result = validator.validate(
      "CREATE TABLE type_aliases (wide INT8, enabled BOOL); SELECT COLUMNS('^id') FROM t;",
    );

    expect(codes(result)).not.toContain('SQL013');
    expect(codes(result)).not.toContain('SQL011');
  });
});
