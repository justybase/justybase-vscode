import * as vscode from 'vscode';

interface RawNotebookCell {
    language: string;
    value: string;
    kind: vscode.NotebookCellKind;
}

interface RawNotebookData {
    cells: RawNotebookCell[];
}

export class NetezzaSqlNotebookSerializer implements vscode.NotebookSerializer {
    label = 'Netezza SQL Notebook Serializer';

    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken,
    ): Promise<vscode.NotebookData> {
        let cells: RawNotebookCell[] = [];

        const text = new TextDecoder().decode(content).trim();
        if (text.length > 0) {
            try {
                const data = JSON.parse(text) as RawNotebookData;
                cells = data.cells ?? [];
            } catch {
                cells = [{
                    language: 'sql',
                    value: `-- Failed to parse notebook content.\n-- Raw content:\n${text.slice(0, 2000)}`,
                    kind: vscode.NotebookCellKind.Code,
                }];
            }
        }

        if (cells.length === 0) {
            cells.push({
                language: 'sql',
                value: '-- Write your SQL here\nSELECT 1;',
                kind: vscode.NotebookCellKind.Code,
            });
        }

        const notebookCells = cells.map((cell) => {
            const language = cell.kind === vscode.NotebookCellKind.Markup
                ? 'markdown'
                : cell.language || 'sql';
            return new vscode.NotebookCellData(
                cell.kind ?? vscode.NotebookCellKind.Code,
                cell.value,
                language,
            );
        });

        return new vscode.NotebookData(notebookCells);
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken,
    ): Promise<Uint8Array> {
        const cells: RawNotebookCell[] = data.cells.map((cell) => ({
            language: cell.languageId,
            value: cell.value,
            kind: cell.kind,
        }));

        const raw: RawNotebookData = { cells };
        const text = JSON.stringify(raw, null, 2);
        return new TextEncoder().encode(text);
    }
}
