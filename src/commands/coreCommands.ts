/**
 * Core Commands - Connection, Database, ETL, and utility commands
 * Extracted from extension.ts to reduce activate() size.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { computeRefreshDurationP95 } from '../metadata/cacheStats';
import { SchemaProvider } from '../providers/schemaProvider';
import { ResultPanelView } from '../views/resultPanelView';
import { LoginPanel } from '../views/loginPanel';
import { SettingsView } from '../views/settingsView';
import { SqlParser } from '../sql/sqlParser';
import { EditDataProvider, EditDataItem } from '../views/editDataProvider';
import { EtlDesignerView } from '../views/etlDesignerView';
import { EtlProjectManager } from '../etl/etlProjectManager';
import { updateKeepConnectionStatusBar } from '../services/statusBarManager';
import { buildExecCommand } from '../utils/shellUtils';
import {
    runQueryRaw,
    runExplainQuery,
    runQueriesWithStreaming,
    runQueriesSequentially,
    queryResultToRows,
} from '../core/queryRunner';
import { supportsLegacyMetadataPrefetch } from '../metadata/prefetchSupport';
import { createPerformanceTimer, formatPerformanceEvent } from '../services/perf/performanceEvents';
import { findVisibleQueryFlowEditor } from '../utils/queryFlowEditor';
import { getExtensionConfiguration } from '../compatibility/configuration';
import type { QueryFlowNode } from '../sqlParser';
import type { TableDdlSynchronizer } from '../metadata/tableDdlSynchronizer';
import type { BatchQueryRunOptions } from '../core/queryRunner';
import { confirmSafeExecute } from './query/queryCommandSafety';

export interface CoreCommandsContext {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    schemaProvider: SchemaProvider;
    resultPanelProvider: ResultPanelView;
    keepConnectionStatusBar: vscode.StatusBarItem;
    getDatabaseList: (
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        connectionName: string,
        metadataCache?: MetadataCache,
    ) => Promise<string[]>;
    tableDdlSynchronizer?: TableDdlSynchronizer;
}

export interface StartupCommandsContext {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    openGettingStartedWalkthrough: () => Promise<void>;
}

export function registerStartupCommands(ctx: StartupCommandsContext): vscode.Disposable[] {
    const { context, connectionManager, openGettingStartedWalkthrough } = ctx;

    return [
        vscode.commands.registerCommand('netezza.openLogin', () => {
            LoginPanel.createOrShow(context.extensionUri, connectionManager);
        }),
        vscode.commands.registerCommand('netezza.openGettingStarted', async () => {
            await openGettingStartedWalkthrough();
        }),
        vscode.commands.registerCommand('netezza.openLoginNew', () => {
            LoginPanel.createNew(context.extensionUri, connectionManager);
        }),
        vscode.commands.registerCommand('netezza.openSettings', () => {
            SettingsView.createOrShow(context.extensionUri, context);
        }),
        vscode.commands.registerCommand('netezza.toggleCodeLens', async () => {
            const config = vscode.workspace.getConfiguration('justybase');
            const current = config.get<boolean>('codeLens.enabled', false);
            const newValue = !current;
            await config.update('codeLens.enabled', newValue, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('setContext', 'justybase.codeLensEnabled', newValue);
            vscode.window.showInformationMessage(`JustyBase CodeLens: ${newValue ? 'ON' : 'OFF'}`);
        }),
        vscode.commands.registerCommand('netezza.toggleCodeLensOff', async () => {
            const config = vscode.workspace.getConfiguration('justybase');
            const current = config.get<boolean>('codeLens.enabled', false);
            const newValue = !current;
            await config.update('codeLens.enabled', newValue, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('setContext', 'justybase.codeLensEnabled', newValue);
            vscode.window.showInformationMessage(`JustyBase CodeLens: ${newValue ? 'ON' : 'OFF'}`);
        }),
    ];
}

export function registerCoreCommands(ctx: CoreCommandsContext): vscode.Disposable[] {
    const {
        context,
        connectionManager,
        metadataCache,
        schemaProvider,
        resultPanelProvider,
        keepConnectionStatusBar,
        getDatabaseList,
        tableDdlSynchronizer,
    } = ctx;

    const ddlBatchOptions: BatchQueryRunOptions = {
        confirmSafeExecute: sql => confirmSafeExecute([sql]),
        onStatementSucceeded: event => tableDdlSynchronizer?.handleStatementSucceeded(event) ?? Promise.resolve(),
        onStatementFailed: event => {
            tableDdlSynchronizer?.handleExecutionFailure(event.connectionName, event.documentUri);
        },
    };

    let queryFlowRevealDecoration: vscode.TextEditorDecorationType | undefined;
    let queryFlowRevealTimeout: ReturnType<typeof setTimeout> | undefined;
    let queryFlowHighlightedEditor: vscode.TextEditor | undefined;

    const getQueryFlowRevealDecoration = (): vscode.TextEditorDecorationType => {
        if (!queryFlowRevealDecoration) {
            queryFlowRevealDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(147, 197, 253, 0.18)',
                border: '1px solid rgba(96, 165, 250, 0.65)',
                isWholeLine: false,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });
        }

        return queryFlowRevealDecoration;
    };

    const clearQueryFlowReveal = (editor?: vscode.TextEditor): void => {
        if (editor && queryFlowRevealDecoration) {
            editor.setDecorations(queryFlowRevealDecoration, []);
        }
    };

    const resolveActiveConnectionName = (): string | undefined => {
        const documentUri = vscode.window.activeTextEditor?.document?.uri?.toString();
        return (
            connectionManager.getConnectionForExecution(documentUri) ||
            connectionManager.getActiveConnectionName() ||
            undefined
        );
    };

    const ensureSnowflakeConnection = (connectionName: string | undefined): string | undefined => {
        if (!connectionName) {
            vscode.window.showErrorMessage('No database connection. Please connect first.');
            return undefined;
        }

        if (connectionManager.getConnectionDatabaseKind(connectionName) !== 'snowflake') {
            vscode.window.showErrorMessage('This command is available only for Snowflake connections.');
            return undefined;
        }

        return connectionName;
    };

    const openDraft = async (content: string, language: string, connectionName?: string): Promise<void> => {
        const document = await vscode.workspace.openTextDocument({
            content,
            language,
        });
        await vscode.window.showTextDocument(document, { preview: false });
        if (connectionName) {
            connectionManager.setDocumentConnection(document.uri.toString(), connectionName);
        }
    };

    const renderMetadataCacheStatsReport = (connectionName: string): string | undefined => {
        const snapshot = metadataCache.getStatsSnapshot(connectionName);
        if (!snapshot) {
            return undefined;
        }

        const refreshP95 = computeRefreshDurationP95(snapshot.refreshOps);
        const lines: string[] = [
            `# Metadata Cache Stats`,
            ``,
            `Connection: ${snapshot.connectionName}`,
            `Total entries: ${snapshot.totalEntries}`,
            `Estimated memory: ${(snapshot.estimatedMemoryBytes / (1024 * 1024)).toFixed(1)} MB`,
            `TTL evictions: ${snapshot.ttlEvictions}`,
            `Refresh duration p95: ${refreshP95 === undefined ? 'n/a' : `${refreshP95} ms`}`,
            ``,
            `## Hits and Misses`,
            ``,
            `| Layer | Hits | Misses | Hit rate |`,
            `| --- | ---: | ---: | ---: |`,
        ];

        for (const layer of Object.keys(snapshot.hits) as Array<keyof typeof snapshot.hits>) {
            const hits = snapshot.hits[layer];
            const misses = snapshot.misses[layer];
            const total = hits + misses;
            const hitRate = total === 0 ? 'n/a' : `${((hits / total) * 100).toFixed(1)}%`;
            lines.push(`| ${layer} | ${hits} | ${misses} | ${hitRate} |`);
        }

        lines.push('', '## Recent Refreshes', '');

        if (snapshot.refreshOps.length === 0) {
            lines.push(`No refresh operations recorded yet.`);
        } else {
            lines.push(`| Layer | Key | Duration (ms) | Entries |`, `| --- | --- | ---: | ---: |`);
            for (const refresh of snapshot.refreshOps.slice(-10).reverse()) {
                lines.push(
                    `| ${refresh.layer} | ${refresh.key} | ${refresh.durationMs} | ${refresh.entryCount} |`,
                );
            }
        }

        return lines.join('\n');
    };

    const revealQueryFlowNode = async (
        uri: vscode.Uri,
        node: QueryFlowNode,
        preferredViewColumn?: vscode.ViewColumn,
    ): Promise<void> => {
        const visibleEditor = findVisibleQueryFlowEditor(vscode.window.visibleTextEditors, uri, preferredViewColumn);
        const existingDocument = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString(),
        );
        const document = visibleEditor?.document ?? existingDocument ?? (await vscode.workspace.openTextDocument(uri));
        const editor =
            visibleEditor ??
            (await vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: true,
                viewColumn: preferredViewColumn,
            }));
        const range = new vscode.Range(document.positionAt(node.startOffset), document.positionAt(node.endOffset));

        if (queryFlowRevealTimeout) {
            clearTimeout(queryFlowRevealTimeout);
            queryFlowRevealTimeout = undefined;
        }

        if (queryFlowHighlightedEditor && queryFlowHighlightedEditor !== editor) {
            clearQueryFlowReveal(queryFlowHighlightedEditor);
        }

        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.setDecorations(getQueryFlowRevealDecoration(), [range]);
        queryFlowHighlightedEditor = editor;

        queryFlowRevealTimeout = setTimeout(() => {
            editor.setDecorations(getQueryFlowRevealDecoration(), []);
            if (queryFlowHighlightedEditor === editor) {
                queryFlowHighlightedEditor = undefined;
            }
            queryFlowRevealTimeout = undefined;
        }, 2500);
    };

    return [
        // View / Edit Data
        vscode.commands.registerCommand('netezza.viewEditData', (item: EditDataItem) => {
            EditDataProvider.createOrShow(context.extensionUri, item, context, connectionManager);
        }),

        // Toggle Keep Connection for current tab
        vscode.commands.registerCommand('netezza.toggleKeepConnectionForTab', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'sql') {
                vscode.window.showWarningMessage('Please open a SQL file first.');
                return;
            }

            const documentUri = editor.document.uri.toString();
            const newState = connectionManager.toggleDocumentKeepConnectionOpen(documentUri);
            updateKeepConnectionStatusBar(keepConnectionStatusBar, connectionManager);

            vscode.window.showInformationMessage(
                newState
                    ? `Keep connection: ENABLED for this tab - connection will remain open after queries`
                    : `Keep connection: DISABLED for this tab - connection will be closed after each query`,
            );
        }),

        // Select active connection
        vscode.commands.registerCommand('netezza.selectActiveConnection', async () => {
            const connections = await connectionManager.getConnections();
            if (connections.length === 0) {
                vscode.window.showWarningMessage('No connections configured. Please connect first.');
                return;
            }

            const selected = await vscode.window.showQuickPick(
                connections.map((c) => c.name),
                { placeHolder: 'Select Active Connection' },
            );

            if (selected) {
                await connectionManager.setActiveConnection(selected);
                vscode.window.showInformationMessage(`Active connection set to: ${selected}`);
            }
        }),

        // Select connection for tab
        vscode.commands.registerCommand('netezza.selectConnectionForTab', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'sql') {
                vscode.window.showWarningMessage('This command is only available for SQL files');
                return;
            }

            const connections = await connectionManager.getConnections();
            if (connections.length === 0) {
                vscode.window.showWarningMessage('No connections configured. Please connect first.');
                return;
            }

            const documentUri = editor.document.uri.toString();
            const currentConnection =
                connectionManager.getDocumentConnection(documentUri) || connectionManager.getActiveConnectionName();

            const items = connections.map((c) => ({
                label: c.name,
                description:
                    currentConnection === c.name ? '$(check) Currently selected' : `${c.host}:${c.port}/${c.database}`,
                name: c.name,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select connection for this SQL tab',
            });

            if (selected) {
                connectionManager.setDocumentConnection(documentUri, selected.name);
                vscode.window.showInformationMessage(`Connection for this tab set to: ${selected.name}`);
            }
        }),

        // Select database for current tab
        vscode.commands.registerCommand('netezza.selectDatabaseForTab', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'sql') {
                vscode.window.showWarningMessage('This command is only available for SQL files');
                return;
            }

            const documentUri = editor.document.uri.toString();
            const connectionName = connectionManager.getConnectionForExecution(documentUri);

            if (!connectionName) {
                vscode.window.showWarningMessage('No connection selected. Please select a connection first.');
                return;
            }

            try {
                const databases = await getDatabaseList(context, connectionManager, connectionName, metadataCache);

                if (databases.length === 0) {
                    vscode.window.showWarningMessage('No databases found on server.');
                    return;
                }

                const currentDatabase = await connectionManager.getEffectiveDatabase(documentUri);

                const items = databases.map((db) => ({
                    label: db,
                    description: db === currentDatabase ? '$(check) Currently selected' : '',
                    database: db,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Select database for this SQL tab (current: ${currentDatabase || 'default'})`,
                });

                if (selected) {
                    await connectionManager.setDocumentDatabase(documentUri, selected.database);
                    vscode.window.showInformationMessage(
                        `Database for this tab set to: ${selected.database} (reconnecting...)`,
                    );
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to get database list: ${msg}`);
            }
        }),

        vscode.commands.registerCommand('netezza.snowflake.switchWarehouse', async () => {
            const connectionName = ensureSnowflakeConnection(resolveActiveConnectionName());
            if (!connectionName) {
                return;
            }

            try {
                const warehouseResult = await runQueryRaw({
                    context,
                    query: 'SHOW WAREHOUSES ->> SELECT "name" AS NAME, "state" AS STATE FROM $1 ORDER BY "name"',
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                const warehouses = queryResultToRows<{ NAME?: string; STATE?: string }>(warehouseResult).filter(
                    (row) => typeof row.NAME === 'string' && row.NAME.trim().length > 0,
                );
                if (warehouses.length === 0) {
                    vscode.window.showWarningMessage('No Snowflake warehouses were returned for this account.');
                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    warehouses.map((row) => ({
                        label: row.NAME!,
                        description: row.STATE ? `State: ${row.STATE}` : '',
                    })),
                    { placeHolder: 'Select Snowflake warehouse' },
                );
                if (!selected) {
                    return;
                }

                await runQueryRaw({
                    context,
                    query: `USE WAREHOUSE "${selected.label.replace(/"/g, '""')}"`,
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                vscode.window.showInformationMessage(`Snowflake warehouse switched to ${selected.label}.`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to switch Snowflake warehouse: ${message}`);
            }
        }),

        vscode.commands.registerCommand('netezza.snowflake.switchRole', async () => {
            const connectionName = ensureSnowflakeConnection(resolveActiveConnectionName());
            if (!connectionName) {
                return;
            }

            try {
                const rolesResult = await runQueryRaw({
                    context,
                    query: 'SHOW ROLES ->> SELECT "name" AS NAME FROM $1 ORDER BY "name"',
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                const roles = queryResultToRows<{ NAME?: string }>(rolesResult).filter(
                    (row) => typeof row.NAME === 'string' && row.NAME.trim().length > 0,
                );
                if (roles.length === 0) {
                    vscode.window.showWarningMessage('No Snowflake roles were returned for this account.');
                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    roles.map((row) => ({ label: row.NAME! })),
                    { placeHolder: 'Select Snowflake role' },
                );
                if (!selected) {
                    return;
                }

                await runQueryRaw({
                    context,
                    query: `USE ROLE "${selected.label.replace(/"/g, '""')}"`,
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                vscode.window.showInformationMessage(`Snowflake role switched to ${selected.label}.`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to switch Snowflake role: ${message}`);
            }
        }),

        vscode.commands.registerCommand('netezza.snowflake.showRecentQueryProfile', async () => {
            const connectionName = ensureSnowflakeConnection(resolveActiveConnectionName());
            if (!connectionName) {
                return;
            }

            try {
                const {
                    buildSnowflakeRecentQueryHistoryQuery,
                    buildSnowflakeQueryOperatorStatsQuery,
                    renderSnowflakeQueryProfileMarkdown,
                } = await import('../../extensions/snowflake/src/snowflakeQueryProfile');

                const historyResult = await runQueryRaw({
                    context,
                    query: buildSnowflakeRecentQueryHistoryQuery(15),
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                const historyRows = queryResultToRows<{
                    QUERY_ID?: string;
                    QUERY_TEXT?: string;
                    DATABASE_NAME?: string;
                    SCHEMA_NAME?: string;
                    WAREHOUSE_NAME?: string;
                    EXECUTION_STATUS?: string;
                }>(historyResult).filter((row) => typeof row.QUERY_ID === 'string' && row.QUERY_ID.trim().length > 0);

                if (historyRows.length === 0) {
                    vscode.window.showWarningMessage(
                        'No recent Snowflake query history was returned for this session.',
                    );
                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    historyRows.map((row) => ({
                        label: row.QUERY_ID!,
                        description: [row.WAREHOUSE_NAME, row.EXECUTION_STATUS].filter(Boolean).join(' | '),
                        detail: (row.QUERY_TEXT || '').slice(0, 120),
                    })),
                    { placeHolder: 'Select a recent Snowflake query to inspect' },
                );
                if (!selected) {
                    return;
                }

                const profileResult = await runQueryRaw({
                    context,
                    query: buildSnowflakeQueryOperatorStatsQuery(`'${selected.label.replace(/'/g, "''")}'`),
                    silent: true,
                    connectionManager,
                    connectionName,
                    isUserQuery: false,
                });
                const profileRows = queryResultToRows<Record<string, unknown>>(profileResult);
                const markdown = [
                    renderSnowflakeQueryProfileMarkdown(profileRows),
                    '',
                    '## Query Text',
                    '',
                    '```sql',
                    historyRows.find((row) => row.QUERY_ID === selected.label)?.QUERY_TEXT || '-- unavailable --',
                    '```',
                ].join('\n');
                await openDraft(markdown, 'markdown', connectionName);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to load Snowflake query profile: ${message}`);
            }
        }),

        // Refresh schema
        vscode.commands.registerCommand('netezza.refreshSchema', async () => {
            await metadataCache.clearCache();
            schemaProvider.clearAllErrors();
            schemaProvider.refresh();

            const editor = vscode.window.activeTextEditor;
            const documentUri = editor?.document?.uri?.toString();
            const activeConnectionName =
                connectionManager.getConnectionForExecution(documentUri) || connectionManager.getActiveConnectionName();

            if (
                activeConnectionName &&
                supportsLegacyMetadataPrefetch(connectionManager.getConnectionDatabaseKind(activeConnectionName))
            ) {
                metadataCache.triggerConnectionPrefetch(activeConnectionName, (q) =>
                    runQueryRaw(
                        context,
                        q,
                        true,
                        connectionManager,
                        activeConnectionName,
                        undefined,
                        undefined,
                        undefined,
                        1000000,
                        false,
                    ),
                );
                vscode.window.showInformationMessage('Schema refreshed. Metadata is rebuilding in background...');
            } else {
                vscode.window.showInformationMessage('Schema refreshed (Cache cleared).');
            }
        }),

        // Jump to schema from cursor
        vscode.commands.registerCommand('netezza.jumpToSchema', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const document = editor.document;
            const selection = editor.selection;
            const offset = document.offsetAt(selection.active);

            const objectInfo = SqlParser.getObjectAtPosition(document.getText(), offset);

            if (objectInfo) {
                vscode.commands.executeCommand('netezza.revealInSchema', objectInfo);
            } else {
                vscode.window.showWarningMessage('No object found at cursor');
            }
        }),

        // Run script from CodeLens
        vscode.commands.registerCommand('netezza.runScriptFromLens', async (uri: vscode.Uri, range: vscode.Range) => {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const text = doc.getText(range).trim() || doc.lineAt(range.start.line).text.trim();
                if (!text) {
                    vscode.window.showWarningMessage('No script command found');
                    return;
                }

                const tokens = text.split(/\s+/);
                const first = tokens[0] || '';
                const isPythonExec =
                    /python(\.exe)?$/i.test(first) && tokens.length >= 2 && tokens[1].toLowerCase().endsWith('.py');
                const isScriptDirect = first.toLowerCase().endsWith('.py');
                const config = getExtensionConfiguration();
                const pythonPath = config.get<string>('pythonPath') || 'python';

                let cmd = '';
                if (isPythonExec) {
                    const py = tokens[0];
                    const script = tokens[1];
                    const args = tokens.slice(2);
                    cmd = buildExecCommand(py, script, args);
                } else if (isScriptDirect) {
                    const script = first;
                    const args = tokens.slice(1);
                    cmd = buildExecCommand(pythonPath, script, args);
                } else {
                    const args = tokens;
                    cmd = buildExecCommand(pythonPath, '', args);
                }

                const term = vscode.window.createTerminal({ name: 'JustyBase: Script' });
                term.show(true);
                term.sendText(cmd, true);
                vscode.window.showInformationMessage(`Running script: ${cmd}`);
            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Error running script: ${errorMsg}`);
            }
        }),

        // Clear autocomplete cache
        vscode.commands.registerCommand('netezza.clearAutocompleteCache', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to clear the autocomplete cache? This will remove all cached databases, schemas, tables, and columns.',
                { modal: true },
                'Clear Cache',
            );

            if (confirm === 'Clear Cache') {
                await metadataCache.clearCache();
                vscode.window.showInformationMessage(
                    'Autocomplete cache cleared successfully. Cache will be rebuilt on next use.',
                );
            }
        }),

        vscode.commands.registerCommand('netezza.showMetadataCacheStats', async () => {
            const connectionName = resolveActiveConnectionName();
            if (!connectionName) {
                vscode.window.showWarningMessage('No active connection. Select a connection first.');
                return;
            }

            const report = renderMetadataCacheStatsReport(connectionName);
            if (!report) {
                vscode.window.showInformationMessage(
                    `No metadata cache stats recorded yet for connection: ${connectionName}`,
                );
                return;
            }

            metadataCache.logStats(connectionName);
            await openDraft(report, 'markdown', connectionName);
        }),

        vscode.commands.registerCommand('netezza.showResultPanelPerformanceStats', async () => {
            const report = resultPanelProvider.getPerformanceStatsReport();
            if (!report) {
                vscode.window.showInformationMessage(
                    'No result panel performance samples recorded yet. Run queries and open results first.'
                );
                return;
            }

            await openDraft(report, 'markdown', resolveActiveConnectionName());
        }),

        vscode.commands.registerCommand('netezza.clearResultPanelPerformanceStats', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Clear stored result panel first-paint samples? This resets the local runtime baseline used for dogfooding reports.',
                { modal: true },
                'Clear Stats',
            );

            if (confirm !== 'Clear Stats') {
                return;
            }

            await resultPanelProvider.clearPerformanceStats();
            vscode.window.showInformationMessage('Result panel performance stats cleared.');
        }),

  // Copy selection from results
  vscode.commands.registerCommand('netezza.copySelection', () => {
    resultPanelProvider.triggerCopySelection();
  }),

// Select All in results grid
	vscode.commands.registerCommand('netezza.resultsSelectAll', () => {
		resultPanelProvider.triggerSelectAll();
	}),

  // ETL Designer Commands
        vscode.commands.registerCommand('netezza.openEtlDesigner', () => {
            EtlDesignerView.setConnectionManager(connectionManager);
            EtlDesignerView.createOrShow(context);
        }),

        vscode.commands.registerCommand('netezza.newEtlProject', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Enter ETL project name',
                value: 'New ETL Project',
            });
            if (name) {
                const projectManager = EtlProjectManager.getInstance();
                projectManager.createProject(name);
                EtlDesignerView.setConnectionManager(connectionManager);
                EtlDesignerView.createOrShow(context);
            }
        }),

        vscode.commands.registerCommand('netezza.openEtlProject', async () => {
            const files = await vscode.window.showOpenDialog({
                filters: { 'ETL Project': ['etl.json'] },
                canSelectMany: false,
            });
            if (files && files[0]) {
                try {
                    const projectManager = EtlProjectManager.getInstance();
                    const project = await projectManager.loadProject(files[0].fsPath);
                    EtlDesignerView.setConnectionManager(connectionManager);
                    EtlDesignerView.createOrShow(context, project);
                    vscode.window.showInformationMessage(`ETL project loaded: ${project.name}`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to load ETL project: ${error}`);
                }
            }
        }),

        vscode.commands.registerCommand('netezza.runEtlProject', async () => {
            const projectManager = EtlProjectManager.getInstance();
            const project = projectManager.getCurrentProject();
            if (!project) {
                vscode.window.showWarningMessage(
                    'No ETL project is currently open. Please open or create a project first.',
                );
                return;
            }
            EtlDesignerView.setConnectionManager(connectionManager);
            EtlDesignerView.createOrShow(context, project);
            vscode.window.showInformationMessage('ETL project opened. Use the Run button in the designer to execute.');
        }),

        // ========== CodeLens Commands ==========

        // Run single statement from CodeLens
        vscode.commands.registerCommand(
            'netezza.runStatementFromLens',
            async (uri: vscode.Uri, statementSql: string) => {
                if (uri.scheme === 'vscode-notebook-cell') {
                    return;
                }
                if (!statementSql || !statementSql.trim()) {
                    vscode.window.showWarningMessage('No SQL statement to execute');
                    return;
                }

                const sourceUri = uri.toString();
                const queries = [statementSql.trim()];

                const timer = createPerformanceTimer('query.run_from_lens', {
                    payloadSize: statementSql.length,
                });

                try {
                    resultPanelProvider.setActiveSource(sourceUri);
                    resultPanelProvider.startExecution(sourceUri);

                    const config = getExtensionConfiguration();
                    const enableStreaming = config.get<boolean>('enableStreaming', true);
                    const streamingChunkSize = config.get<number>('streamingChunkSize', 5000);

                    const queryStartCallback = (_queryIndex: number, sql: string, connName: string): string => {
                        return resultPanelProvider.logExecutionStart(sourceUri, sql.trim(), connName);
                    };

                    const queryEndCallback = (
                        executionId: string,
                        rowCount: number,
                        _durationMs: number,
                        status: 'success' | 'error' | 'cancelled' | 'retrying',
                        error?: string,
                    ) => {
                        resultPanelProvider.logExecutionEnd(executionId, rowCount, status, error);
                    };

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: `Running statement from CodeLens...`,
                            cancellable: false,
                        },
                        async () => {
                            if (enableStreaming) {
                                await runQueriesWithStreaming(
                                    context,
                                    queries,
                                    connectionManager,
                                    sourceUri,
                                    (msg) => resultPanelProvider.log(sourceUri, msg),
                                    (queryIndex, chunk, sql) => {
                                        resultPanelProvider.appendStreamingChunk(sourceUri, queryIndex, chunk, sql);
                                    },
                                    streamingChunkSize,
                                    undefined,
                                    false,
                                    undefined,
                                    queryStartCallback,
                                    queryEndCallback,
                                    undefined,
                                    0,
                                    undefined,
                                    ddlBatchOptions,
                                );
                            } else {
                                await runQueriesSequentially(
                                    context,
                                    queries,
                                    connectionManager,
                                    sourceUri,
                                    (msg) => resultPanelProvider.log(sourceUri, msg),
                                    (queryResults) => resultPanelProvider.updateResults(queryResults, sourceUri, true),
                                    undefined,
                                    false,
                                    undefined,
                                    queryStartCallback,
                                    queryEndCallback,
                                    undefined,
                                    0,
                                    undefined,
                                    [],
                                    ddlBatchOptions,
                                );
                            }
                        },
                    );

                    resultPanelProvider.finalizeExecution(sourceUri);
                    await vscode.commands.executeCommand('netezza.results.focus');
                    const ev = timer.finish({ result: 'ok', metadata: { query_count: 1 } });
                    console.log(formatPerformanceEvent(ev));
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.includes('Query cancelled')) {
                        resultPanelProvider.log(sourceUri, 'Query execution cancelled by user.');
                        resultPanelProvider.finalizeExecution(sourceUri);
                        return;
                    }
                    resultPanelProvider.updateResults(
                        [{ columns: [], data: [], message: msg, isError: true, sql: statementSql }],
                        sourceUri,
                        true,
                    );
                    resultPanelProvider.finalizeExecution(sourceUri);
                    const ev = timer.finish({ result: 'error', errorCode: msg.slice(0, 50) });
                    console.log(formatPerformanceEvent(ev));
                    vscode.window.showErrorMessage(`Error executing query: ${msg}`);
                }
            },
        ),

        // Compile full CREATE PROCEDURE block from CodeLens
        vscode.commands.registerCommand(
            'netezza.compileProcedureFromLens',
            async (uri: vscode.Uri, procedureSql: string) => {
                if (uri.scheme === 'vscode-notebook-cell') {
                    return;
                }
                if (!procedureSql || !procedureSql.trim()) {
                    vscode.window.showWarningMessage('No procedure block to compile');
                    return;
                }

                const sourceUri = uri.toString();
                const sql = procedureSql.trim();
                const timer = createPerformanceTimer('query.compile_procedure_from_lens', {
                    payloadSize: sql.length,
                });

                try {
                    resultPanelProvider.setActiveSource(sourceUri);
                    resultPanelProvider.startExecution(sourceUri);

                    const queryStartCallback = (_queryIndex: number, query: string, connName: string): string => {
                        return resultPanelProvider.logExecutionStart(sourceUri, query.trim(), connName);
                    };

                    const queryEndCallback = (
                        executionId: string,
                        rowCount: number,
                        _durationMs: number,
                        status: 'success' | 'error' | 'cancelled' | 'retrying',
                        error?: string,
                    ) => {
                        resultPanelProvider.logExecutionEnd(executionId, rowCount, status, error);
                    };

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: 'Compiling stored procedure...',
                            cancellable: false,
                        },
                        async () => {
                            await runQueriesSequentially(
                                context,
                                [sql],
                                connectionManager,
                                sourceUri,
                                (msg) => resultPanelProvider.log(sourceUri, msg),
                                (queryResults) => resultPanelProvider.updateResults(queryResults, sourceUri, true),
                                undefined,
                                false,
                                undefined,
                                queryStartCallback,
                                queryEndCallback,
                                undefined,
                                0,
                                undefined,
                                [],
                                ddlBatchOptions,
                            );
                        },
                    );

                    resultPanelProvider.finalizeExecution(sourceUri);
                    await vscode.commands.executeCommand('netezza.results.focus');
                    const ev = timer.finish({ result: 'ok', metadata: { query_count: 1 } });
                    console.log(formatPerformanceEvent(ev));
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.includes('Query cancelled')) {
                        resultPanelProvider.log(sourceUri, 'Procedure compilation cancelled by user.');
                        resultPanelProvider.finalizeExecution(sourceUri);
                        const ev = timer.finish({ result: 'cancelled', errorCode: 'QUERY_CANCELLED' });
                        console.log(formatPerformanceEvent(ev));
                        return;
                    }

                    resultPanelProvider.updateResults(
                        [{ columns: [], data: [], message: msg, isError: true, sql }],
                        sourceUri,
                        true,
                    );
                    resultPanelProvider.finalizeExecution(sourceUri);
                    const ev = timer.finish({ result: 'error', errorCode: msg.slice(0, 50) });
                    console.log(formatPerformanceEvent(ev));
                    vscode.window.showErrorMessage(`Procedure compilation failed: ${msg}`);
                }
            },
        ),

        // Explain statement from CodeLens
        vscode.commands.registerCommand(
            'netezza.explainStatementFromLens',
            async (uri: vscode.Uri, statementSql: string) => {
                if (!statementSql || !statementSql.trim()) {
                    vscode.window.showWarningMessage('No SQL statement to explain');
                    return;
                }

                const sourceUri = uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(sourceUri);
                if (!connectionName) {
                    vscode.window.showErrorMessage('No database connection. Please connect first.');
                    return;
                }

                try {
                    const explainSql = `EXPLAIN VERBOSE ${statementSql.trim()}`;

                    const explainResult = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: 'Running EXPLAIN...',
                            cancellable: false,
                        },
                        async () => {
                            return await runExplainQuery(
                                context,
                                explainSql,
                                connectionName,
                                connectionManager,
                                sourceUri,
                            );
                        },
                    );

                    if (explainResult && explainResult.trim()) {
                        const doc = await vscode.workspace.openTextDocument({
                            content: explainResult,
                            language: 'plaintext',
                        });
                        await vscode.window.showTextDocument(doc, { preview: true });
                    } else {
                        vscode.window.showInformationMessage('EXPLAIN returned no output.');
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`EXPLAIN failed: ${msg}`);
                }
            },
        ),

        // Export statement from CodeLens
        vscode.commands.registerCommand(
            'netezza.exportStatementFromLens',
            async (uri: vscode.Uri, statementSql: string) => {
                if (!statementSql || !statementSql.trim()) {
                    vscode.window.showWarningMessage('No SQL statement to export');
                    return;
                }

                const sourceUri = uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(sourceUri);
                if (!connectionName) {
                    vscode.window.showErrorMessage('No database connection. Please connect first.');
                    return;
                }

                // Ask for export format
                const format = await vscode.window.showQuickPick(
                    [
                        {
                            label: '$(file-binary) XLSB',
                            description: 'Excel Binary Workbook (faster, smaller)',
                            value: 'xlsb',
                        },
                        { label: '$(file) XLSX', description: 'Excel Workbook (wider compatibility)', value: 'xlsx' },
                        { label: '$(file-text) CSV', description: 'Comma-Separated Values', value: 'csv' },
                        { label: '$(file-zip) CSV.GZ', description: 'Gzip-compressed CSV', value: 'csv.gz' },
                        { label: '$(file-zip) CSV.ZST', description: 'Zstandard-compressed CSV', value: 'csv.zst' },
                        { label: '$(database) Parquet', description: 'Apache Parquet (columnar, compressed)', value: 'parquet' },
                        { label: '$(file-binary) SAS XPORT', description: 'SAS Transport Format v5 (.xpt)', value: 'xpt' },
                    ],
                    { placeHolder: 'Select export format' },
                );

                if (!format) return;

                // Show save dialog with appropriate filter
                const filters: Record<string, string[]> =
                    format.value === 'xlsb'
                        ? { 'Excel Binary Workbook': ['xlsb'] }
                        : format.value === 'xlsx'
                          ? { 'Excel Workbook': ['xlsx'] }
                          : format.value === 'parquet'
                            ? { 'Parquet Files': ['parquet'] }
                            : format.value === 'xpt'
                              ? { 'SAS XPORT Files': ['xpt'] }
                              : format.value === 'csv.gz'
                                ? { 'CSV.GZ Files': ['csv.gz'] }
                                : format.value === 'csv.zst'
                                  ? { 'CSV.ZST Files': ['csv.zst'] }
                                  : { 'CSV Files': ['csv'] };

                const saveUri = await vscode.window.showSaveDialog({
                    filters,
                    saveLabel: `Export to ${format.value.toUpperCase()}`,
                });

                if (!saveUri) return;

                try {
                    const connectionDetails = await connectionManager.getConnection(connectionName);
                    if (!connectionDetails) {
                        throw new Error('Connection not configured. Please connect via Netezza: Connect...');
                    }

                    const config = getExtensionConfiguration();
                    const queryTimeout = config.get<number>('query.executionTimeout', 1800);

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: `Exporting to ${format.value.toUpperCase()}...`,
                            cancellable: true,
                        },
                        async (progress, token) => {
                            if (format.value === 'csv' || format.value === 'csv.gz' || format.value === 'csv.zst') {
                                const { exportToCsv } = await import('../export/csvExporter');
                                await exportToCsv(
                                    connectionDetails,
                                    statementSql.trim(),
                                    saveUri.fsPath,
                                    progress,
                                    queryTimeout,
                                    token,
                                );
                            } else if (format.value === 'xlsx') {
                                const { exportQueryToXlsx } = await import('../export/xlsxExporter');
                                const result = await exportQueryToXlsx(
                                    connectionDetails,
                                    statementSql.trim(),
                                    saveUri.fsPath,
                                    false,
                                    (message: string) => {
                                        progress.report({ message });
                                    },
                                    queryTimeout,
                                    token,
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else if (format.value === 'parquet') {
                                const { exportQueryToParquet } = await import('../export/parquetExporter');
                                const result = await exportQueryToParquet(
                                    connectionDetails,
                                    statementSql.trim(),
                                    saveUri.fsPath,
                                    false,
                                    (message: string) => {
                                        progress.report({ message });
                                    },
                                    queryTimeout,
                                    token,
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else if (format.value === 'xpt') {
                                const { exportQueryToXpt } = await import('../export/xptExporter');
                                const result = await exportQueryToXpt(
                                    connectionDetails,
                                    statementSql.trim(),
                                    saveUri.fsPath,
                                    false,
                                    (message: string) => {
                                        progress.report({ message });
                                    },
                                    queryTimeout,
                                    token,
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else {
                                const { exportQueryToXlsb } = await import('../export/xlsbExporter');
                                const result = await exportQueryToXlsb(
                                    connectionDetails,
                                    statementSql.trim(),
                                    saveUri.fsPath,
                                    false,
                                    (message: string) => {
                                        progress.report({ message });
                                    },
                                    queryTimeout,
                                    token,
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            }
                        },
                    );

                    vscode.window.showInformationMessage(`Results exported to ${saveUri.fsPath}`);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Export failed: ${msg}`);
                }
            },
        ),

        vscode.commands.registerCommand(
            'netezza.visualizeQueryFlow',
            async (uri: vscode.Uri, statementStartOffset: number) => {
                try {
                    const existingDocument = vscode.workspace.textDocuments.find(
                        (document) => document.uri.toString() === uri.toString(),
                    );
                    const document = existingDocument ?? (await vscode.workspace.openTextDocument(uri));
                    const activeEditor =
                        vscode.window.activeTextEditor?.document.uri.toString() === uri.toString()
                            ? vscode.window.activeTextEditor
                            : undefined;
                    const sourceEditor =
                        activeEditor ?? findVisibleQueryFlowEditor(vscode.window.visibleTextEditors, uri);
                    const [{ analyzeSqlQueryStructures }, { QueryFlowView }] = await Promise.all([
                        import('../sqlParser/queryStructureAnalyzer'),
                        import('../views/queryFlowView'),
                    ]);
                    const analysis = analyzeSqlQueryStructures(
                        document.getText(),
                        connectionManager.getExecutionDatabaseKind(uri.toString()),
                    );
                    const graph =
                        analysis.statementFlows.find(
                            (flow) => flow.statementRange.startOffset === statementStartOffset,
                        ) ??
                        analysis.statementFlows.find(
                            (flow) =>
                                statementStartOffset >= flow.statementRange.startOffset &&
                                statementStartOffset <= flow.statementRange.endOffset,
                        );

                    if (!graph) {
                        vscode.window.showWarningMessage(
                            'No visualizable query flow was found for the selected statement.',
                        );
                        return;
                    }

                    QueryFlowView.createOrShow(graph, (node) =>
                        revealQueryFlowNode(uri, node, sourceEditor?.viewColumn),
                    );
                } catch (error: unknown) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Unable to visualize query flow: ${message}`);
                }
            },
        ),

        // Export with format picker (for top-level CodeLens)
        vscode.commands.registerCommand(
            'netezza.exportWithFormatPicker',
            async () => {
                const format = await vscode.window.showQuickPick(
                    [
                        { label: '$(file-binary) XLSB', description: 'Excel Binary Workbook (faster, smaller)', value: 'xlsb' },
                        { label: '$(file) XLSX', description: 'Excel Workbook (wider compatibility)', value: 'xlsx' },
                        { label: '$(file-text) CSV', description: 'Comma-Separated Values', value: 'csv' },
                        { label: '$(file-zip) CSV.GZ', description: 'Gzip-compressed CSV', value: 'csv.gz' },
                        { label: '$(file-zip) CSV.ZST', description: 'Zstandard-compressed CSV', value: 'csv.zst' },
                        { label: '$(database) Parquet', description: 'Apache Parquet (columnar, compressed)', value: 'parquet' },
                    ],
                    { placeHolder: 'Select export format' },
                );
                if (!format) return;

                if (format.value === 'csv' || format.value === 'csv.gz' || format.value === 'csv.zst') {
                    await vscode.commands.executeCommand('netezza.exportToCsv', { format: format.value });
                    return;
                }

                await vscode.commands.executeCommand(
                    'netezza.exportTo' + format.value.charAt(0).toUpperCase() + format.value.slice(1),
                    { format: format.value },
                );
            },
        ),

        {
            dispose: () => {
                if (queryFlowRevealTimeout) {
                    clearTimeout(queryFlowRevealTimeout);
                    queryFlowRevealTimeout = undefined;
                }
                clearQueryFlowReveal(queryFlowHighlightedEditor);
                queryFlowHighlightedEditor = undefined;
                queryFlowRevealDecoration?.dispose();
                queryFlowRevealDecoration = undefined;
            },
        },
    ];
}
