import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import type { SchemaItem } from '../providers/schemaProvider';

type CapabilityContextKey =
    | 'supportsExplainPlan'
    | 'supportsTuningAdvisor'
    | 'supportsExternalTables'
    | 'supportsProcedures'
    | 'supportsTableMaintenance'
    | 'supportsSessionMonitor';

const CAPABILITY_CONTEXT_KEYS: readonly CapabilityContextKey[] = [
    'supportsExplainPlan',
    'supportsTuningAdvisor',
    'supportsExternalTables',
    'supportsProcedures',
    'supportsTableMaintenance',
    'supportsSessionMonitor'
];

export const DATABASE_UI_CONTEXT_PREFIX = 'justybase';

async function setContext(key: string, value: unknown): Promise<void> {
    await vscode.commands.executeCommand('setContext', key, value);
}

async function updateCapabilityContextSet(
    connectionManager: ConnectionManager,
    contextKeyPrefix: string,
    connectionName?: string,
    documentUri?: string
): Promise<void> {
    const databaseKind = connectionManager.getConnectionDatabaseKind(connectionName) ?? '';
    const updates: Promise<void>[] = [
        setContext(`${contextKeyPrefix}.hasConnection`, Boolean(connectionName)),
        setContext(`${contextKeyPrefix}.databaseKind`, databaseKind)
    ];

    for (const capabilityKey of CAPABILITY_CONTEXT_KEYS) {
        updates.push(
            setContext(
                `${contextKeyPrefix}.capabilities.${capabilityKey}`,
                connectionManager.supportsCapability(capabilityKey, documentUri, connectionName)
            )
        );
    }

    await Promise.all(updates);
}

export async function updateDatabaseUiContexts(
    connectionManager: ConnectionManager,
    activeEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
): Promise<void> {
    const documentUri = activeEditor?.document.uri?.toString();
    const activeConnectionName = connectionManager.resolveConnectionName(documentUri);
    await updateCapabilityContextSet(
        connectionManager,
        `${DATABASE_UI_CONTEXT_PREFIX}.active`,
        activeConnectionName,
        documentUri
    );
    await Promise.all([
        setContext(`${DATABASE_UI_CONTEXT_PREFIX}.hasActiveConnection`, Boolean(activeConnectionName)),
        setContext(
            `${DATABASE_UI_CONTEXT_PREFIX}.activeDatabaseKind`,
            connectionManager.getConnectionDatabaseKind(activeConnectionName) ?? ''
        )
    ]);
}

export async function updateSchemaUiContexts(
    connectionManager: ConnectionManager,
    selectedSchemaItem?: Pick<SchemaItem, 'connectionName'>
): Promise<void> {
    const schemaConnectionName = selectedSchemaItem?.connectionName || connectionManager.getActiveConnectionName() || undefined;
    await updateCapabilityContextSet(
        connectionManager,
        `${DATABASE_UI_CONTEXT_PREFIX}.schema`,
        schemaConnectionName
    );
    await Promise.all([
        setContext(`${DATABASE_UI_CONTEXT_PREFIX}.schemaHasConnection`, Boolean(schemaConnectionName)),
        setContext(
            `${DATABASE_UI_CONTEXT_PREFIX}.schemaDatabaseKind`,
            connectionManager.getConnectionDatabaseKind(schemaConnectionName) ?? ''
        )
    ]);
}

export function registerDatabaseUiContexts(
    connectionManager: ConnectionManager,
    schemaTreeView?: vscode.TreeView<SchemaItem>
): vscode.Disposable[] {
    const getSelectedSchemaItem = (): Pick<SchemaItem, 'connectionName'> | undefined => schemaTreeView?.selection?.[0];
    const refreshActiveContexts = (activeEditor?: vscode.TextEditor): void => {
        void updateDatabaseUiContexts(connectionManager, activeEditor);
    };
    const refreshSchemaContexts = (): void => {
        void updateSchemaUiContexts(connectionManager, getSelectedSchemaItem());
    };

    refreshActiveContexts();
    refreshSchemaContexts();

    const toDisposable = (
        registration: vscode.Disposable | undefined
    ): vscode.Disposable | undefined => registration;

    return [
        toDisposable(vscode.window.onDidChangeActiveTextEditor(editor => {
            refreshActiveContexts(editor);
        })),
        toDisposable(connectionManager.onDidChangeConnections(() => {
            refreshActiveContexts();
            refreshSchemaContexts();
        })),
        toDisposable(connectionManager.onDidChangeActiveConnection(() => {
            refreshActiveContexts();
            refreshSchemaContexts();
        })),
        toDisposable(connectionManager.onDidChangeDocumentConnection(() => {
            refreshActiveContexts();
        })),
        toDisposable(connectionManager.onDidChangeDocumentDatabase(() => {
            refreshActiveContexts();
        })),
        toDisposable(schemaTreeView?.onDidChangeSelection?.(() => {
            refreshSchemaContexts();
        }))
    ].filter((disposable): disposable is vscode.Disposable => disposable !== undefined);
}
