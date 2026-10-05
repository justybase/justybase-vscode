import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { QueryHistoryManager } from '../core/queryHistoryManager';
import { SqlParser } from '../sql/sqlParser';
import { extractProcedureBaseName } from '../metadata/procedureSignatureUtils';
import type { SchemaItemData } from './schema/itemTypes';
import { DatabaseAnalysisService } from '../services/analysis/databaseAnalysisService';
import { DatabaseAnalysisView } from '../views/databaseAnalysisView';
import { describeProposedChange, parseProposedChange, type ProposedChange } from '../services/analysis/dependencyIndex';
import type { ObjectReference, AnalysisObjectType } from '../services/analysis/sqlAnalysis';

/** Structured impact input with a classified free-text fallback; the analysis never applies the change. */
async function promptProposedChange(column?: string): Promise<{ change: ProposedChange; described?: string } | undefined> {
    const options = column ? ['Drop column', 'Rename column', 'Change column type', 'Describe other change'] : ['Drop object', 'Rename object', 'Describe other change'];
    const pick = await vscode.window.showQuickPick(options, { placeHolder: 'Impact Analysis — proposed change (analysis does not apply it)' });
    if (pick === undefined) { return undefined; }
    if (pick === 'Drop column' && column) { return { change: { kind: 'dropColumn', column } }; }
    if (pick === 'Drop object') { return { change: { kind: 'dropObject' } }; }
    if (pick === 'Rename object') {
        const to = await vscode.window.showInputBox({ title: 'Rename object — new name' });
        if (to === undefined || !to.trim()) { return undefined; }
        return { change: { kind: 'renameObject', to: to.trim() } };
    }
    if (pick === 'Rename column' && column) {
        const to = await vscode.window.showInputBox({ title: 'Rename column — new name', value: column });
        if (to === undefined || !to.trim()) { return undefined; }
        return { change: { kind: 'renameColumn', from: column, to: to.trim() } };
    }
    if (pick === 'Change column type' && column) {
        const toType = await vscode.window.showInputBox({ title: 'Change column type — new type', prompt: 'e.g. VARCHAR(5)' });
        if (toType === undefined || !toType.trim()) { return undefined; }
        return { change: { kind: 'changeColumnType', column, toType: toType.trim() } };
    }
    const described = await vscode.window.showInputBox({ title: 'Impact Analysis — proposed change', prompt: 'Describe the proposed change (analysis does not apply it).' });
    if (described === undefined || !described.trim()) { return undefined; }
    return { change: parseProposedChange(described, column), described: described.trim() };
}

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
        let change: ProposedChange | undefined;
        let changeText: string | undefined;
        if (impact) {
            const prompted = await promptProposedChange(column);
            if (!prompted) { return; }
            change = prompted.change;
            changeText = prompted.described ?? describeProposedChange(change, root);
        }
        const action = async (depth: number, token: vscode.CancellationToken) => {
            const report = await service.dependencies(connection, root, direction, depth, token, impact ? undefined : column, change);
            report.proposedChange = changeText; return report;
        };
        const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading dependency catalog', cancellable: true }, (_progress, token) => action(2, token));
        const panel = new DatabaseAnalysisView(context, changeText ? `Impact: ${changeText}` : direction === 'incoming' ? 'Used By' : 'Dependencies', { dependencies: action, onDispose: () => panels.delete(panel), openObject: openObject(connection) });
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
