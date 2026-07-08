/**
 * Variable Manager
 * Manages ETL variables with support for mutable updates during execution
 */

import * as vscode from 'vscode';

/**
 * Interface for variable management during ETL execution
 */
export interface IVariableManager {
    /** Get variable value by name */
    get(name: string): string | undefined;

    /** Set variable value */
    set(name: string, value: string): void;

    /** Check if variable exists */
    has(name: string): boolean;

    /** Get all variables as record */
    getAll(): Record<string, string>;

    /** Prompt user for value (for interactive variables) */
    promptForValue(
        name: string,
        message: string,
        defaultValue?: string
    ): Promise<string | undefined>;
}

/**
 * Default variable manager implementation
 * Stores variables in memory and prompts via VS Code
 */
export class VariableManager implements IVariableManager {
    private variables: Map<string, string>;

    constructor(initialVariables?: Record<string, string>) {
        this.variables = new Map(
            Object.entries(initialVariables || {})
        );
    }

    get(name: string): string | undefined {
        return this.variables.get(name);
    }

    set(name: string, value: string): void {
        this.variables.set(name, value);
    }

    has(name: string): boolean {
        return this.variables.has(name);
    }

    getAll(): Record<string, string> {
        return Object.fromEntries(this.variables);
    }

    async promptForValue(
        name: string,
        message: string,
        defaultValue?: string
    ): Promise<string | undefined> {
        const value = await vscode.window.showInputBox({
            prompt: message || `Enter value for ${name}`,
            value: defaultValue || '',
            placeHolder: `Value for \${${name}}`,
            ignoreFocusOut: true
        });

        if (value !== undefined) {
            this.set(name, value);
        }

        return value;
    }

    /**
     * Create a snapshot of current variables
     */
    snapshot(): Record<string, string> {
        return { ...this.getAll() };
    }

    /**
     * Merge variables from another record
     */
    merge(variables: Record<string, string>): void {
        for (const [name, value] of Object.entries(variables)) {
            this.set(name, value);
        }
    }
}
