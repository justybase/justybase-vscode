import * as vscode from 'vscode';
import { showSensitiveCopilotToolNotice } from '../activation/sensitiveCopilotToolNotice';
import { compatibilityStateKeys } from '../compatibility/state';

describe('showSensitiveCopilotToolNotice', () => {
    function createContext(hasShownNotice = false): vscode.ExtensionContext {
        const values: Record<string, unknown> = hasShownNotice
            ? { [compatibilityStateKeys.copilotSensitiveToolsNoticeShown.current]: true }
            : {};
        return {
            globalState: {
                get: jest.fn(<T>(key: string) => values[key] as T | undefined),
                update: jest.fn(async (key: string, value: unknown) => {
                    values[key] = value;
                })
            }
        } as unknown as vscode.ExtensionContext;
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('shows the security change once and records that it was shown', async () => {
        const context = createContext();
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);

        await showSensitiveCopilotToolNotice(context);

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining('disabled by default'),
            'Open Settings',
        );
        expect(context.globalState.update).toHaveBeenCalledWith(
            compatibilityStateKeys.copilotSensitiveToolsNoticeShown.current,
            true,
        );
    });

    it('opens the relevant settings section when the user chooses the action', async () => {
        const context = createContext();
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Open Settings');

        await showSensitiveCopilotToolNotice(context);

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.openSettings',
            'justybase.copilot.tools',
        );
    });

    it('does not show the notice again after it has been acknowledged', async () => {
        await showSensitiveCopilotToolNotice(createContext(true));

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
});
