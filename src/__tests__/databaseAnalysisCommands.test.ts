jest.unmock('chevrotain');
jest.mock('../services/analysis/databaseAnalysisService');
jest.mock('../views/databaseAnalysisView');
jest.mock('../core/queryHistoryManager',()=>({QueryHistoryManager:{getInstance:jest.fn()}}));
import * as vscode from 'vscode';
import { registerDatabaseAnalysisCommands } from '../commands/databaseAnalysisCommands';
import { DatabaseAnalysisService } from '../services/analysis/databaseAnalysisService';
import { DatabaseAnalysisView } from '../views/databaseAnalysisView';
import { QueryHistoryManager } from '../core/queryHistoryManager';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
function setup() {
    const handlers=new Map<string, (...args:unknown[])=>Promise<void>>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation((name:string,handler:(...args:unknown[])=>Promise<void>)=>{handlers.set(name,handler);return{dispose:jest.fn()};});
    Object.assign(vscode.window,{withProgress:jest.fn(async(_options:unknown,callback:(_progress:unknown,token:vscode.CancellationToken)=>Promise<unknown>)=>callback({},new vscode.CancellationTokenSource().token))});
    const source='SELECT * FROM CUSTOMER;\nSELECT * FROM OTHER;';
    const document={languageId:'sql',uri:{toString:()=> 'file:///test.sql'},isClosed:false,getText:jest.fn(()=>source),offsetAt:jest.fn(()=>5),positionAt:jest.fn((n:number)=>new vscode.Position(0,n))};
    const editor={document,selection:{isEmpty:true,active:new vscode.Position(0,5),start:new vscode.Position(0,0)}};
    Object.assign(vscode.window,{activeTextEditor:editor});
    const manager={getConnectionForExecution:()=> 'NZ',getConnectionDatabaseKind:()=> 'netezza',getEffectiveDatabase:async()=> 'DB',getEffectiveSchema:async()=> 'PUBLIC'};
    const cache={getDefaultSchema:()=> 'PUBLIC'};
    const service={dependencies:jest.fn(async(..._args:unknown[])=>({root:{},direction:'incoming',affected:[],edges:[],issues:[],truncated:false})),performance:jest.fn(async(..._args:unknown[])=>({recommendations:[],issues:[]})),dispose:jest.fn()};
    const panel={showDependencies:jest.fn(),showPerformance:jest.fn(),dispose:jest.fn()};
    (DatabaseAnalysisService as jest.Mock).mockImplementation(()=>service);(DatabaseAnalysisView as jest.Mock).mockImplementation(()=>panel);
    const disposables=registerDatabaseAnalysisCommands({} as vscode.ExtensionContext,manager as unknown as ConnectionManager,cache as unknown as MetadataCache);
    return{handlers,document,editor,service,panel,manager,disposables};
}
describe('analysis command integration',()=>{
    beforeEach(()=>jest.clearAllMocks());
    test('current statement uses captured target; explicit selected multi-statement is rejected',async()=>{
        const {handlers,service,editor,document}=setup();await handlers.get('netezza.analyzeQueryPerformance')!();
        expect(service.performance).toHaveBeenCalledWith('NZ',expect.stringContaining('CUSTOMER'),expect.objectContaining({database:'DB',schema:'PUBLIC'}),expect.anything(),false);
        expect(service.performance.mock.calls[0][1]).not.toContain('OTHER');
        editor.selection.isEmpty=false;document.getText.mockReturnValue('SELECT 1;SELECT 2;');await handlers.get('netezza.analyzeQueryPerformance')!();
        expect(service.performance).toHaveBeenCalledTimes(1);expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('one statement'));
    });
    test('schema column impact supplies root, change model and evidence without applying it',async()=>{
        const {handlers,service,panel}=setup();(vscode.window.showQuickPick as jest.Mock).mockResolvedValue('Drop column');
        await handlers.get('netezza.impactAnalysis')!({label:'EMAIL',parentName:'CUSTOMER',contextValue:'column',dbName:'DB',schema:'PUBLIC',connectionName:'NZ'});
        expect(service.dependencies).toHaveBeenCalledWith('NZ',expect.objectContaining({name:'CUSTOMER',type:'TABLE'}),'incoming',2,expect.anything(),undefined,expect.objectContaining({kind:'dropColumn',column:'EMAIL'}));
        expect(panel.showDependencies).toHaveBeenCalledWith(expect.objectContaining({proposedChange:'Drop column CUSTOMER.EMAIL'}));
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });
    test('free-text impact description is classified into the change model',async()=>{
        const {handlers,service,panel}=setup();(vscode.window.showQuickPick as jest.Mock).mockResolvedValue('Describe other change');
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('Drop EMAIL');
        await handlers.get('netezza.impactAnalysis')!({label:'CUSTOMER',objType:'TABLE',dbName:'DB',schema:'PUBLIC',connectionName:'NZ'});
        expect(service.dependencies).toHaveBeenCalledWith('NZ',expect.objectContaining({name:'CUSTOMER',type:'TABLE'}),'incoming',2,expect.anything(),undefined,expect.objectContaining({kind:'dropObject'}));
        expect(panel.showDependencies).toHaveBeenCalledWith(expect.objectContaining({proposedChange:'Drop EMAIL'}));
    });
    test('last execution preserves history target and requires matching connection',async()=>{
        const {handlers,service}=setup();(QueryHistoryManager.getInstance as jest.Mock).mockReturnValue({getHistory:async()=>[{query:'SELECT * FROM HISTORICAL',database:'OLD_DB',schema:'OLD_SCHEMA',connectionName:'NZ'}]});
        await handlers.get('netezza.analyzeLastExecution')!();expect(service.performance).toHaveBeenCalledWith('NZ','SELECT * FROM HISTORICAL',expect.objectContaining({database:'OLD_DB',schema:'OLD_SCHEMA'}),expect.anything(),false);
    });
    test('only procedure signatures lose argument lists; table names remain intact',async()=>{
        const {handlers,service}=setup();
        await handlers.get('netezza.showDependencies')!({label:'CUSTOMER(ARCHIVE)',objType:'TABLE',dbName:'DB',schema:'PUBLIC'});
        expect(service.dependencies).toHaveBeenLastCalledWith('NZ',expect.objectContaining({name:'CUSTOMER(ARCHIVE)',type:'TABLE'}),'outgoing',2,expect.anything(),undefined,undefined);
        await handlers.get('netezza.showDependencies')!({label:'REFRESH(INT)',objType:'PROCEDURE',dbName:'DB',schema:'PUBLIC'});
        expect(service.dependencies).toHaveBeenLastCalledWith('NZ',expect.objectContaining({name:'REFRESH',type:'PROCEDURE'}),'outgoing',2,expect.anything(),undefined,undefined);
    });
    test('unsupported connections and cancelled impact create no background work',async()=>{
        const {handlers,manager,service}=setup();manager.getConnectionDatabaseKind=()=> 'sqlite';
        await handlers.get('netezza.showDependencies')!({label:'CUSTOMER',dbName:'DB',schema:'PUBLIC'});expect(service.dependencies).not.toHaveBeenCalled();
        manager.getConnectionDatabaseKind=()=> 'netezza';(vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
        await handlers.get('netezza.impactAnalysis')!({label:'CUSTOMER',dbName:'DB',schema:'PUBLIC'});expect(service.dependencies).not.toHaveBeenCalled();
    });
});
