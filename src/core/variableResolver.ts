import * as vscode from 'vscode';
import {
    formatPutLogMessage,
    normalizeVariableName,
    normalizeVariableValues,
} from './variableUtils';
import {
    MacroEnvironment,
    MacroPreprocessor,
    type MacroPreprocessorContext,
} from './macroPreprocessor';
import { VariableInputWebviewPanel } from '../views/variableInputWebviewPanel';
import { compatibilityStateKeys, getMementoValue } from '../compatibility/state';

interface VariableValueHistory {
    [variableName: string]: string[];
}

function getPreviousValues(context: vscode.ExtensionContext): VariableValueHistory {
    const history = getMementoValue<VariableValueHistory>(
        context.globalState,
        compatibilityStateKeys.variableValues,
        {}
    ) || {};
    const normalizedHistory: VariableValueHistory = {};

    for (const [variableName, values] of Object.entries(history)) {
        const normalizedName = normalizeVariableName(variableName);
        const existing = normalizedHistory[normalizedName] || [];

        for (const value of values) {
            if (!existing.includes(value)) {
                existing.push(value);
            }
        }

        normalizedHistory[normalizedName] = existing;
    }

    return normalizedHistory;
}

function getLastValueForVariable(context: vscode.ExtensionContext, variableName: string): string | undefined {
    const history = getPreviousValues(context);
    const values = history[normalizeVariableName(variableName)];
    return values && values.length > 0 ? values[0] : undefined;
}

export async function promptForVariableValues(
    variables: Set<string>,
    silent: boolean,
    defaults: Record<string, string> = {},
    context?: vscode.ExtensionContext
): Promise<Record<string, string>> {
    const normalizedVariables = new Set(Array.from(variables, normalizeVariableName));
    const normalizedDefaults = normalizeVariableValues(defaults);
    const values: Record<string, string> = {};
    if (normalizedVariables.size === 0) return values;

    if (silent) {
        const missing = Array.from(normalizedVariables).filter(v => normalizedDefaults[v] === undefined);
        if (missing.length > 0) {
            throw new Error(
                'Query contains variables but silent mode is enabled; cannot prompt for values. Missing: ' +
                missing.join(', ')
            );
        }
        for (const v of normalizedVariables) {
            values[v] = normalizedDefaults[v];
        }
        return values;
    }

    const panelDefaults = { ...normalizedDefaults };

    if (context) {
        for (const v of normalizedVariables) {
            if (panelDefaults[v] === undefined) {
                const lastValue = getLastValueForVariable(context, v);
                if (lastValue) {
                    panelDefaults[v] = lastValue;
                }
            }
        }
    }

    const result = await VariableInputWebviewPanel.show(
        Array.from(normalizedVariables),
        panelDefaults,
        context
    );

    if (!result) {
        throw new Error('Variable input cancelled by user');
    }

    return normalizeVariableValues(result);
}

export async function resolveQueryVariables(
    query: string,
    silent: boolean,
    context?: vscode.ExtensionContext,
    logCallback?: (message: string) => void,
    macroContext: MacroPreprocessorContext = {},
): Promise<string> {
    const promptValues = await collectQueryVariableValues(query, silent, context);
    return await resolveQueryVariablesWithValues(
        query,
        promptValues,
        logCallback,
        macroContext,
    );
}

export async function collectQueryVariableValues(
    query: string,
    silent: boolean,
    context?: vscode.ExtensionContext,
): Promise<Record<string, string>> {
    const preprocessor = new MacroPreprocessor();
    const scanResult = preprocessor.processScriptSync(query, {
        environment: new MacroEnvironment(),
        replaceVariables: false,
    });
    const promptVariables = new Set(Array.from(scanResult.unresolvedVariables, normalizeVariableName));
    return await promptForVariableValues(promptVariables, silent, {}, context);
}

export async function resolveQueryVariablesWithValues(
    query: string,
    values: Record<string, string>,
    logCallback?: (message: string) => void,
    macroContext: MacroPreprocessorContext = {},
): Promise<string> {
    const preprocessor = new MacroPreprocessor();
    const executionEnvironment = new MacroEnvironment(normalizeVariableValues(values));
    const result = await preprocessor.processScript(query, {
        environment: executionEnvironment,
        replaceVariables: true,
    }, macroContext);

    result.putMessages.forEach(message => {
        logCallback?.(formatPutLogMessage(message));
    });

    return result.sql;
}
