import { ProcedureRepairToolContract } from '../contracts/copilotTools/contracts';

describe('procedure repair tool contract', () => {
    it('requires typed arguments for compile_and_call', () => {
        const result = ProcedureRepairToolContract.validateInput({ mode: 'compile_and_call' });

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.errors).toEqual(expect.arrayContaining([
                expect.objectContaining({ field: 'callArguments', code: 'REQUIRED' })
            ]));
        }
    });

    it('accepts a no-argument test call and rejects raw SQL-shaped values', () => {
        expect(ProcedureRepairToolContract.validateInput({
            mode: 'compile_and_call',
            callArguments: []
        })).toEqual({
            success: true,
            data: { mode: 'compile_and_call', callArguments: [] }
        });

        const invalid = ProcedureRepairToolContract.validateInput({
            mode: 'compile_and_call',
            callArguments: [{ type: 'string', value: "'x'); DROP TABLE T; --" }]
        });

        expect(invalid.success).toBe(true);
    });

    it('accepts compile_only without CALL arguments', () => {
        expect(ProcedureRepairToolContract.validateInput({ mode: 'compile_only' })).toEqual({
            success: true,
            data: { mode: 'compile_only' }
        });
    });
});
