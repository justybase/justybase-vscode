import * as vscode from 'vscode';
import { ConnectionManager } from '../../core/connectionManager';
import { ResultPanelView } from '../../views/resultPanelView';
import { getExtensionConfiguration } from '../../compatibility/configuration';

export interface QueryCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    resultPanelProvider: ResultPanelView;
}

/**
 * Configuration provider interface for dependency injection
 * Allows mocking VS Code configuration in tests
 */
export interface ConfigurationProvider {
    get: <T>(key: string, defaultValue: T) => T;
}

/**
 * UI service interface for dependency injection
 * Allows mocking VS Code window interactions in tests
 */
export interface UIService {
    showWarningMessage: (message: string, options?: vscode.MessageOptions, ...items: string[]) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    createTerminal: (options: vscode.TerminalOptions) => vscode.Terminal;
    withProgress: <R>(
        options: vscode.ProgressOptions,
        task: (
            progress: vscode.Progress<{ message?: string; increment?: number }>,
            token: vscode.CancellationToken
        ) => Thenable<R>
    ) => Thenable<R>;
}

/**
 * Default VS Code UI service implementation
 */
export class DefaultUIService implements UIService {
    showWarningMessage(message: string, options?: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined> {
        if (options) {
            return vscode.window.showWarningMessage(message, options, ...items);
        }
        return vscode.window.showWarningMessage(message, ...items);
    }

    showErrorMessage(message: string): Thenable<string | undefined> {
        return vscode.window.showErrorMessage(message);
    }

    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined> {
        return vscode.window.showInformationMessage(message, ...items);
    }

    showInputBox(options: vscode.InputBoxOptions): Thenable<string | undefined> {
        return vscode.window.showInputBox(options);
    }

    createTerminal(options: vscode.TerminalOptions): vscode.Terminal {
        return vscode.window.createTerminal(options);
    }

    withProgress<R>(
        options: vscode.ProgressOptions,
        task: (
            progress: vscode.Progress<{ message?: string; increment?: number }>,
            token: vscode.CancellationToken
        ) => Thenable<R>
    ): Thenable<R> {
        return vscode.window.withProgress(options, task);
    }
}

/**
 * Default VS Code configuration provider implementation
 */
export class DefaultConfigurationProvider implements ConfigurationProvider {
    get<T>(key: string, defaultValue: T): T {
        return getExtensionConfiguration().get<T>(key, defaultValue) ?? defaultValue;
    }
}
