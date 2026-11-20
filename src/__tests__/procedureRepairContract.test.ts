import { CompileProcedureToolContract } from '../contracts/copilotTools/contracts';

describe('compile_procedure contract', () => {
    it('requires callArguments for compile_and_call', () => {
        const result = CompileProcedureToolContract.validateInput({ mode: 'compile_and_call' });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.errors.some(error => error.field === 'callArguments')).toBe(true);
        }
    });

    it('accepts typed call arguments', () => {
        const result = CompileProcedureToolContract.validateInput({
            mode: 'compile_and_call',
            sql: 'CREATE PROCEDURE ADMIN.P(v INT) RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN v; END_PROC;',
            callArguments: [{ type: 'number', value: 7 }]
        });
        expect(result.success).toBe(true);
    });

    it('rejects malformed call arguments', () => {
        const invalid = CompileProcedureToolContract.validateInput({
            mode: 'compile_and_call',
            callArguments: [{ type: 'number', value: 'seven' }]
        });
        expect(invalid.success).toBe(false);
    });

    it('defaults compilation to compile_only when the mode is supplied', () => {
        expect(CompileProcedureToolContract.validateInput({ mode: 'compile_only' })).toEqual({
            success: true,
            data: { mode: 'compile_only', sql: undefined }
        });
    });
});
