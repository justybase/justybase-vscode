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
  recordDelim: '\\n',
  maxRows: 100,
  requireQuotes: true,
  recordLength: '1024',
  dateTimeDelim: null,
  rejectFile: null,
};

describe('shared Netezza advanced DDL formatters', () => {
  it('builds a complete procedure definition and escapes its comment', () => {
    const procedure: DatabaseProcedureInfo = {
      schema: 'ADMIN',
      procedureSource: "BEGIN\n  RAISE NOTICE 'ready';\nEND;",
      objId: 12,
      returns: 'INTEGER',
      executeAsOwner: true,
      description: "Owner's procedure",
      procedureSignature: 'P_USERS()',
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
COMMENT ON PROCEDURE P_USERS IS 'Owner''s procedure';`);
  });

  it('builds external options, preserves zero-like values, and quotes strings', () => {
    const ddl = buildNetezzaExternalTableDdl('MYDB', 'ADMIN', 'EXT_USERS', external, columns);

    expect(ddl).toContain('CREATE EXTERNAL TABLE MYDB.ADMIN.EXT_USERS');
    expect(ddl).toContain("DATAOBJECT('/tmp/user''s.csv')");
    expect(ddl).toContain('SKIPROWS 2');
    expect(ddl).toContain('MAXERRORS 4');
    expect(ddl).toContain("RECORDDELIM '\\n'");
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
      "CREATE SYNONYM MYDB.ADMIN.S_USERS FOR MYDB.ADMIN.USERS;\nCOMMENT ON SYNONYM S_USERS IS 'Owner''s alias';",
    );
  });

  it('normalizes only the catalog return spellings that require ANY length', () => {
    expect(fixNetezzaProcedureReturnType('CHARACTER VARYING')).toBe('CHARACTER VARYING(ANY)');
    expect(fixNetezzaProcedureReturnType('VARCHAR(80)')).toBe('VARCHAR(80)');
  });
});
