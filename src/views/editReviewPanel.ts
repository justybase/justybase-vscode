import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { EditStatement } from '../results/editStatements';

export type EditReviewChoice = 'save' | 'cancel';

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildScript(statements: EditStatement[]): string {
    return statements.map(statement => `${statement.sql};`).join('\n\n') + '\n';
}

function renderReviewHtml(statements: EditStatement[], targetLabel: string, nonce: string): string {
    const updates = statements.filter(statement => statement.kind === 'update').length;
    const deletes = statements.length - updates;
    const cards = statements.map((statement, index) => `
        <section class="card ${statement.kind}">
            <header>
                <span class="badge">${statement.kind.toUpperCase()}</span>
                <span class="row">Row ${statement.rowIndex + 1}</span>
                <span class="index">#${index + 1}</span>
            </header>
            <pre><code>${escapeHtml(statement.sql)};</code></pre>
        </section>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 20px 96px;
        margin: 0;
    }
    h1 { font-size: 1.3em; margin: 0 0 4px; }
    .target { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
    .summary {
        display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;
    }
    .pill {
        padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .card {
        border: 1px solid var(--vscode-panel-border);
        border-left: 4px solid var(--vscode-focusBorder);
        border-radius: 6px;
        background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
        margin-bottom: 10px;
        overflow: hidden;
    }
    .card.delete { border-left-color: var(--vscode-errorForeground, #f14c4c); }
    .card.update { border-left-color: var(--vscode-charts-blue, #3794ff); }
    .card header {
        display: flex; align-items: center; gap: 10px; padding: 6px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 12px; color: var(--vscode-descriptionForeground);
    }
    .badge { font-weight: 700; letter-spacing: 0.05em; color: var(--vscode-foreground); }
    .index { margin-left: auto; }
    pre {
        margin: 0; padding: 10px 12px; overflow-x: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        white-space: pre-wrap; word-break: break-word;
    }
    .footer {
        position: fixed; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; gap: 8px; padding: 10px 20px;
        background: var(--vscode-editor-background);
        border-top: 1px solid var(--vscode-panel-border);
    }
    .footer .status { margin-right: auto; color: var(--vscode-descriptionForeground); font-size: 12px; }
    button {
        padding: 5px 14px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
        cursor: pointer; font-family: inherit; font-size: 13px;
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { opacity: 0.9; }
</style>
</head>
<body>
    <h1>Review changes</h1>
    <div class="target">${escapeHtml(targetLabel)}</div>
    <div class="summary">
        ${updates > 0 ? `<span class="pill">${updates} UPDATE</span>` : ''}
        ${deletes > 0 ? `<span class="pill">${deletes} DELETE</span>` : ''}
    </div>
    ${cards}
    <div class="footer">
        <span class="status" id="status">These statements run against the database when you save.</span>
        <button id="copy">Copy SQL</button>
        <button id="cancel">Cancel</button>
        <button id="save" class="primary">Save Changes</button>
    </div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('save').addEventListener('click', () => vscode.postMessage({ command: 'save' }));
    document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ command: 'copy' }));
    window.addEventListener('message', (event) => {
        if (event.data && event.data.command === 'copied') {
            document.getElementById('status').textContent = 'SQL copied to the clipboard. Nothing was executed yet.';
        }
    });
</script>
</body>
</html>`;
}

/**
 * Shows the exact statements an inline edit would run in a review panel.
 * Resolves 'save' only when the user presses Save Changes; closing the panel or Cancel resolves 'cancel'.
 */
export function reviewEditStatements(statements: EditStatement[], targetLabel: string): Promise<EditReviewChoice> {
    return new Promise<EditReviewChoice>((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'justybase.reviewEdits',
            `Review changes: ${targetLabel}`,
            vscode.ViewColumn.Active,
            { enableScripts: true },
        );
        const nonce = randomBytes(16).toString('base64');
        const script = buildScript(statements);
        let settled = false;

        const finish = (choice: EditReviewChoice): void => {
            if (settled) return;
            settled = true;
            resolve(choice);
            panel.dispose();
        };

        panel.webview.onDidReceiveMessage((message: { command?: string }) => {
            switch (message?.command) {
                case 'save':
                    finish('save');
                    return;
                case 'cancel':
                    finish('cancel');
                    return;
                case 'copy':
                    void vscode.env.clipboard.writeText(script).then(() => {
                        void panel.webview.postMessage({ command: 'copied' });
                    });
                    return;
            }
        });
        panel.onDidDispose(() => finish('cancel'));
        panel.webview.html = renderReviewHtml(statements, targetLabel, nonce);
    });
}
