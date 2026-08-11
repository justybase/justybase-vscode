import * as vscode from 'vscode';
import type {
    MigrationWizardAnalysisState,
    MigrationWizardCatalog,
    MigrationWizardCatalogTable,
    MigrationWizardConnection,
    MigrationWizardHostToWebviewMessage,
    MigrationWizardProgressState,
    MigrationWizardSourceState,
    MigrationWizardState,
    MigrationWizardTargetState,
    MigrationWizardWebviewToHostMessage,
} from '../contracts/webviews/migrationWizardContracts';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import { validateCustomCreateTableDdl } from '../migration/ddlValidation';
import { MigrationService } from '../migration/migrationService';
import type { MigrationPlan, MigrationRequest, MigrationSourceContext } from '../migration/types';
import { resolveMigrationTargetDatabase } from './migrationWizardDefaults';

export interface MigrationWizardSessionOptions {
    source: MigrationWizardSourceState;
    targetConnectionName?: string;
    targetDatabase?: string;
    targetSchema?: string;
    targetTable?: string;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function toConnectionOption(details: { name?: string; dbType?: string; database?: string; schema?: string }): MigrationWizardConnection | undefined {
    if (!details.name) return undefined;
    return {
        name: details.name,
        kind: tryNormalizeDatabaseKind(details.dbType) ?? 'netezza',
        database: details.database,
        schema: details.schema,
    };
}

export class MigrationWizardView {
    public static readonly viewType = 'netezza.migrationWizard';
    private static currentPanel: MigrationWizardView | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private readonly service: MigrationService;
    private state: MigrationWizardState;
    private request?: MigrationRequest;
    private plan?: MigrationPlan;
    private sourceContext?: MigrationSourceContext;
    private lastExecution?: { connectionName: string; database?: string; targetQualifiedName: string };

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        options: MigrationWizardSessionOptions,
    ) {
        this.service = new MigrationService({ connectionManager });
        this.state = this.createState(options, []);
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
                vscode.Uri.joinPath(context.extensionUri, 'dist'),
            ],
        };
        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(
            (message: MigrationWizardWebviewToHostMessage) => this.handleMessage(message),
            null,
            this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    public static async createOrShow(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        options: MigrationWizardSessionOptions,
    ): Promise<MigrationWizardView> {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        if (MigrationWizardView.currentPanel) {
            MigrationWizardView.currentPanel.panel.reveal(column);
            await MigrationWizardView.currentPanel.loadSession(options);
            return MigrationWizardView.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            MigrationWizardView.viewType,
            'Migration Studio',
            column,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const view = new MigrationWizardView(panel, context, connectionManager, options);
        MigrationWizardView.currentPanel = view;
        await view.loadSession(options);
        return view;
    }

    public async loadSession(options: MigrationWizardSessionOptions): Promise<void> {
        this.request = undefined;
        this.plan = undefined;
        this.sourceContext = undefined;
        this.lastExecution = undefined;
        this.state = this.createState(options, await this.getConnectionOptions());
        this.panel.title = 'Migration Studio';
        this.postState();
        this.reloadCatalog();
    }

    public dispose(): void {
        if (MigrationWizardView.currentPanel === this) {
            MigrationWizardView.currentPanel = undefined;
        }
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    private async getConnectionOptions(): Promise<MigrationWizardConnection[]> {
        const connections = await this.connectionManager.getConnections();
        return connections
            .map(toConnectionOption)
            .filter((connection): connection is MigrationWizardConnection => Boolean(connection));
    }

    private createState(options: MigrationWizardSessionOptions, connections: MigrationWizardConnection[]): MigrationWizardState {
        const sourceTable = options.source.table || 'MIGRATED_RESULT';
        const targetConnectionName = options.targetConnectionName || options.source.connectionName;
        return {
            connections,
            source: options.source,
            target: {
                connectionName: targetConnectionName,
                database: resolveMigrationTargetDatabase(options.targetDatabase, targetConnectionName, connections),
                schema: options.targetSchema,
                table: options.targetTable || `${sourceTable}_MIGRATED`,
                appendToExistingTable: false,
            },
            executing: false,
            counting: false,
        };
    }

    private post(message: MigrationWizardHostToWebviewMessage): void {
        void this.panel.webview.postMessage(message).then(undefined, () => undefined);
    }

    private postState(): void {
        this.post({ type: 'state', state: this.state });
    }

    private postProgress(progress: MigrationWizardProgressState): void {
        this.state.progress = progress;
        this.post({ type: 'progress', progress });
    }

    private async handleMessage(message: MigrationWizardWebviewToHostMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.postState();
                this.reloadCatalog();
                return;
            case 'analyze':
                await this.analyze(message.source, message.target);
                return;
            case 'countRows':
                await this.countRows();
                return;
            case 'execute':
                await this.execute(message.customCreateTableDdl);
                return;
            case 'requestCatalog':
                await this.loadCatalog(message.connectionName, message.database);
                return;
            case 'openInSqlWindow':
                await this.openInSqlWindow();
                return;
            default:
                return;
        }
    }

    private async analyze(source: MigrationWizardSourceState, target: MigrationWizardTargetState): Promise<void> {
        this.request = undefined;
        this.plan = undefined;
        this.sourceContext = undefined;
        this.lastExecution = undefined;
        this.state.source = source;
        this.state.target = target;
        this.state.error = undefined;
        this.state.analysis = undefined;
        this.state.progress = undefined;
        this.state.counting = false;
        this.postState();
        try {
            if (!source.connectionName || !target.connectionName || !target.table.trim()) {
                throw new Error('Source connection, target connection, and target table are required.');
            }
            if (source.mode === 'table' && !source.table?.trim()) {
                throw new Error('Source table is required.');
            }
            if (source.mode === 'sql' && !source.sql?.trim()) {
                throw new Error('Source SQL is required.');
            }

            const request: MigrationRequest = {
                source: source.mode === 'table'
                    ? {
                        mode: 'table',
                        connectionName: source.connectionName,
                        database: source.database,
                        schema: source.schema,
                        table: source.table!.trim(),
                    }
                    : {
                        mode: 'sql',
                        connectionName: source.connectionName,
                        sql: source.sql!.trim(),
                    },
                target: {
                    connectionName: target.connectionName,
                    database: target.database,
                    schema: target.schema,
                    table: target.table.trim(),
                    appendToExistingTable: target.appendToExistingTable,
                },
            };
            const analysis = await this.service.analyzeSource(request, progress => this.postProgress(toProgressState(progress)));
            const plan = this.service.buildPlan(
                request,
                analysis.sourceContext,
                analysis.columns,
                analysis.pkColumns,
                analysis.warnings,
                analysis.sampleCells,
            );

            this.request = request;
            this.plan = plan;
            this.sourceContext = analysis.sourceContext;
            this.state.analysis = toAnalysisState(plan, plan.totalRows, analysis.warnings);
            this.post({ type: 'analysisUpdated', analysis: this.state.analysis });
        } catch (error) {
            this.state.error = error instanceof Error ? error.message : String(error);
            this.postState();
        }
    }

    private async countRows(): Promise<void> {
        if (!this.request || !this.plan || !this.sourceContext) {
            this.state.error = 'Analyze the migration before counting rows.';
            this.postState();
            return;
        }

        this.state.counting = true;
        this.state.error = undefined;
        this.postState();
        try {
            const totalRows = await this.service.countSourceRows(
                this.request,
                this.sourceContext,
                progress => this.postProgress(toProgressState(progress)),
            );
            this.plan = { ...this.plan, totalRows };
            this.state.analysis = toAnalysisState(this.plan, totalRows, this.plan.warnings);
            this.post({ type: 'analysisUpdated', analysis: this.state.analysis });
        } catch (error) {
            this.state.error = `Row count unavailable: ${error instanceof Error ? error.message : String(error)}`;
            this.postState();
        } finally {
            this.state.counting = false;
            this.postState();
        }
    }

    private async execute(customCreateTableDdl?: string): Promise<void> {
        if (!this.request || !this.plan || !this.sourceContext) {
            this.state.error = 'Analyze the migration before executing it.';
            this.postState();
            return;
        }

        let effectiveCustomDdl: string | undefined;
        if (customCreateTableDdl !== undefined && customCreateTableDdl.trim() !== this.plan.createTableDdl.trim()) {
            if (!this.request.target.appendToExistingTable) {
                const validation = validateCustomCreateTableDdl(
                    customCreateTableDdl,
                    this.plan.columns.map(column => column.targetName),
                    this.plan.targetQualifiedName,
                );
                if (!validation.valid) {
                    this.state.error = validation.message;
                    this.postState();
                    return;
                }
            }
            effectiveCustomDdl = customCreateTableDdl;
        }

        this.state.executing = true;
        this.state.counting = false;
        this.state.error = undefined;
        this.lastExecution = undefined;
        this.postState();
        try {
            const result = await this.service.execute(
                this.request,
                this.plan,
                this.sourceContext,
                progress => this.postProgress(toProgressState(progress)),
                { customCreateTableDdl: effectiveCustomDdl },
            );
            if (!result.success) {
                this.state.executing = false;
                this.lastExecution = undefined;
                this.post({ type: 'executionFailed', message: result.message });
                return;
            }
            this.state.executing = false;
            this.lastExecution = {
                connectionName: this.request.target.connectionName,
                database: this.request.target.database,
                targetQualifiedName: this.plan.targetQualifiedName,
            };
            this.post({ type: 'executionFinished', message: result.message, rowsInserted: result.rowsInserted });
        } catch (error) {
            this.state.executing = false;
            this.lastExecution = undefined;
            this.post({ type: 'executionFailed', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async openInSqlWindow(): Promise<void> {
        const execution = this.lastExecution;
        if (!execution) {
            return;
        }
        const sql = `SELECT * FROM ${execution.targetQualifiedName};\n`;
        const document = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
        this.connectionManager.setDocumentConnection(document.uri.toString(), execution.connectionName);
        if (execution.database) {
            await this.connectionManager.setDocumentDatabase(document.uri.toString(), execution.database);
        }
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private async reloadCatalog(): Promise<void> {
        await this.loadCatalog(this.state.source.connectionName, this.state.source.database);
    }

    private async loadCatalog(connectionName: string, database?: string): Promise<void> {
        const empty: MigrationWizardCatalog = { databases: [], schemas: [], tables: [], loaded: false };
        const metadataCache = this.connectionManager.getMetadataCache();
        if (!connectionName || !metadataCache) {
            this.postCatalog(empty);
            return;
        }

        const databases = (metadataCache.getDatabases(connectionName) ?? [])
            .map(item => typeof item === 'string' ? item : item.DATABASE)
            .filter((name): name is string => Boolean(name));

        const effectiveDatabase = database || databases[0];
        const schemas = effectiveDatabase
            ? (metadataCache.getSchemas(connectionName, effectiveDatabase) ?? [])
                .map(item => item.SCHEMA)
                .filter((name): name is string => Boolean(name))
            : [];

        const tables: MigrationWizardCatalogTable[] = [];
        if (effectiveDatabase) {
            const cachedTables = metadataCache.getTablesAllSchemas(connectionName, effectiveDatabase);
            if (cachedTables !== undefined) {
                for (const table of cachedTables) {
                    const name = table.TABLENAME || table.OBJNAME;
                    if (name && table.SCHEMA) {
                        tables.push({ schema: table.SCHEMA, name });
                    }
                }
            }
        }

        const loaded = databases.length > 0 || schemas.length > 0 || tables.length > 0;
        this.postCatalog({ databases, schemas, tables, loaded });
    }

    private postCatalog(catalog: MigrationWizardCatalog): void {
        this.state.catalog = catalog;
        this.post({ type: 'catalogUpdated', catalog });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'migrationWizard.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'migrationWizard.css'));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="${styleUri}" rel="stylesheet" /></head><body>
            <div id="app"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
    }
}

function toProgressState(progress: { phase: string; rowsRead: number; totalRows?: number; percent: number; message: string; elapsedSeconds: number }): MigrationWizardProgressState {
    return progress;
}

function toAnalysisState(plan: MigrationPlan, totalRows: number | undefined, warnings: string[]): MigrationWizardAnalysisState {
    return {
        sourceKind: plan.sourceKind,
        targetKind: plan.targetKind,
        targetQualifiedName: plan.targetQualifiedName,
        totalRows,
        columns: plan.columns.map(column => ({
            sourceIndex: column.sourceIndex,
            sourceName: column.sourceName,
            sourceType: column.sourceType,
            targetName: column.targetName,
            targetType: column.targetType,
            targetTypeDisplay: column.targetTypeDisplay,
            notNull: column.notNull,
            isPk: column.isPk,
            defaultValue: column.defaultValue,
        })),
        createTableDdl: plan.createTableDdl,
        warnings: [...new Set(warnings)],
    };
}
