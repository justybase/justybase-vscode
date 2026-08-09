import { describe, expect, it } from '@jest/globals';
import { getDatabaseSqlAuthoring } from '../core/sqlAuthoringRegistry';
import { resolveSqlParsingRuntime } from '../sqlParser/parsingRuntime';

describe('DuckDB SQL authoring', () => {
  it('exposes DuckDB-native types, built-ins, signatures and strict validation', () => {
    const authoring = getDatabaseSqlAuthoring('duckdb');

    expect(authoring.validation.databaseKind).toBe('duckdb');
    expect(authoring.validation.syntaxValidationMode).toBe('strict');
    expect(authoring.validation.getTypeSpec('HUGEINT')?.canonical).toBe('HUGEINT');
    expect(authoring.validation.getTypeSpec('INT')?.canonical).toBe('INTEGER');
    expect(authoring.validation.getTypeSpec('TIMESTAMPTZ')?.canonical).toBe('TIMESTAMPTZ');
    expect(authoring.validation.builtinFunctions.has('READ_PARQUET')).toBe(true);
    expect(authoring.validation.builtinFunctions.has('STRPTIME')).toBe(true);
    expect(authoring.validation.builtinFunctions.has('JSONB_BUILD_OBJECT')).toBe(false);
    expect(authoring.signatures.get('READ_CSV')?.[0].parameters).toEqual(['path', 'options...']);
    expect(authoring.completionKeywords).toEqual(expect.arrayContaining(['QUALIFY', 'PIVOT', 'USING SAMPLE']));
    expect(authoring.staticAssets?.grammarPath).toBe('dialects/duckdb/syntaxes/duckdb.tmLanguage.json');
    expect(authoring.parsing?.parserModulePath).toBe('src/dialects/duckdb/sql/parser.ts');
  });

  it('keeps File SQL authoring separate while reusing DuckDB syntax assets', () => {
    const duckdb = getDatabaseSqlAuthoring('duckdb');
    const file = getDatabaseSqlAuthoring('file');

    expect(file).not.toBe(duckdb);
    expect(file.validation.databaseKind).toBe('file');
    expect(file.parsing?.parserModulePath).toBe(duckdb.parsing?.parserModulePath);
  });

  it('resolves the same parser runtime through both authoring profiles', () => {
    expect(resolveSqlParsingRuntime({ authoring: getDatabaseSqlAuthoring('duckdb') }).id).toBe('duckdb');
    expect(resolveSqlParsingRuntime({ authoring: getDatabaseSqlAuthoring('file') }).id).toBe('duckdb');
  });
});
