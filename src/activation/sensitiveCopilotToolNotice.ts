import * as vscode from 'vscode';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../compatibility/state';

const OPEN_SETTINGS_ACTION = 'Open Settings';

/**
 * Explains the one-time security change that makes database-data tools opt-in.
 */
export async function showSensitiveCopilotToolNotice(context: vscode.ExtensionContext): Promise<void> {
    const hasShownNotice = getMementoValue(
        context.globalState,
        compatibilityStateKeys.copilotSensitiveToolsNoticeShown,
        false,
    );
    if (hasShownNotice) {
        return;
    }

    await updateMementoValue(context.globalState, compatibilityStateKeys.copilotSensitiveToolsNoticeShown, true);
    const selectedAction = await vscode.window.showInformationMessage(
        'Security update: AI access to Execute SQL Query and Get Sample Data is now disabled by default to protect database data. Enable the tools explicitly in JustyBase AI settings if you want to use them.',
        OPEN_SETTINGS_ACTION,
    );

    if (selectedAction === OPEN_SETTINGS_ACTION) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'justybase.copilot.tools');
    }
}
