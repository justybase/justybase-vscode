jest.mock('../commands/validationCommands', () => ({
    createSqlValidatorForDocument: jest.fn(() => ({
        validate: jest.fn(() => ({ errors: [], warnings: [] }))
    }))
}));

import * as vscode from 'vscode';
import { CopilotProcedureRepairService } from '../services/copilot/tools/procedureRepairService';
import type { CopilotToolRuntime } from '../services/copilot/tools/copilotToolRuntime';

const PROCEDURE_SQL = `CREATE OR REPLACE PROCEDURE ADMIN.REPAIR_ME()
RETURNS INT
LANGUAGE NZPLSQL
AS BEGIN_PROC
  RETURN 1;
END_PROC;`;

describe('CopilotProcedureRepairService', () => {
    afterEach(() => {
        (vscode.window.activeTextEditor as unknown as vscode.TextEditor | undefined) = undefined;
        (vscode.window.showWarningMessage as jest.Mock).mockReset();
    });

    it('compiles once in compile_only mode and never executes CALL', async () => {
        const editor = createEditor(PROCEDURE_SQL);
        (vscode.window.activeTextEditor as unknown as vscode.TextEditor) = editor;
        const runtime = createRuntime();
        runtime.executeProcedureStatement.mockResolvedValue({ rowCount: 0, columnNames: [], rowLimitReached: false });

        const result = await new CopilotProcedureRepairService(runtime.instance).repairProcedure({ mode: 'compile_only' });

        expect(runtime.executeProcedureStatement).toHaveBeenCalledTimes(1);
        expect(runtime.executeProcedureStatement).toHaveBeenCalledWith(
            PROCEDURE_SQL,
            'file:///procedure.sql',
            undefined
        );
        expect(result).toContain('"status":"success"');
        expect(result).not.toContain('callExecuted');
    });

    it('requires separate consent before executing a test CALL', async () => {
        const editor = createEditor(PROCEDURE_SQL);
        (vscode.window.activeTextEditor as unknown as vscode.TextEditor) = editor;
        const runtime = createRuntime();
        runtime.executeProcedureStatement.mockResolvedValue({ rowCount: 0, columnNames: [], rowLimitReached: false });
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        const result = await new CopilotProcedureRepairService(runtime.instance).repairProcedure({
            mode: 'compile_and_call',
            callArguments: []
        });

        expect(runtime.executeProcedureStatement).toHaveBeenCalledTimes(1);
        expect((vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0]).toContain('CALL ADMIN.REPAIR_ME();');
        expect(result).toContain('test CALL was not executed');
    });

    it('stops after three compile-and-call attempts', async () => {
        const editor = createEditor(PROCEDURE_SQL);
        (vscode.window.activeTextEditor as unknown as vscode.TextEditor) = editor;
        const runtime = createRuntime();
        const success = { rowCount: 0, columnNames: [], rowLimitReached: false };
        runtime.executeProcedureStatement
            .mockResolvedValueOnce(success)
            .mockRejectedValueOnce(new Error('runtime failure 1'))
            .mockResolvedValueOnce(success)
            .mockRejectedValueOnce(new Error('runtime failure 2'))
            .mockResolvedValueOnce(success)
            .mockRejectedValueOnce(new Error('runtime failure 3'));
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Execute test CALL');
        const service = new CopilotProcedureRepairService(runtime.instance);

        await service.repairProcedure({ mode: 'compile_and_call', callArguments: [] });
        await service.repairProcedure({ mode: 'compile_and_call', sql: PROCEDURE_SQL, callArguments: [] });
        await service.repairProcedure({ mode: 'compile_and_call', sql: PROCEDURE_SQL, callArguments: [] });
        const blocked = await service.repairProcedure({ mode: 'compile_and_call', sql: PROCEDURE_SQL, callArguments: [] });

        expect(runtime.executeProcedureStatement).toHaveBeenCalledTimes(6);
        expect(blocked).toContain('stopped after 3 attempts');
    });
});

function createRuntime(): {
    instance: CopilotToolRuntime;
    executeProcedureStatement: jest.Mock;
} {
    const executeProcedureStatement = jest.fn();
    const instance = {
        executeProcedureStatement,
        formatStructuredToolResponse: jest.fn((payload: { summary: string; data?: unknown; errors?: string[]; nextActions?: string[] }) => JSON.stringify(payload))
    } as unknown as CopilotToolRuntime;
    return { instance, executeProcedureStatement };
}

function createEditor(initialText: string): vscode.TextEditor {
    let text = initialText;
    const documentState = {
        uri: { toString: () => 'file:///procedure.sql' },
        version: 1,
        getText: (range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            return text.slice(offsetAt(text, range.start), offsetAt(text, range.end));
        },
        offsetAt: (position: vscode.Position) => offsetAt(text, position),
        positionAt: (offset: number) => positionAt(text, offset)
    } as unknown as vscode.TextDocument & { version: number };

    const editor = {
        document: documentState,
        selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        edit: jest.fn(async (callback: (builder: { replace: (range: vscode.Range, value: string) => void }) => void) => {
            let replacement: { range: vscode.Range; value: string } | undefined;
            callback({ replace: (range, value) => { replacement = { range, value }; } });
            if (replacement) {
                const start = offsetAt(text, replacement.range.start);
                const end = offsetAt(text, replacement.range.end);
                text = `${text.slice(0, start)}${replacement.value}${text.slice(end)}`;
                documentState.version += 1;
            }
            return true;
        })
    } as unknown as vscode.TextEditor;

    return editor;
}

function offsetAt(text: string, position: vscode.Position): number {
    const lines = text.split('\n');
    let offset = 0;
    for (let index = 0; index < position.line; index++) {
        offset += (lines[index] ?? '').length + 1;
    }
    return offset + position.character;
}

function positionAt(text: string, offset: number): vscode.Position {
    const prefix = text.slice(0, offset);
    const lines = prefix.split('\n');
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}
