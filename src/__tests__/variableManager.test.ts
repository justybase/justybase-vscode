import * as vscode from 'vscode';
import { VariableManager } from '../etl/utils/variableManager';

describe('VariableManager', () => {
    const getShowInputBoxMock = (): jest.Mock => {
        const windowWithInput = vscode.window as unknown as { showInputBox?: jest.Mock };
        if (!windowWithInput.showInputBox) {
            windowWithInput.showInputBox = jest.fn();
        }
        return windowWithInput.showInputBox;
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('initializes with provided variables', () => {
        const manager = new VariableManager({ region: 'EU', env: 'DEV' });

        expect(manager.get('region')).toBe('EU');
        expect(manager.get('env')).toBe('DEV');
        expect(manager.has('region')).toBe(true);
        expect(manager.getAll()).toEqual({ region: 'EU', env: 'DEV' });
    });

    it('sets and gets values', () => {
        const manager = new VariableManager();

        manager.set('schema', 'PUBLIC');
        manager.set('schema', 'ANALYTICS');

        expect(manager.has('schema')).toBe(true);
        expect(manager.get('schema')).toBe('ANALYTICS');
    });

    it('prompts user and stores value when input is provided', async () => {
        const showInputBox = getShowInputBoxMock();
        showInputBox.mockResolvedValue('orders');
        const manager = new VariableManager();

        const value = await manager.promptForValue('table', 'Table name', 'default_table');

        expect(showInputBox).toHaveBeenCalledWith({
            prompt: 'Table name',
            value: 'default_table',
            placeHolder: 'Value for ${table}',
            ignoreFocusOut: true
        });
        expect(value).toBe('orders');
        expect(manager.get('table')).toBe('orders');
    });

    it('uses fallback prompt text and does not set value when user cancels', async () => {
        const showInputBox = getShowInputBoxMock();
        showInputBox.mockResolvedValue(undefined);
        const manager = new VariableManager();

        const value = await manager.promptForValue('path', '');

        expect(showInputBox).toHaveBeenCalledWith({
            prompt: 'Enter value for path',
            value: '',
            placeHolder: 'Value for ${path}',
            ignoreFocusOut: true
        });
        expect(value).toBeUndefined();
        expect(manager.has('path')).toBe(false);
    });

    it('creates immutable snapshots and merges variables', () => {
        const manager = new VariableManager({ a: '1' });
        const snapshot = manager.snapshot();

        manager.merge({ b: '2', c: '3' });
        snapshot.a = 'changed-in-snapshot';

        expect(manager.getAll()).toEqual({ a: '1', b: '2', c: '3' });
        expect(manager.get('a')).toBe('1');
    });
});
