/**
 * Unit tests for ddl/helpers.ts
 */

import {
    quoteNameIfNeeded,
    parseConnectionString,
    fixProcReturnType
} from '../ddl/helpers';

describe('ddl/helpers', () => {
    describe('quoteNameIfNeeded', () => {
        it('should return empty string unchanged', () => {
            expect(quoteNameIfNeeded('')).toBe('');
        });

        it('should not quote simple uppercase identifier', () => {
            expect(quoteNameIfNeeded('MYTABLE')).toBe('MYTABLE');
        });

        it('should not quote identifier with underscores and numbers', () => {
            expect(quoteNameIfNeeded('MY_TABLE_123')).toBe('MY_TABLE_123');
        });

        it('should quote lowercase identifiers', () => {
            expect(quoteNameIfNeeded('mytable')).toBe('"mytable"');
        });

        it('should quote mixed case identifiers', () => {
            expect(quoteNameIfNeeded('MyTable')).toBe('"MyTable"');
        });

        it('should quote identifiers with spaces', () => {
            expect(quoteNameIfNeeded('MY TABLE')).toBe('"MY TABLE"');
        });

        it('should quote identifiers with special characters', () => {
            expect(quoteNameIfNeeded('MY-TABLE')).toBe('"MY-TABLE"');
            expect(quoteNameIfNeeded('MY.TABLE')).toBe('"MY.TABLE"');
        });

        it('should double internal quotes', () => {
            expect(quoteNameIfNeeded('MY"TABLE')).toBe('"MY""TABLE"');
        });

        it('should handle identifier starting with number', () => {
            expect(quoteNameIfNeeded('123TABLE')).toBe('"123TABLE"');
        });
    });

    describe('parseConnectionString', () => {
        it('should parse full connection string', () => {
            const connStr = 'DRIVER={NetezzaSQL};SERVER=myhost;PORT=5480;DATABASE=mydb;UID=admin;PWD=secret;';
            const result = parseConnectionString(connStr);
            expect(result).toEqual({
                host: 'myhost',
                port: 5480,
                database: 'mydb',
                user: 'admin',
                password: 'secret'
            });
        });

        it('should handle connection string without trailing semicolon', () => {
            const connStr = 'SERVER=host;PORT=5480;DATABASE=db;UID=user;PWD=pass';
            const result = parseConnectionString(connStr);
            expect(result).toEqual({
                host: 'host',
                port: 5480,
                database: 'db',
                user: 'user',
                password: 'pass'
            });
        });

        it('should handle partial connection string', () => {
            const connStr = 'SERVER=myhost;DATABASE=mydb';
            const result = parseConnectionString(connStr);
            expect(result.host).toBe('myhost');
            expect(result.database).toBe('mydb');
            expect(result.port).toBeUndefined();
        });

        it('should be case-insensitive for keys', () => {
            const connStr = 'server=host;port=1234;database=db;uid=user;pwd=pass';
            const result = parseConnectionString(connStr);
            expect(result.host).toBe('host');
            expect(result.port).toBe(1234);
        });

        it('should handle empty string', () => {
            const result = parseConnectionString('');
            expect(result).toEqual({});
        });

        it('should handle values with equals signs', () => {
            // Password with = in it
            const connStr = 'SERVER=host;PWD=pass=word=123';
            const result = parseConnectionString(connStr);
            expect(result.password).toBe('pass=word=123');
        });
    });

    describe('fixProcReturnType', () => {
        it('should return empty string unchanged', () => {
            expect(fixProcReturnType('')).toBe('');
        });

        it('should fix CHARACTER VARYING without length', () => {
            expect(fixProcReturnType('CHARACTER VARYING')).toBe('CHARACTER VARYING(ANY)');
        });

        it('should fix NATIONAL CHARACTER VARYING', () => {
            expect(fixProcReturnType('NATIONAL CHARACTER VARYING')).toBe('NATIONAL CHARACTER VARYING(ANY)');
        });

        it('should fix NATIONAL CHARACTER', () => {
            expect(fixProcReturnType('NATIONAL CHARACTER')).toBe('NATIONAL CHARACTER(ANY)');
        });

        it('should fix CHARACTER', () => {
            expect(fixProcReturnType('CHARACTER')).toBe('CHARACTER(ANY)');
        });

        it('should not modify types with explicit length', () => {
            expect(fixProcReturnType('CHARACTER VARYING(255)')).toBe('CHARACTER VARYING(255)');
            expect(fixProcReturnType('CHARACTER(10)')).toBe('CHARACTER(10)');
        });

        it('should not modify other types', () => {
            expect(fixProcReturnType('INTEGER')).toBe('INTEGER');
            expect(fixProcReturnType('NUMERIC(10,2)')).toBe('NUMERIC(10,2)');
            expect(fixProcReturnType('BOOLEAN')).toBe('BOOLEAN');
        });

        it('should handle case insensitivity', () => {
            expect(fixProcReturnType('character varying')).toBe('CHARACTER VARYING(ANY)');
            expect(fixProcReturnType('Character Varying')).toBe('CHARACTER VARYING(ANY)');
        });

        it('should handle whitespace', () => {
            expect(fixProcReturnType('  CHARACTER VARYING  ')).toBe('CHARACTER VARYING(ANY)');
        });
    });
});
