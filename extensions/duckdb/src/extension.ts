import * as vscode from 'vscode';
import type { DatabaseDialect } from '@justybase/contracts';
import { duckdbDialect } from './duckdbDialect';

interface JustyBaseLiteApi {
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
}

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export async function activate(): Promise<void> {
    const coreExtension = vscode.extensions.getExtension<JustyBaseLiteApi>(CORE_EXTENSION_ID);
    if (!coreExtension) {
        throw new Error(`Required extension dependency '${CORE_EXTENSION_ID}' is not installed.`);
    }

    const api = await coreExtension.activate();
    if (!api || typeof api.registerDatabaseDialect !== 'function') {
        throw new Error(`Extension '${CORE_EXTENSION_ID}' does not expose the JustyBase registration API.`);
    }

    api.registerDatabaseDialect(duckdbDialect);
}

export function deactivate(): void {}
