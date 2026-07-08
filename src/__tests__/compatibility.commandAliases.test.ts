import * as vscode from 'vscode';
import { registerCompatibilityCommandAliases } from '../compatibility/commandAliases';

jest.mock('vscode');

interface MockCommandsApi {
    registerCommand: jest.Mock;
    executeCommand: jest.Mock;
    getCommands?: jest.Mock;
}

describe('compatibility command aliases', () => {
    let commandsApi: MockCommandsApi;

    beforeEach(() => {
        jest.clearAllMocks();
        commandsApi = vscode.commands as unknown as MockCommandsApi;
        commandsApi.registerCommand = jest.fn(() => ({ dispose: jest.fn() }));
        commandsApi.executeCommand = jest.fn();
        commandsApi.getCommands = jest.fn();
    });

    it('returns no aliases when the VS Code API does not expose getCommands', async () => {
        delete commandsApi.getCommands;

        const aliases = await registerCompatibilityCommandAliases();

        expect(aliases).toEqual([]);
        expect(commandsApi.registerCommand).not.toHaveBeenCalled();
    });

	it('returns empty array when no legacy-to-current aliases are needed', async () => {
		commandsApi.getCommands?.mockResolvedValue([
			'netezza.runQuery',
			'netezza.cancelQuery',
			'justybase.cancelQuery',
			'editor.action.formatDocument'
		]);

		const aliases = await registerCompatibilityCommandAliases();

		expect(commandsApi.registerCommand).not.toHaveBeenCalled();
		expect(aliases).toHaveLength(0);
	});
});
