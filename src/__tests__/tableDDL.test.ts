/**
 * Unit tests for ddl/tableDDL.ts - buildTableDDLFromCache function
 */

import { buildTableDDLFromCache } from '../ddl/tableDDL';
import { ColumnInfo, KeyInfo } from '../ddl/types';

describe('ddl/tableDDL', () => {
    describe('buildTableDDLFromCache', () => {
        it('should return error message for empty columns', () => {
            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                [],
                [],
                [],
                new Map(),
                null
            );
            expect(result).toContain('-- Table MYDB.ADMIN.MYTABLE has no columns');
        });

        it('should generate basic CREATE TABLE DDL', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null },
                { name: 'NAME', fullTypeName: 'VARCHAR(100)', notNull: false, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                new Map(),
                null
            );

            expect(result).toContain('CREATE TABLE MYDB.ADMIN.MYTABLE');
            expect(result).toContain('ID INTEGER NOT NULL');
            expect(result).toContain('NAME VARCHAR(100)');
            expect(result).toContain('DISTRIBUTE ON RANDOM');
        });

        it('should include distribution columns', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                ['ID'],
                [],
                new Map(),
                null
            );

            expect(result).toContain('DISTRIBUTE ON (ID)');
            expect(result).not.toContain('DISTRIBUTE ON RANDOM');
        });

        it('should include organize columns', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null },
                { name: 'DATE', fullTypeName: 'DATE', notNull: false, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                ['DATE'],
                new Map(),
                null
            );

            expect(result).toContain('ORGANIZE ON (DATE)');
        });

        it('should include default values', () => {
            const columns: ColumnInfo[] = [
                { name: 'STATUS', fullTypeName: 'INTEGER', notNull: false, defaultValue: '1', description: null },
                { name: 'CREATED', fullTypeName: 'TIMESTAMP', notNull: false, defaultValue: 'CURRENT_TIMESTAMP', description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                new Map(),
                null
            );

            expect(result).toContain('STATUS INTEGER DEFAULT 1');
            expect(result).toContain('CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        });

        it('should include primary key constraint', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null }
            ];

            const keysInfo = new Map<string, KeyInfo>();
            keysInfo.set('PK_MYTABLE', {
                type: 'PRIMARY KEY',
                typeChar: 'p',
                columns: ['ID'],
                pkDatabase: null,
                pkSchema: null,
                pkRelation: null,
                pkColumns: [],
                updateType: 'NO ACTION',
                deleteType: 'NO ACTION'
            });

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                keysInfo,
                null
            );

            expect(result).toContain('ALTER TABLE MYDB.ADMIN.MYTABLE ADD CONSTRAINT PK_MYTABLE PRIMARY KEY (ID)');
        });

        it('should include unique constraint', () => {
            const columns: ColumnInfo[] = [
                { name: 'EMAIL', fullTypeName: 'VARCHAR(255)', notNull: true, defaultValue: null, description: null }
            ];

            const keysInfo = new Map<string, KeyInfo>();
            keysInfo.set('UQ_EMAIL', {
                type: 'UNIQUE',
                typeChar: 'u',
                columns: ['EMAIL'],
                pkDatabase: null,
                pkSchema: null,
                pkRelation: null,
                pkColumns: [],
                updateType: 'NO ACTION',
                deleteType: 'NO ACTION'
            });

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                keysInfo,
                null
            );

            expect(result).toContain('ALTER TABLE MYDB.ADMIN.MYTABLE ADD CONSTRAINT UQ_EMAIL UNIQUE (EMAIL)');
        });

        it('should include foreign key constraint', () => {
            const columns: ColumnInfo[] = [
                { name: 'PARENT_ID', fullTypeName: 'INTEGER', notNull: false, defaultValue: null, description: null }
            ];

            const keysInfo = new Map<string, KeyInfo>();
            keysInfo.set('FK_PARENT', {
                type: 'FOREIGN KEY',
                typeChar: 'f',
                columns: ['PARENT_ID'],
                pkDatabase: 'MYDB',
                pkSchema: 'ADMIN',
                pkRelation: 'PARENT_TABLE',
                pkColumns: ['ID'],
                updateType: 'NO ACTION',
                deleteType: 'CASCADE'
            });

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                keysInfo,
                null
            );

            expect(result).toContain('FOREIGN KEY (PARENT_ID)');
            expect(result).toContain('REFERENCES MYDB.ADMIN.PARENT_TABLE (ID)');
            expect(result).toContain('ON DELETE CASCADE');
            expect(result).toContain('ON UPDATE NO ACTION');
        });

        it('should include table comment', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                new Map(),
                'This is a test table'
            );

            expect(result).toContain("COMMENT ON TABLE MYDB.ADMIN.MYTABLE IS 'This is a test table'");
        });

        it('should escape quotes in table comment', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                [],
                [],
                new Map(),
                "Table with 'quotes' in comment"
            );

            expect(result).toContain("IS 'Table with ''quotes'' in comment'");
        });

        it('should include column comments', () => {
            const columns: ColumnInfo[] = [
                { name: 'ID', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: 'Primary key' },
                { name: 'NAME', fullTypeName: 'VARCHAR(100)', notNull: false, defaultValue: null, description: 'User name' }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'USERS',
                columns,
                [],
                [],
                new Map(),
                null
            );

            expect(result).toContain("COMMENT ON COLUMN MYDB.ADMIN.USERS.ID IS 'Primary key'");
            expect(result).toContain("COMMENT ON COLUMN MYDB.ADMIN.USERS.NAME IS 'User name'");
        });

        it('should quote mixed-case identifiers', () => {
            const columns: ColumnInfo[] = [
                { name: 'MyColumn', fullTypeName: 'INTEGER', notNull: false, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MyDb',
                'MySchema',
                'MyTable',
                columns,
                [],
                [],
                new Map(),
                null
            );

            expect(result).toContain('"MyDb"."MySchema"."MyTable"');
            expect(result).toContain('"MyColumn" INTEGER');
        });

        it('should handle multiple distribution columns', () => {
            const columns: ColumnInfo[] = [
                { name: 'YEAR', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null },
                { name: 'MONTH', fullTypeName: 'INTEGER', notNull: true, defaultValue: null, description: null }
            ];

            const result = buildTableDDLFromCache(
                'MYDB',
                'ADMIN',
                'MYTABLE',
                columns,
                ['YEAR', 'MONTH'],
                [],
                new Map(),
                null
            );

            expect(result).toContain('DISTRIBUTE ON (YEAR, MONTH)');
        });
    });
});
