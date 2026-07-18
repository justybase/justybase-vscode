import * as vscode from 'vscode';
import { promisify } from 'util';

const mockExecFileAsync = jest.fn();

jest.mock('child_process', () => {
    const execFile = jest.fn();
    Object.defineProperty(execFile, promisify.custom, { value: mockExecFileAsync });
    return { execFile };
});

jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: jest.fn(),
    },
}));

import { createMacroPythonExecutor } from '../core/macroPythonExecutor';

describe('createMacroPythonExecutor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string) => (key === 'pythonArgs' ? ['--configured-flag'] : undefined)),
        });
        mockExecFileAsync.mockResolvedValue({ stdout: 'output', stderr: '' });
    });

    it('preserves configured Python arguments when only the path is overridden', async () => {
        const executor = createMacroPythonExecutor('custom-python');

        await executor('macro.py', ['input.csv']);

        expect(mockExecFileAsync).toHaveBeenCalledWith(
            'custom-python',
            ['--configured-flag', 'macro.py', 'input.csv'],
            expect.any(Object),
        );
    });

    it('allows an explicit empty argument override', async () => {
        const executor = createMacroPythonExecutor('custom-python', []);

        await executor('macro.py', []);

        expect(mockExecFileAsync).toHaveBeenCalledWith('custom-python', ['macro.py'], expect.any(Object));
    });
});
