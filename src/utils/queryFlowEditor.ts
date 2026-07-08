import * as vscode from 'vscode';

export function findVisibleQueryFlowEditor(
    visibleEditors: readonly vscode.TextEditor[],
    uri: vscode.Uri,
    preferredViewColumn?: vscode.ViewColumn
): vscode.TextEditor | undefined {
    const matchingEditors = visibleEditors.filter(editor => editor.document.uri.toString() === uri.toString());
    if (matchingEditors.length === 0) {
        return undefined;
    }

    if (preferredViewColumn !== undefined) {
        const preferredEditor = matchingEditors.find(editor => editor.viewColumn === preferredViewColumn);
        if (preferredEditor) {
            return preferredEditor;
        }
    }

    return matchingEditors[0];
}
