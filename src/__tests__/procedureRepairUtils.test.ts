import {
    buildProcedureCall,
    extractProcedureIdentity,
    findProcedureTarget,
    formatProcedureCallArgument,
} from '../services/copilot/tools/procedureRepairUtils';

describe('procedure repair utilities', () => {
    it('extracts CREATE and CREATE OR REPLACE procedure identities including DB.. notation', () => {
        expect(extractProcedureIdentity('CREATE PROCEDURE ADMIN.P_ONE(INT4) RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;'))
            .toEqual({ name: 'ADMIN.P_ONE', createMode: 'CREATE' });
        expect(extractProcedureIdentity('CREATE OR REPLACE PROCEDURE DB..P_TWO() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;'))
            .toEqual({ name: 'DB..P_TWO', createMode: 'CREATE OR REPLACE' });
    });

    it('builds a CALL from typed values without accepting SQL fragments', () => {
        expect(buildProcedureCall('ADMIN.P_ONE', [
            { type: 'string', value: "O'Reilly" },
            { type: 'number', value: 42 },
            { type: 'boolean', value: true },
            { type: 'null', value: null },
            { type: 'date', value: '2026-09-15' },
            { type: 'timestamp', value: "2026-09-15 10:20:30" }
        ])).toBe("CALL ADMIN.P_ONE('O''Reilly', 42, TRUE, NULL, DATE '2026-09-15', TIMESTAMP '2026-09-15 10:20:30');");
    });

    it('rejects values that do not match their declared type', () => {
        expect(() => formatProcedureCallArgument({ type: 'number', value: '42' as unknown as number })).toThrow('finite number');
        expect(() => formatProcedureCallArgument({ type: 'date', value: '15-09-2026' })).toThrow('YYYY-MM-DD');
        expect(() => formatProcedureCallArgument({ type: 'null', value: 'NULL' as unknown as null })).toThrow('null value');
    });

    it('resolves one editor procedure block by normalized procedure name', () => {
        const blocks = [
            {
                sql: 'CREATE OR REPLACE PROCEDURE ADMIN.P_ONE() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;',
                startOffset: 0,
                endOffset: 108
            },
            {
                sql: 'CREATE OR REPLACE PROCEDURE ADMIN.P_TWO() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 2; END_PROC;',
                startOffset: 109,
                endOffset: 217
            }
        ];

        expect(findProcedureTarget(blocks, 'create or replace procedure admin.p_two() returns int language nzplsql as begin_proc return 3; end_proc;'))
            .toEqual({
                block: blocks[1],
                identity: { name: 'admin.p_two', createMode: 'CREATE OR REPLACE' }
            });
    });
});
