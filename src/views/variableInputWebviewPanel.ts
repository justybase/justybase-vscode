import * as vscode from 'vscode';
import { normalizeVariableName } from '../core/variableUtils';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../compatibility/state';

interface VariableValueHistory {
    [variableName: string]: string[];
}

/**
 * WebviewPanel-based variable input modal.
 * Shows a centered, visible modal dialog for entering SQL parameter values.
 * Replaces the easy-to-miss showInputBox approach.
 */
export class VariableInputWebviewPanel {
    private static currentPanel: VariableInputWebviewPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private _resolvePromise?: (value: Record<string, string> | undefined) => void;
    private _disposables: vscode.Disposable[] = [];
    private _variables: string[];
    private _defaults: Record<string, string>;
    private _context: vscode.ExtensionContext;

    private constructor(
        context: vscode.ExtensionContext,
        variables: string[],
        defaults: Record<string, string>,
    ) {
        this._context = context;
        this._variables = variables;
        this._defaults = defaults;

        this._panel = vscode.window.createWebviewPanel(
            'variableInput',
            'Enter Parameter Values',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                ],
            },
        );

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.webview.onDidReceiveMessage(
            (message) => this._onMessage(message),
            undefined,
            this._disposables,
        );

        this._panel.onDidDispose(
            () => {
                if (this._resolvePromise) {
                    this._resolvePromise(undefined);
                    this._resolvePromise = undefined;
                }
                this.dispose();
            },
            undefined,
            this._disposables,
        );
    }

    private _getHistory(): VariableValueHistory {
        return getMementoValue<VariableValueHistory>(
            this._context.globalState,
            compatibilityStateKeys.variableValues,
            {},
        ) || {};
    }

    private _getMostRecentValue(variableName: string): string {
        const history = this._getHistory();
        const values = history[normalizeVariableName(variableName)];
        return values && values.length > 0 ? values[0] : '';
    }

    private async _saveValues(values: Record<string, string>): Promise<void> {
        try {
            const history = this._getHistory();
            for (const [varName, value] of Object.entries(values)) {
                const normalizedName = normalizeVariableName(varName);
                if (!history[normalizedName]) {
                    history[normalizedName] = [];
                }
                const existing = history[normalizedName];
                const filtered = existing.filter((v) => v !== value);
                filtered.unshift(value);
                history[normalizedName] = filtered.slice(0, 10);
            }
            await updateMementoValue(
                this._context.globalState,
                compatibilityStateKeys.variableValues,
                history,
            );
        } catch (err) {
            console.error('Failed to save variable values:', err);
        }
    }

    private _onMessage(message: { command: string; values?: Record<string, string> }): void {
        switch (message.command) {
            case 'submit':
                if (this._resolvePromise && message.values) {
                    // Fire-and-forget: save to history in background
                    void this._saveValues(message.values);
                    const resolved = this._resolvePromise;
                    this._resolvePromise = undefined;
                    resolved(message.values);
                    this._panel.dispose();
                }
                break;
            case 'cancel':
                if (this._resolvePromise) {
                    const resolved = this._resolvePromise;
                    this._resolvePromise = undefined;
                    resolved(undefined);
                    this._panel.dispose();
                }
                break;
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'variableInput.css'),
        );

        const variablesHtml = this._variables
            .map((varName, index) => {
                const defaultValue = this._defaults[varName] || this._getMostRecentValue(varName) || '';
                const history = this._getHistory();
                const historyValues = history[normalizeVariableName(varName)] || [];
                const historyOptions = historyValues
                    .map((v) => `<option value="${this._escapeHtml(v)}">`)
                    .join('');
                const escapedDefault = this._escapeHtml(defaultValue);
                const escapedVarName = this._escapeHtml(varName);
                return `
                    <div class="variable-row">
                        <label class="variable-label" for="var-${index}">${escapedVarName}</label>
                        <div class="variable-input-wrapper">
                            <input
                                type="text"
                                id="var-${index}"
                                class="variable-input"
                                data-variable="${escapedVarName}"
                                value="${escapedDefault}"
                                placeholder="Enter value for ${escapedVarName}"
                                autocomplete="off"
                                spellcheck="false"
                            />
                            <datalist id="history-${index}">${historyOptions}</datalist>
                        </div>
                    </div>`;
            })
            .join('');

        const title =
            this._variables.length === 1
                ? `Enter value for ${this._escapeHtml(this._variables[0])}`
                : `Enter parameter values (${this._variables.length} parameters)`;

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>Enter Parameter Values</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div class="variable-modal-overlay" id="overlay">
        <div class="variable-modal-card">
            <div class="variable-modal-header">
                <div class="variable-modal-title">${title}</div>
                <div class="variable-modal-subtitle">SQL parameters detected in your query</div>
            </div>
            <div class="variable-modal-body" id="variableForm">
                ${variablesHtml}
            </div>
            <div class="variable-modal-footer">
                <button type="button" class="variable-btn variable-btn-cancel" id="cancelBtn">Cancel</button>
                <button type="button" class="variable-btn variable-btn-submit" id="submitBtn">Execute</button>
            </div>
        </div>
    </div>
    <script>
        (function() {
            const vscode = acquireVsCodeApi();

            // Set up datalists for autocomplete from history
            document.querySelectorAll('.variable-input').forEach((input, i) => {
                input.setAttribute('list', 'history-' + i);
            });

            document.getElementById('submitBtn').addEventListener('click', () => {
                const values = {};
                document.querySelectorAll('.variable-input').forEach(input => {
                    values[input.dataset.variable] = input.value;
                });
                vscode.postMessage({ command: 'submit', values });
            });

            document.getElementById('cancelBtn').addEventListener('click', () => {
                vscode.postMessage({ command: 'cancel' });
            });

            // Enter key submits
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    document.getElementById('submitBtn').click();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    document.getElementById('cancelBtn').click();
                }
            });

            // Focus first input
            const firstInput = document.querySelector('.variable-input');
            if (firstInput) {
                firstInput.focus();
                firstInput.select();
            }
        })();
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    public static async show(
        variables: string[],
        defaults: Record<string, string> = {},
        context?: vscode.ExtensionContext,
    ): Promise<Record<string, string> | undefined> {
        if (!context) {
            throw new Error('ExtensionContext is required for VariableInputWebviewPanel');
        }

        if (VariableInputWebviewPanel.currentPanel) {
            VariableInputWebviewPanel.currentPanel.dispose();
        }

        VariableInputWebviewPanel.currentPanel = new VariableInputWebviewPanel(
            context,
            variables,
            defaults,
        );

        return new Promise<Record<string, string> | undefined>((resolve) => {
            VariableInputWebviewPanel.currentPanel!._resolvePromise = resolve;
        });
    }

    public dispose(): void {
        VariableInputWebviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}
