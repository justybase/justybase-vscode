import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { QueryHistoryManager } from '../core/queryHistoryManager';
import { SqlParser } from '../sql/sqlParser';
import { extractProcedureBaseName } from '../metadata/procedureSignatureUtils';
import type { SchemaItemData } from './schema/itemTypes';
import { DatabaseAnalysisService } from '../services/analysis/databaseAnalysisService';
import { DatabaseAnalysisView } from '../views/databaseAnalysisView';
import type { ObjectReference, AnalysisObjectType } from '../services/analysis/sqlAnalysis';

export function registerDatabaseAnalysisCommands(context: vscode.ExtensionContext, manager: ConnectionManager, cache: MetadataCache): vscode.Disposable[] {
    const service = new DatabaseAnalysisService(context, manager, cache);
    const panels = new Set<DatabaseAnalysisView>();
    const openObject = (connection: string) => async (object: ObjectReference) => {
        if (object.type === 'UNKNOWN') { await vscode.window.showInformationMessage('Object type could not be resolved. Locate this object in Schema Browser to open its definition.'); return; }
        return vscode.commands.executeCommand('netezza.createDDL', {
        label: object.name, rawLabel: object.name, dbName: object.database, schema: object.schema,
        objType: object.type, connectionName: connection
    });
    };
    const guarded = (action: () => Promise<void>) => async () => {
        try { await action(); }
        catch (error) { if (!(error instanceof vscode.CancellationError)) { void vscode.window.showErrorMessage(`Database analysis: ${error instanceof Error ? error.message : String(error)}`); } }
    };
    const dependencies = async (item: SchemaItemData, direction: 'incoming' | 'outgoing', impact: boolean) => {
        const column = item?.contextValue === 'column' ? item.rawLabel ?? item.label : undefined;
        const name = column ? item.parentName : item?.rawLabel ?? item?.label;
        const connection = item?.connectionName ?? manager.getConnectionForExecution();
        if (!name || !item.dbName || !item.schema || !connection) { throw new Error('Select a database object or column in Schema Browser.'); }
        if (manager.getConnectionDatabaseKind(connection) !== 'netezza') { throw new Error('Dependencies and impact analysis currently support Netezza.'); }
        const type = (column ? 'TABLE' : item.objType ?? item.contextValue?.replace(/^netezza:/, '') ?? 'UNKNOWN') as AnalysisObjectType;
        const root: ObjectReference = { database: item.dbName, schema: item.schema, name: type === 'PROCEDURE' ? extractProcedureBaseName(name) : name, type };
        let change: string | undefined;
        if (impact) {
            change = await vscode.window.showInputBox({ title: 'Impact Analysis — proposed change', prompt: 'Describe the proposed change (analysis does not apply it).', value: column ? `Drop or change column ${root.name}.${column}` : `Drop or change ${root.name}` });
            if (change === undefined) { return; }
        }
        const action = async (depth: number, token: vscode.CancellationToken) => {
            const report = await service.dependencies(connection, root, direction, depth, token, column);
            report.proposedChange = change; return report;
        };
        const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading dependency catalog', cancellable: true }, (_progress, token) => action(2, token));
        const panel = new DatabaseAnalysisView(context, change ? `Impact: ${change}` : direction === 'incoming' ? 'Used By' : 'Dependencies', { dependencies: action, onDispose: () => panels.delete(panel), openObject: openObject(connection) });
        panels.add(panel); panel.showDependencies(report);
    };
    const performance = async (lastExecution = false) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.languageId.toLowerCase().includes('sql')) { throw new Error('Open a SQL editor to analyze a statement.'); }
        const document = editor.document;
        const uri = document.uri.toString();
        let connection = manager.getConnectionForExecution(uri);
        let database = connection ? await manager.getEffectiveDatabase(uri, connection) : null;
        let schema = connection ? await manager.getEffectiveSchema(uri, connection) : null;
        let sql: string | undefined;
        let offset = editor.selection.isEmpty ? 0 : document.offsetAt(editor.selection.start);
        let originalText = document.getText();
        if (lastExecution) {
            const history = await QueryHistoryManager.getInstance(context).getHistory();
            const entry = history.find(h => h.connectionName === connection);
            if (!entry) { throw new Error('No recent execution for this connection.'); }
            sql = entry.query; database = entry.database; schema = entry.schema; connection = entry.connectionName;
            originalText = ''; // Historical SQL cannot be mapped reliably into the current editor.
        } else if (!editor.selection.isEmpty) { sql = document.getText(editor.selection); }
        else {
            const statement = SqlParser.getStatementAtPosition(originalText, document.offsetAt(editor.selection.active));
            sql = statement?.sql; offset = statement?.start ?? 0;
        }
        if (!sql?.trim() || !connection || !database) { throw new Error('Select SQL and connect to a database before analyzing.'); }
        if (manager.getConnectionDatabaseKind(connection) !== 'netezza') { throw new Error('Performance Advisor currently supports Netezza.'); }
        const statements = SqlParser.splitStatements(sql).filter(s => s.trim());
        if (statements.length !== 1) { throw new Error('Select one statement for performance analysis.'); }
        const capturedSql = sql;
        const target: ObjectReference = { database, schema: schema ?? cache.getDefaultSchema(connection, database) ?? '', name: 'QUERY', type: 'UNKNOWN' };
        const action = (measureSkew: boolean, token: vscode.CancellationToken) => service.performance(connection!, capturedSql, target, token, measureSkew);
        const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing SQL (metadata + EXPLAIN only)', cancellable: true }, (_progress, token) => action(false, token));
        const panel = new DatabaseAnalysisView(context, 'Netezza Performance Advisor', { performance: action, onDispose: () => panels.delete(panel), openObject: openObject(connection),
            showSql: async (start, end) => {
                if (!originalText || document.isClosed || document.getText() !== originalText) { void vscode.window.showInformationMessage('The editor changed since analysis. Reanalyze to navigate to SQL.'); return; }
                const current = await vscode.window.showTextDocument(document);
                current.selection = new vscode.Selection(document.positionAt(offset + start), document.positionAt(offset + end)); current.revealRange(current.selection);
            }
        });
        panels.add(panel); panel.showPerformance(report);
    };
    return [service, { dispose: () => { panels.forEach(panel => panel.dispose()); panels.clear(); } },
        ...(['showDependencies','showUsedBy','impactAnalysis','findColumnReferences'] as const).map(command => vscode.commands.registerCommand(`netezza.${command}`, (item: SchemaItemData) => guarded(() => dependencies(item, command === 'showDependencies' ? 'outgoing' : 'incoming', command === 'impactAnalysis'))())),
        vscode.commands.registerCommand('netezza.analyzeQueryPerformance', guarded(() => performance())),
        vscode.commands.registerCommand('netezza.analyzeLastExecution', guarded(() => performance(true)))
    ];
}
