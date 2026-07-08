import * as vscode from 'vscode';

export class NetezzaFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
        const ranges: vscode.FoldingRange[] = [];
        const stack: number[] = [];

        // Regex to match --REGION and --ENDREGION (case insensitive)
        const regionStartRegex = /^\s*--\s*REGION\b/i;
        const regionEndRegex = /^\s*--\s*ENDREGION\b/i;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text;

            if (regionStartRegex.test(text)) {
                stack.push(i);
            } else if (regionEndRegex.test(text)) {
                if (stack.length > 0) {
                    const startLine = stack.pop()!;
                    // Create a folding range from startLine to current line (i)
                    // We fold from the line after the start region to the line before the end region?
                    // Or usually, the region header is visible, and the content + end region is folded?
                    // VS Code's default behavior for #region is to fold everything including the #endregion line usually,
                    // or at least collapse it so you see the header.

                    // vscode.FoldingRange(start, end, kind?)
                    // If we want the header to be visible, start is startLine.
                    // If we want the end marker to be hidden when folded, end is i.

                    ranges.push(new vscode.FoldingRange(startLine, i, vscode.FoldingRangeKind.Region));
                }
            }
        }

        return ranges;
    }
}
