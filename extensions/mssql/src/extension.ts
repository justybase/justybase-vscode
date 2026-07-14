import * as vscode from 'vscode';
import type { DatabaseDialect } from '@justybase/contracts';
import { mssqlDialect } from './mssqlDialect';

interface JustyBaseLiteApi {
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
}

const CORE_EXTENSION_ID = 'justybase.justybase-netezza';

export async function activate(): Promise<void> {
    const coreExtension = vscode.extensions.getExtension<JustyBaseLiteApi>(CORE_EXTENSION_ID);
    if (!coreExtension) {
        throw new Error(`Required extension dependency '${CORE_EXTENSION_ID}' is not installed.`);
    }

    const api = await coreExtension.activate();
    if (!api || typeof api.registerDatabaseDialect !== 'function') {
        throw new Error(`Extension '${CORE_EXTENSION_ID}' does not expose the JustyBase registration API.`);
    }

    api.registerDatabaseDialect(mssqlDialect);
}

export function deactivate(): void {}
