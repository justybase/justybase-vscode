import * as vscode from 'vscode';
import { normalizeVariableName } from '../core/variableUtils';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from '../compatibility/state';

interface VariableValueHistory {
    [variableName: string]: string[];
}

export class VariableInputPanel {
    private static currentPanel: VariableInputPanel | undefined;
    private _resolvePromise?: (value: Record<string, string> | undefined) => void;
    private readonly _context: vscode.ExtensionContext;

    private constructor(
        context: vscode.ExtensionContext,
        private variables: string[],
        private defaults?: Record<string, string>
    ) {
        this._context = context;
    }

    private async _saveVariableValues(values: Record<string, string>): Promise<void> {
        try {
            const history = this._getVariableHistory();
            for (const [varName, value] of Object.entries(values)) {
                const normalizedName = normalizeVariableName(varName);
                if (!history[normalizedName]) {
                    history[normalizedName] = [];
                }
                const existing = history[normalizedName];
                const filtered = existing.filter(v => v !== value);
                filtered.unshift(value);
                history[normalizedName] = filtered.slice(0, 10);
            }
            await updateMementoValue(this._context.globalState, compatibilityStateKeys.variableValues, history);
        } catch (err) {
            console.error('Failed to save variable values:', err);
        }
    }

    private _getVariableHistory(): VariableValueHistory {
        return getMementoValue<VariableValueHistory>(
            this._context.globalState,
            compatibilityStateKeys.variableValues,
            {}
        ) || {};
    }

    private _getPreviousValues(variableName: string): string[] {
        const history = this._getVariableHistory();
        return history[normalizeVariableName(variableName)] || [];
    }

    private _getMostRecentValue(variableName: string): string {
        const previousValues = this._getPreviousValues(variableName);
        return previousValues.length > 0 ? previousValues[0] : '';
    }

    private async _collectVariableValues(): Promise<Record<string, string> | undefined> {
        const result: Record<string, string> = {};

        for (let i = 0; i < this.variables.length; i++) {
            const varName = this.variables[i];
            const defaultValue = this.defaults?.[varName] || '';
            const mostRecentValue = this._getMostRecentValue(varName);
            const valueToUse = mostRecentValue || defaultValue;

            const input = await vscode.window.showInputBox({
                prompt: `Enter value for ${varName} (${i + 1}/${this.variables.length})`,
                placeHolder: 'Enter variable value',
                value: valueToUse,
                ignoreFocusOut: true
            });

            if (input === undefined) {
                // User cancelled
                return undefined;
            }

            const trimmedValue = input.trim();
            if (trimmedValue === '') {
                // Empty input - show error and retry
                const retry = await vscode.window.showWarningMessage(
                    `Variable '${varName}' cannot be empty. Do you want to retry?`,
                    'Retry',
                    'Cancel'
                );
                if (retry === 'Retry') {
                    i--; // Retry this variable
                    continue;
                }
                return undefined;
            }

            result[varName] = trimmedValue;
        }

        return result;
    }

    public static async show(
        variables: string[],
        defaults: Record<string, string> = {},
        context?: vscode.ExtensionContext
    ): Promise<Record<string, string> | undefined> {
        if (!context) {
            throw new Error('ExtensionContext is required for VariableInputPanel');
        }

        if (VariableInputPanel.currentPanel) {
            VariableInputPanel.currentPanel.dispose();
        }

        VariableInputPanel.currentPanel = new VariableInputPanel(
            context,
            variables,
            defaults
        );

        return new Promise<Record<string, string> | undefined>(resolve => {
            VariableInputPanel.currentPanel!._resolvePromise = resolve;

            VariableInputPanel.currentPanel!._collectVariableValues().then(async values => {
                if (values) {
                    await VariableInputPanel.currentPanel!._saveVariableValues(values);
                }

                if (VariableInputPanel.currentPanel!._resolvePromise) {
                    VariableInputPanel.currentPanel!._resolvePromise(values);
                    VariableInputPanel.currentPanel!._resolvePromise = undefined;
                }

                VariableInputPanel.currentPanel!.dispose();
            });
        });
    }

    public dispose() {
        VariableInputPanel.currentPanel = undefined;
    }
}
