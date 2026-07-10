import * as vscode from 'vscode';
import { getExtensionConfiguration } from '../compatibility/configuration';
import {
    createSelectionExecutionCodeActions,
    resolveCodeActionSelectionContext,
    SELECTION_EXECUTION_CODE_ACTION_KIND,
} from './sqlSelectionActionUtils';

export class SqlExecutionCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [SELECTION_EXECUTION_CODE_ACTION_KIND];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
    ): vscode.CodeAction[] {
        const enabled = getExtensionConfiguration('sql').get<boolean>(
            'showSelectionExecutionCodeActions',
            true,
        ) ?? true;
        if (!enabled) {
            return [];
        }

        if (
            context.only
            && !SqlExecutionCodeActionProvider.providedCodeActionKinds.some(kind =>
                kind.contains(context.only!) || context.only!.contains(kind)
            )
        ) {
            return [];
        }

        const selectionContext = resolveCodeActionSelectionContext(document, range);
        if (!selectionContext) {
            return [];
        }

        return createSelectionExecutionCodeActions();
    }
}
