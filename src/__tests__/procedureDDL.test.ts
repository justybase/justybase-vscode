/**
 * Unit tests for ddl/procedureDDL.ts - buildProcedureDDLFromCache function
 */

import { buildProcedureDDLFromCache } from '../ddl/procedureDDL';
import { ProcedureInfo } from '../ddl/types';

function makeProcInfo(overrides: Partial<ProcedureInfo> = {}): ProcedureInfo {
    return {
        schema: 'ADMIN',
        procedureSource: '  v_count INT;\nBEGIN\n  SELECT COUNT(*) INTO v_count FROM MY_TABLE;\nEND;',
        objId: 42,
        returns: 'INTEGER',
        executeAsOwner: false,
        description: null,
        procedureSignature: 'MY_PROC()',
        procedureName: 'MY_PROC',
        arguments: null,
        ...overrides
    };
}

describe('ddl/procedureDDL', () => {
    describe('buildProcedureDDLFromCache', () => {
        it('should generate correct CREATE OR REPLACE PROCEDURE header', () => {
            const ddl = buildProcedureDDLFromCache('MYDB', 'ADMIN', makeProcInfo());

            expect(ddl).toContain('CREATE OR REPLACE PROCEDURE MYDB.ADMIN.MY_PROC');
        });

        it('should add empty parens when arguments is null', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ arguments: null }));

            expect(ddl).toContain('MY_PROC()');
        });

        it('should include arguments when provided without parens', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ arguments: 'p_id INT, p_name VARCHAR(100)' }));

            expect(ddl).toContain('MY_PROC(p_id INT, p_name VARCHAR(100))');
        });

        it('should not double-wrap arguments that already have parens', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ arguments: '(p_id INT)' }));

            expect(ddl).toContain('MY_PROC(p_id INT)');
            // Should NOT have double parens
            expect(ddl).not.toContain('MY_PROC((p_id INT))');
        });

        it('should include RETURNS clause', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ returns: 'VOID' }));

            expect(ddl).toContain('RETURNS VOID');
        });

        it('should use EXECUTE AS CALLER by default', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ executeAsOwner: false }));

            expect(ddl).toContain('EXECUTE AS CALLER');
            expect(ddl).not.toContain('EXECUTE AS OWNER');
        });

        it('should use EXECUTE AS OWNER when executeAsOwner is true', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ executeAsOwner: true }));

            expect(ddl).toContain('EXECUTE AS OWNER');
            expect(ddl).not.toContain('EXECUTE AS CALLER');
        });

        it('should include LANGUAGE NZPLSQL AS with BEGIN_PROC/END_PROC', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo());

            expect(ddl).toContain('LANGUAGE NZPLSQL AS');
            expect(ddl).toContain('BEGIN_PROC');
            expect(ddl).toContain('END_PROC;');
        });

        it('should include procedure source body', () => {
            const source = 'BEGIN\n  RAISE NOTICE \'hello\';\nEND;';
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ procedureSource: source }));

            expect(ddl).toContain(source);
        });

        it('should not include COMMENT when description is null', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ description: null }));

            expect(ddl).not.toContain('COMMENT ON');
        });

        it('should add COMMENT ON PROCEDURE when description is provided', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ description: 'My procedure' }));

            expect(ddl).toContain("COMMENT ON PROCEDURE MY_PROC IS 'My procedure';");
        });

        it('should escape single quotes in description', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo({ description: "O'Brien's procedure" }));

            expect(ddl).toContain("COMMENT ON PROCEDURE MY_PROC IS 'O''Brien''s procedure';");
        });

        it('should quote identifiers that need quoting', () => {
            const ddl = buildProcedureDDLFromCache('my-db', 'my-schema', makeProcInfo({ procedureName: 'my-proc' }));

            expect(ddl).toContain('"my-db"."my-schema"."my-proc"');
        });

        it('should handle procedure with all fields set', () => {
            const procInfo = makeProcInfo({
                arguments: 'p1 INT, p2 VARCHAR(50)',
                returns: 'TABLE(id INT, val VARCHAR(50))',
                executeAsOwner: true,
                description: 'Full featured procedure'
            });

            const ddl = buildProcedureDDLFromCache('PROD', 'DWH', procInfo);

            expect(ddl).toContain('CREATE OR REPLACE PROCEDURE PROD.DWH.MY_PROC(p1 INT, p2 VARCHAR(50))');
            expect(ddl).toContain('RETURNS TABLE(id INT, val VARCHAR(50))');
            expect(ddl).toContain('EXECUTE AS OWNER');
            expect(ddl).toContain('LANGUAGE NZPLSQL AS');
            expect(ddl).toContain('BEGIN_PROC');
            expect(ddl).toContain('END_PROC;');
            expect(ddl).toContain("COMMENT ON PROCEDURE MY_PROC IS 'Full featured procedure';");
        });

        it('should put BEGIN_PROC and END_PROC on their own lines', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo());
            const lines = ddl.split('\n');

            expect(lines.some(line => line.trim() === 'BEGIN_PROC')).toBe(true);
            expect(lines.some(line => line.trim() === 'END_PROC;')).toBe(true);
        });

        it('should produce correct overall structure with line order', () => {
            const ddl = buildProcedureDDLFromCache('DB', 'S', makeProcInfo());

            const procIdx = ddl.indexOf('CREATE OR REPLACE PROCEDURE');
            const returnsIdx = ddl.indexOf('RETURNS INTEGER');
            const execIdx = ddl.indexOf('EXECUTE AS');
            const langIdx = ddl.indexOf('LANGUAGE NZPLSQL AS');
            const beginIdx = ddl.indexOf('BEGIN_PROC');
            const endIdx = ddl.indexOf('END_PROC;');

            expect(procIdx).toBeLessThan(returnsIdx);
            expect(returnsIdx).toBeLessThan(execIdx);
            expect(execIdx).toBeLessThan(langIdx);
            expect(langIdx).toBeLessThan(beginIdx);
            expect(beginIdx).toBeLessThan(endIdx);
        });
    });
});
