import * as vscode from 'vscode';
import { VariableInputPanel } from '../views/variableInputPanel';

jest.mock('vscode', () => ({
    window: {
        showInputBox: jest.fn(),
        showWarningMessage: jest.fn()
    }
}));

describe('views/variableInputPanel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should throw when context is missing', async () => {
        await expect(VariableInputPanel.show(['A'], {})).rejects.toThrow('ExtensionContext is required');
    });

    it('should collect values, trim input and save history', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const get = jest.fn().mockReturnValue({});
        const context = { globalState: { get, update } } as unknown as vscode.ExtensionContext;

        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(' 123 ').mockResolvedValueOnce(' abc ');

        const result = await VariableInputPanel.show(['VAR1', 'VAR2'], {}, context);

        expect(result).toEqual({ VAR1: '123', VAR2: 'abc' });
        expect(update).toHaveBeenCalledWith(
            'netezza.variableValues',
            expect.objectContaining({
                VAR1: ['123'],
                VAR2: ['abc']
            })
        );
    });

    it('should retry on empty value and continue after retry confirmation', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const get = jest.fn().mockReturnValue({});
        const context = { globalState: { get, update } } as unknown as vscode.ExtensionContext;

        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('   ').mockResolvedValueOnce('value1');
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Retry');

        const result = await VariableInputPanel.show(['V'], {}, context);
        expect(result).toEqual({ V: 'value1' });
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            "Variable 'V' cannot be empty. Do you want to retry?",
            'Retry',
            'Cancel'
        );
    });

    it('should return undefined when user cancels input', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const context = {
            globalState: { get: jest.fn().mockReturnValue({}), update }
        } as unknown as vscode.ExtensionContext;
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);

        const result = await VariableInputPanel.show(['V'], {}, context);
        expect(result).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });

    it('should use most recent history value over default', async () => {
        const update = jest.fn().mockResolvedValue(undefined);
        const get = jest.fn().mockReturnValue({ V: ['history', 'older'] });
        const context = { globalState: { get, update } } as unknown as vscode.ExtensionContext;
        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('chosen');

        await VariableInputPanel.show(['V'], { V: 'default' }, context);
        expect(vscode.window.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({
                value: 'history'
            })
        );
    });
});

