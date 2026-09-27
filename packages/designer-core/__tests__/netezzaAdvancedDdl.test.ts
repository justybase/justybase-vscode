import type {
  DatabaseDdlColumnInfo,
  DatabaseExternalTableInfo,
  DatabaseProcedureInfo,
  DatabaseSynonymInfo,
} from '@justybase/contracts';
import { describe, expect, it } from '@jest/globals';
import {
  buildNetezzaExternalTableDdl,
  buildNetezzaProcedureDdl,
  buildNetezzaSynonymDdl,
  fixNetezzaProcedureReturnType,
  reconstructNetezzaExternalLayout,
} from '../src';

const columns: DatabaseDdlColumnInfo[] = [
  { name: 'ID', description: null, fullTypeName: 'INTEGER', notNull: true, defaultValue: null },
  { name: 'Display Name', description: null, fullTypeName: 'VARCHAR(80)', notNull: false, defaultValue: null },
];

const external: DatabaseExternalTableInfo = {
  schema: 'ADMIN',
  tableName: 'EXT_USERS',
  dataObject: "/tmp/user's.csv",
  delimiter: '|',
  encoding: 'INTERNAL',
  timeStyle: null,
  remoteSource: 'LOCAL',
  skipRows: 2,
  maxErrors: 4,
  escapeChar: null,
  logDir: null,
  decimalDelim: null,
  quotedValue: null,
  nullValue: null,
  crInString: null,
  truncString: null,
  ctrlChars: null,
  ignoreZero: null,
  timeExtraZeros: null,
  y2Base: null,
  fillRecord: null,
  compress: null,
  includeHeader: null,
  lfInString: null,
  dateStyle: null,
  dateDelim: null,
  timeDelim: null,
  boolStyle: null,
  format: 'TEXT',
  socketBufSize: null,
  recordDelim: '\r\n',
  maxRows: 100,
  requireQuotes: true,
  recordLength: '1024',
  dateTimeDelim: null,
  rejectFile: null,
  compressionMode: 'zstd',
  layout: 'BYTES 4',
  includeZeroSeconds: false,
  meridianDelim: '.',
};

describe('shared Netezza advanced DDL formatters', () => {
  it('reconstructs ordered external layout zones and preserves null rules', () => {
    expect(reconstructNetezzaExternalLayout(4, [
      { usetype: 'FILLER', name: 'F1', type: 'CHAR(2)', style: 'INTERNAL', length: 'BYTES 2' },
      { name: 'SELECT', type: 'INT4', style: 'DECIMAL', length: 'BYTES 4', nullif: "&&2 = ''" },
      { name: 'DT', type: 'DATE', style: 'YMD', delimiter: '-', length: 'BYTES 10' },
      { name: ' DATE FIELD ', type: 'DATE', style: 'YMD', delimiter: ' ', length: 'BYTES 10' },
    ])).toBe("FILLER F1 CHAR(2) INTERNAL BYTES 2, \"SELECT\" INT4 DECIMAL BYTES 4 NULLIF &&2 = '', DT DATE YMD '-' BYTES 10, \" DATE FIELD \" DATE YMD ' ' BYTES 10");
  });

  it('rejects incomplete external layout catalog metadata', () => {
    expect(() => reconstructNetezzaExternalLayout(2, [
      { type: 'INT4', style: 'DECIMAL', length: 'BYTES 4' },
    ])).toThrow('_V_EXTZONES returned 1');
  });

  it('builds a complete procedure definition and escapes its comment', () => {
    const procedure: DatabaseProcedureInfo = {
      schema: 'ADMIN',
      procedureSource: "BEGIN\n  RAISE NOTICE 'ready';\nEND;",
      objId: 12,
      returns: 'INTEGER',
      executeAsOwner: true,
      description: "Owner's procedure",
      procedureSignature: 'P_USERS(INTEGER)',
      procedureName: 'P_USERS',
      arguments: '(p_id INTEGER)',
    };

    expect(buildNetezzaProcedureDdl('MYDB', 'ADMIN', procedure)).toBe(`CREATE OR REPLACE PROCEDURE MYDB.ADMIN.P_USERS(p_id INTEGER)
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RAISE NOTICE 'ready';
END;
END_PROC;
COMMENT ON PROCEDURE MYDB.ADMIN.P_USERS(INTEGER) IS 'Owner''s procedure';`);
  });

  it('builds external options, preserves zero-like values, and quotes strings', () => {
    const ddl = buildNetezzaExternalTableDdl('MYDB', 'ADMIN', 'EXT_USERS', external, columns);

    expect(ddl).toContain('CREATE EXTERNAL TABLE MYDB.ADMIN.EXT_USERS');
    expect(ddl).toContain("DATAOBJECT('/tmp/user''s.csv')");
    expect(ddl).toContain('SKIPROWS 2');
    expect(ddl).toContain('MAXERRORS 4');
    expect(ddl).toContain("RECORDDELIM '\r\n'");
    expect(ddl).toContain('COMPRESS zstd');
    expect(ddl).toContain('LAYOUT (BYTES 4)');
    expect(ddl).toContain('INCLUDEZEROSECONDS false');
    expect(ddl).toContain("MERIDIANDELIM '.'");
    expect(ddl).toContain('REQUIREQUOTES true');
    expect(ddl).toContain('Display Name');
    expect(ddl.trimEnd().endsWith(');')).toBe(true);
  });

  it('builds a synonym with a multi-part target and escaped comment', () => {
    const synonym: DatabaseSynonymInfo = {
      schema: 'ADMIN',
      synonymName: 'S_USERS',
      referenceObjectName: 'MYDB.ADMIN.USERS',
      owner: 'ADMIN',
      description: "Owner's alias",
    };

    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_USERS', synonym)).toBe(
      "CREATE SYNONYM MYDB.ADMIN.S_USERS FOR MYDB.ADMIN.USERS;\nCOMMENT ON SYNONYM MYDB.ADMIN.S_USERS IS 'Owner''s alias';",
    );
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_DOTTED', {
      ...synonym,
      synonymName: 'S_DOTTED',
      referenceObjectName: '"Target.Name"',
      referenceDatabase: 'OTHERDB',
      referenceSchema: 'Schema.Name',
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_DOTTED FOR OTHERDB."Schema.Name"."Target.Name";');
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_DEFAULT_SCHEMA', {
      ...synonym,
      synonymName: 'S_DEFAULT_SCHEMA',
      referenceObjectName: 'TARGET',
      referenceDatabase: 'OTHERDB',
      referenceSchema: null,
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_DEFAULT_SCHEMA FOR OTHERDB..TARGET;');
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_SCHEMA_ONLY', {
      ...synonym,
      synonymName: 'S_SCHEMA_ONLY',
      referenceObjectName: 'TARGET',
      referenceDatabase: null,
      referenceSchema: 'OTHER_SCHEMA',
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_SCHEMA_ONLY FOR OTHER_SCHEMA.TARGET;');
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_DOUBLE_DOT', {
      ...synonym,
      synonymName: 'S_DOUBLE_DOT',
      referenceObjectName: 'OTHERDB..TARGET',
      referenceDatabase: null,
      referenceSchema: null,
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_DOUBLE_DOT FOR OTHERDB..TARGET;');
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_ESCAPED_QUOTE', {
      ...synonym,
      synonymName: 'S_ESCAPED_QUOTE',
      referenceObjectName: '"A""B".TARGET',
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_ESCAPED_QUOTE FOR "A""B".TARGET;');
    expect(buildNetezzaSynonymDdl('MYDB', 'ADMIN', 'S_SPACED', {
      ...synonym,
      synonymName: 'S_SPACED',
      referenceObjectName: '  " Schema Name " . " Target Name "  ',
      description: null,
    })).toBe('CREATE SYNONYM MYDB.ADMIN.S_SPACED FOR " Schema Name "." Target Name ";');
  });

  it('normalizes only the catalog return spellings that require ANY length', () => {
    expect(fixNetezzaProcedureReturnType('CHARACTER VARYING')).toBe('CHARACTER VARYING(ANY)');
    expect(fixNetezzaProcedureReturnType('VARCHAR(80)')).toBe('VARCHAR(80)');
  });
});
