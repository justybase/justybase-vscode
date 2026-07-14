import * as vscode from 'vscode';
import { runQueryRaw } from '../core/queryRunner';
import { DatabaseMetadata, MetadataCache } from '../metadataCache';
import { NZ_SYSTEM_VIEWS } from '../metadata';
import { getExtensionConfiguration } from '../compatibility/configuration';
import type { ConnectionManager } from '../core/connectionManager';

const KNOWN_SQL_EXTENSIONS = [
    { id: 'mtxr.sqltools', name: 'SQLTools' },
    { id: 'ms-mssql.mssql', name: 'Microsoft SQL Server' },
    { id: 'oracle.oracledevtools', name: 'Oracle Developer Tools' },
    { id: 'cweijan.vscode-mysql-client2', name: 'MySQL' },
    { id: 'ckolkman.vscode-postgres', name: 'PostgreSQL' },
];
const GETTING_STARTED_CATEGORY = 'justybase.justybase-netezza#netezzaGettingStarted';
const GETTING_STARTED_STEP = 'connect';

export async function checkForConflictingExtensions(_context: vscode.ExtensionContext): Promise<void> {
    const config = getExtensionConfiguration();
    const showWarnings = config.get<boolean>('showConflictWarnings', true);
    if (!showWarnings) {
        return;
    }

    const foundKnown: string[] = [];
    for (const ext of KNOWN_SQL_EXTENSIONS) {
        if (vscode.extensions.getExtension(ext.id)) {
            foundKnown.push(ext.name);
        }
    }

    const otherSqlExtensions = vscode.extensions.all.filter(ext => {
        const pkg = ext.packageJSON;
        if (!pkg || ext.id === 'justybase.justybase-netezza') {
            return false;
        }
        if (KNOWN_SQL_EXTENSIONS.some(k => k.id === ext.id)) {
            return false;
        }
        const activatesOnSql = pkg.activationEvents?.some(
            (e: string) => e.includes('onLanguage:sql') || e.includes('onLanguage:mssql'),
        );
        const contributesSql = pkg.contributes?.languages?.some(
            (lang: { id: string; extensions?: string[] }) => lang.id === 'sql' || lang.extensions?.includes('.sql'),
        );
        const displayName = pkg.displayName || '';
        if (displayName === 'SQL Language Basics') {
            return false;
        }
        return activatesOnSql || contributesSql;
    });

    const allConflicts = [
        ...foundKnown,
        ...otherSqlExtensions.map(ext => ext.packageJSON.displayName || ext.id),
    ];
    if (allConflicts.length === 0) {
        return;
    }

    const message =
        allConflicts.length === 1
            ? `SQL extension detected "${allConflicts[0]}" which may cause conflicts (e.g. duplicate keybindings F5, Ctrl+Enter).`
            : `SQL extensions detected which may cause conflicts: ${allConflicts.join(', ')}. Some functions (e.g. F5, Ctrl+Enter) may be duplicated.`;

    const result = await vscode.window.showWarningMessage(message, 'OK', 'Do not show again');
    if (result === 'Do not show again') {
        await config.update('showConflictWarnings', false, vscode.ConfigurationTarget.Global);
    }
}

export async function getDatabaseList(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    metadataCache?: MetadataCache,
): Promise<string[]> {
    if (metadataCache) {
        const cached = metadataCache.getDatabases(connectionName);
        if (cached && cached.length > 0) {
            return cached.map(db => db.DATABASE);
        }
    }

    const result = await runQueryRaw(
        context,
        `SELECT DATABASE FROM ${NZ_SYSTEM_VIEWS.DATABASE} ORDER BY DATABASE`,
        true,
        connectionManager,
        connectionName,
        undefined,
        undefined,
        undefined,
        1000000,
        false,
    );

    if (!result.data || result.data.length === 0) {
        return [];
    }

    const databases = result.data.map(row => String(row[0]));
    if (metadataCache) {
        metadataCache.setDatabases(
            connectionName,
            databases.map(db => ({
                DATABASE: db,
                label: db,
                kind: 9,
                detail: 'Database',
            })) as DatabaseMetadata[],
        );
    }
    return databases;
}

export async function openGettingStartedWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', {
        category: GETTING_STARTED_CATEGORY,
        step: GETTING_STARTED_STEP,
    });
}
