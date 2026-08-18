import * as vscode from 'vscode';
import type { DatabaseDialect } from '@justybase/contracts';
import { duckdbDialect } from './duckdbDialect';
import { fileDialect } from './fileDialect';
import { registerFileQueryCommand } from './fileQueryCommand';

interface JustyBaseLiteApi {
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
    openFileSqlSession(
        details: {
            name?: string;
            host: string;
            port?: number;
            database: string;
            user: string;
            password?: string;
            dbType?: string;
            options?: Record<string, string | number | boolean>;
        },
        options?: { content?: string; connectionName?: string; updateExisting?: boolean },
    ): Promise<void>;
    openFileSqlWorkspaceSession(
        filePaths: readonly string[],
        options?: { content?: string; connectionName?: string },
    ): Promise<void>;
    listSavedConnections(): Promise<ReadonlyArray<{
        name: string;
        details: {
            name?: string;
            host: string;
            database: string;
            user: string;
            dbType?: string;
            options?: Record<string, string | number | boolean>;
        };
    }>>;
    getActiveConnectionDetails(): Promise<
        | {
            name: string;
            details: {
                name?: string;
                host: string;
                database: string;
                user: string;
                dbType?: string;
                options?: Record<string, string | number | boolean>;
            };
            documentUri?: string;
            documentBound: boolean;
        }
        | undefined
    >;
    executeActiveConnectionSql(sql: string, documentUri?: string): Promise<void>;
}

const CORE_EXTENSION_ID = 'krzysztof-d.justybaselite-netezza';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const coreExtension = vscode.extensions.getExtension<JustyBaseLiteApi>(CORE_EXTENSION_ID);
    if (!coreExtension) {
        throw new Error(`Required extension dependency '${CORE_EXTENSION_ID}' is not installed.`);
    }

    const api = await coreExtension.activate();
    if (!api || typeof api.registerDatabaseDialect !== 'function') {
        throw new Error(`Extension '${CORE_EXTENSION_ID}' does not expose the JustyBase registration API.`);
    }

    api.registerDatabaseDialect(duckdbDialect);
    api.registerDatabaseDialect(fileDialect);
    registerFileQueryCommand(api, context.subscriptions);
}

export function deactivate(): void {}
