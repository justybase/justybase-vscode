import * as vscode from 'vscode';
import { duckdbDialect } from './duckdbDialect';
import { fileDialect } from './fileDialect';
import { registerFileQueryCommand } from './fileQueryCommand';
import { activateCoreExtension } from '../../../src/api/companionActivation';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(duckdbDialect);
    api.registerDatabaseDialect(fileDialect);
    registerFileQueryCommand(api, context.subscriptions);
}

export function deactivate(): void {}
