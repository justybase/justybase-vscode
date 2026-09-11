import type { DatabaseDdlColumnInfo, DatabaseDdlKeyInfo } from '@justybase/contracts';
import { describe, expect, it } from '@jest/globals';
import { buildNetezzaTableDdl, buildNetezzaViewDdl } from '../src';

describe('shared Netezza DDL formatter', () => {
  it('preserves the VS Code table DDL output contract', () => {
    const columns: DatabaseDdlColumnInfo[] = [
      { name: 'ID', description: 'Primary key', fullTypeName: 'INTEGER', notNull: true, defaultValue: '0' },
      { name: 'Display Name', description: "Owner's display name", fullTypeName: 'VARCHAR(80)', notNull: false, defaultValue: null },
      { name: 'CREATED', description: null, fullTypeName: 'TIMESTAMP', notNull: false, defaultValue: 'CURRENT_TIMESTAMP' },
    ];
    const keys = new Map<string, DatabaseDdlKeyInfo>([
      ['PK_USERS', {
        type: 'PRIMARY KEY',
        typeChar: 'p',
        columns: ['ID'],
        pkDatabase: null,
        pkSchema: null,
        pkRelation: null,
        pkColumns: [],
        updateType: 'NO ACTION',
        deleteType: 'NO ACTION',
      }],
      ['FK_USERS_OWNER', {
        type: 'FOREIGN KEY',
        typeChar: 'f',
        columns: ['Display Name'],
        pkDatabase: 'MYDB',
        pkSchema: 'ADMIN',
        pkRelation: 'OWNERS',
        pkColumns: ['NAME'],
        updateType: 'NO ACTION',
        deleteType: 'CASCADE',
      }],
    ]);

    expect(buildNetezzaTableDdl(
      'MYDB',
      'ADMIN',
      'USERS',
      columns,
      ['ID', 'Display Name'],
      ['CREATED'],
      keys,
      "Owner's users",
    )).toBe(`CREATE TABLE MYDB.ADMIN.USERS
(
    ID INTEGER NOT NULL DEFAULT 0,
    "Display Name" VARCHAR(80),
    CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
DISTRIBUTE ON (ID, "Display Name")
ORGANIZE ON (CREATED)
;

ALTER TABLE MYDB.ADMIN.USERS ADD CONSTRAINT PK_USERS PRIMARY KEY (ID);
ALTER TABLE MYDB.ADMIN.USERS ADD CONSTRAINT FK_USERS_OWNER FOREIGN KEY ("Display Name") REFERENCES MYDB.ADMIN.OWNERS (NAME) ON DELETE CASCADE ON UPDATE NO ACTION;

COMMENT ON TABLE MYDB.ADMIN.USERS IS 'Owner''s users';
COMMENT ON COLUMN MYDB.ADMIN.USERS.ID IS 'Primary key';
COMMENT ON COLUMN MYDB.ADMIN.USERS."Display Name" IS 'Owner''s display name';`);
  });

  it('uses RANDOM when the catalog has no distribution keys', () => {
    expect(buildNetezzaTableDdl(
      'MYDB',
      'ADMIN',
      'EMPTY_DIST',
      [{ name: 'VALUE', description: null, fullTypeName: 'BIGINT', notNull: false, defaultValue: null }],
      [],
      [],
      new Map(),
      null,
    )).toContain('DISTRIBUTE ON RANDOM');
  });

  it('keeps the canonical view envelope and definition text', () => {
    expect(buildNetezzaViewDdl('MYDB', 'ADMIN', 'V_USERS', 'SELECT ID FROM MYDB.ADMIN.USERS;'))
      .toBe('CREATE OR REPLACE VIEW MYDB.ADMIN.V_USERS AS\nSELECT ID FROM MYDB.ADMIN.USERS;');
  });
});
