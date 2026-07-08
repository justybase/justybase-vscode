import type * as vscode from 'vscode';
import { findVisibleQueryFlowEditor } from '../utils/queryFlowEditor';

function createUri(value: string): vscode.Uri {
    return {
        toString: () => value
    } as unknown as vscode.Uri;
}

function createEditor(uriValue: string, viewColumn?: vscode.ViewColumn): vscode.TextEditor {
    return {
        viewColumn,
        document: {
            uri: createUri(uriValue)
        }
    } as unknown as vscode.TextEditor;
}

describe('findVisibleQueryFlowEditor', () => {
    it('prefers the editor in the original source column', () => {
        const uri = createUri('file://query.sql');
        const editors = [
            createEditor('file://query.sql', 2),
            createEditor('file://query.sql', 1)
        ];

        const selected = findVisibleQueryFlowEditor(editors, uri, 1);

        expect(selected).toBe(editors[1]);
    });

    it('falls back to the first matching editor when the preferred column is missing', () => {
        const uri = createUri('file://query.sql');
        const editors = [
            createEditor('file://query.sql', 2),
            createEditor('file://other.sql', 1)
        ];

        const selected = findVisibleQueryFlowEditor(editors, uri, 1);

        expect(selected).toBe(editors[0]);
    });

    it('returns undefined when no matching editor is visible', () => {
        const uri = createUri('file://query.sql');
        const editors = [createEditor('file://other.sql', 1)];

        const selected = findVisibleQueryFlowEditor(editors, uri, 1);

        expect(selected).toBeUndefined();
    });
});
