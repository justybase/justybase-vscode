import * as vscode from 'vscode';
import { disposeSharedOutputChannel, ensureSharedOutputChannel } from '../core/queryRunner';

describe('queryRunner shared output channel disposal', () => {
    it('creates and disposes shared output channel without throwing', () => {
        const mockChannel = {
            dispose: jest.fn(),
            appendLine: jest.fn(),
            show: jest.fn()
        } as unknown as vscode.OutputChannel;

        const typedWindow = vscode.window as unknown as { createOutputChannel(name: string): vscode.OutputChannel };
        const spy = jest.spyOn(typedWindow, 'createOutputChannel').mockReturnValue(mockChannel);

        // Ensure the shared channel is created
        const ch = ensureSharedOutputChannel();
        expect(ch).toBe(mockChannel);

        // Dispose via exported helper
        expect(() => disposeSharedOutputChannel()).not.toThrow();
        expect(mockChannel.dispose).toHaveBeenCalled();

        spy.mockRestore();
    });
});
