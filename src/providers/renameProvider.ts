import * as vscode from 'vscode'
import { formatSqlRenameReplacement } from '../sqlParser'
import { resolveExtensionSqlRenameSymbol } from '../core/extensionDocumentParseSession'

export class NetezzaRenameProvider implements vscode.RenameProvider {
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const symbol = resolveExtensionSqlRenameSymbol(document, document.offsetAt(position))
        if (!symbol) {
            return undefined
        }

        return {
            range: this.toDocumentRange(document, symbol.target.startOffset, symbol.target.endOffset),
            placeholder: symbol.name
        }
    }

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {
        const trimmedName = newName.trim()
        if (!trimmedName) {
            return undefined
        }

        const symbol = resolveExtensionSqlRenameSymbol(document, document.offsetAt(position))
        if (!symbol) {
            return undefined
        }

        const edit = new vscode.WorkspaceEdit()
        symbol.occurrences.forEach(occurrence => {
            const range = this.toDocumentRange(document, occurrence.startOffset, occurrence.endOffset)
            edit.replace(document.uri, range, formatSqlRenameReplacement(occurrence.text, trimmedName))
        })

        return edit
    }

    private toDocumentRange(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
        const start = document.positionAt(startOffset)
        const end = document.positionAt(endOffset)
        return new vscode.Range(start, end)
    }
}
