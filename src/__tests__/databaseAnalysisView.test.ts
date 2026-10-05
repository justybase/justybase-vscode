import * as vscode from 'vscode';
import { DatabaseAnalysisView, escapeAnalysisHtml, type AnalysisViewActions } from '../views/databaseAnalysisView';
import type { DependencyReport } from '../services/analysis/dependencyIndex';
import type { PerformanceReport } from '../services/analysis/performanceAdvisor';
const root = { database:'DB',schema:'PUBLIC',name:'T',type:'TABLE' as const };
const dependency: DependencyReport = { root,direction:'incoming',edges:[],affected:[{object:{...root,name:'V<script>',type:'VIEW'},depth:1,severity:'high',reason:'Review'}],issues:['<unsafe>'],truncated:false };
function setup() {
    let receive:(message:unknown)=>void=()=>undefined;
    let close:()=>void=()=>undefined;
    let disposed=false;
    const listeners: jest.Mock[]=[];
    const panel={webview:{html:'',cspSource:'vscode-webview:',asWebviewUri:()=>'/databaseAnalysis.js',onDidReceiveMessage:(callback:typeof receive)=>{receive=callback;const dispose=jest.fn();listeners.push(dispose);return{dispose};}},
        onDidDispose:(callback:()=>void)=>{close=callback;return{dispose:jest.fn()};},dispose:jest.fn(()=>{if(!disposed){disposed=true;close();}})};
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    Object.assign(vscode.window,{withProgress:jest.fn(async(_options:unknown,action:(_progress:unknown,token:vscode.CancellationToken)=>Promise<unknown>)=>action({},new vscode.CancellationTokenSource().token))});
    const actions={openObject:jest.fn(async()=>undefined),showSql:jest.fn(async()=>undefined),onDispose:jest.fn(),dependencies:jest.fn(async()=>dependency)};
    const view=new DatabaseAnalysisView({extensionUri:vscode.Uri.file('/workspace')} as vscode.ExtensionContext,'Dependencies',actions);
    return{view,panel,actions,receive:(message:unknown)=>receive(message),close,listeners};
}
describe('analysis webview ownership and protocol',()=>{
    test('renders themed safe graph and navigates only indexed objects',async()=>{
        const {view,panel,actions,receive}=setup();view.showDependencies(dependency);
        expect(panel.webview.html).toContain('V&lt;script&gt;');expect(panel.webview.html).toContain('&lt;unsafe&gt;');
        expect(panel.webview.html).toContain('Content-Security-Policy');expect(panel.webview.html).toContain('var(--vscode-');
        receive({command:'open',index:0});await Promise.resolve();expect(actions.openObject).toHaveBeenCalledWith(dependency.affected[0].object);
        receive({command:'open',index:-1});receive({command:'injected-command'});await Promise.resolve();expect(actions.openObject).toHaveBeenCalledTimes(1);
        expect(escapeAnalysisHtml('"&\'<>')).toBe('&quot;&amp;&#39;&lt;&gt;');view.dispose();
    });
    test('depth is bounded and closing cancels active refresh',async()=>{
        const {view,actions,receive,panel}=setup();view.showDependencies(dependency);
        let token:vscode.CancellationToken|undefined;let release!:(report:DependencyReport)=>void;
        actions.dependencies.mockImplementation((_depth?:number, activeToken?:vscode.CancellationToken)=>{token=activeToken;return new Promise(resolve=>{release=resolve;});});
        receive({command:'depth',value:999});await Promise.resolve();expect(actions.dependencies).not.toHaveBeenCalled();
        receive({command:'depth',value:3});await Promise.resolve();expect(actions.dependencies).toHaveBeenCalledTimes(1);
        view.dispose();expect(token?.isCancellationRequested).toBe(true);release({...dependency,issues:['stale']});await Promise.resolve();
        expect(panel.webview.html).not.toContain('stale');expect(actions.onDispose).toHaveBeenCalledTimes(1);
    });
    test('performance evidence, plan navigation and SQL protocol',async()=>{
        const {view,panel,actions,receive}=setup();
        const finding={id:'NZPERF005',title:'Conversion',summary:'Review types',severity:'warning' as const,confidence:0.6,risk:'medium' as const,actions:[],evidence:[{source:'sql_analysis' as const,summary:'CAST',details:'<sql>'}],category:'filter' as const,sqlRange:{start:3,end:12},planNodeIds:[1]};
        const report:PerformanceReport={sql:'SELECT <text>',summary:'One warning',metadata:{queryLength:13,recommendationCount:1,analyzedAt:'now'},recommendations:[finding],issues:['EXPLAIN unavailable']};
        view.showPerformance(report);expect(panel.webview.html).toContain('NZPERF005');expect(panel.webview.html).toContain('60%');expect(panel.webview.html).toContain('&lt;sql&gt;');expect(panel.webview.html).toContain('Show explain steps');
        receive({command:'sql',index:0});await Promise.resolve();expect(actions.showSql).toHaveBeenCalledWith(3,12);view.dispose();
    });

    test('graph edges, truncation, outgoing direction and proposed changes retain object evidence', () => {
        const {view,panel}=setup();
        const longName='A'.repeat(40);const source={...root,name:longName,type:'VIEW' as const};
        view.showDependencies({...dependency,direction:'outgoing',proposedChange:'Drop EMAIL',truncated:true,
            affected:[{object:source,depth:1,severity:'high',reason:'Column reference'}],
            edges:[{source:root,target:source,kind:'object',confidence:'exact',location:{start:1,end:2},evidence:[{kind:'object',confidence:'exact',location:{start:1,end:2}}]},
                {source:root,target:{...root,name:'unresolved'},kind:'object',confidence:'probable',location:{start:1,end:2},evidence:[{kind:'object',confidence:'probable',location:{start:1,end:2}}]}]});
        expect(panel.webview.html).toContain('marker-end');expect(panel.webview.html).toContain('Graph truncated');
        expect(panel.webview.html).toContain('Depends On');expect(panel.webview.html).toContain('Drop EMAIL');
        expect(panel.webview.html).toContain(longName.slice(0,27)+'…');view.dispose();
    });
    test('refresh and explicit skew measurement render plans, navigate findings and preserve partial results', async () => {
        const {view,panel,actions:original,receive}=setup();
        const actions=original as unknown as AnalysisViewActions;delete actions.dependencies;
        const finding={id:'NZPERF004',title:'Scan',summary:'Review',severity:'warning' as const,confidence:0.8,risk:'medium' as const,actions:[],category:'scan' as const,
            object:root,evidence:[{source:'explain_plan' as const,summary:'Rows',value:2000000}],planNodeIds:[1]};
        const report:PerformanceReport={sql:'SELECT * FROM T',summary:'Scan',metadata:{queryLength:15,recommendationCount:1,analyzedAt:'now'},recommendations:[finding],issues:[],
            plan:{rawPlan:'raw <plan>',nodes:[{id:1,raw:'scan <T>'}]} as PerformanceReport['plan']};
        const analyze=jest.fn(async (_measureSkew: boolean, _token: vscode.CancellationToken)=>report);actions.performance=analyze;
        view.showPerformance(report);expect(panel.webview.html).toContain('scan &lt;T&gt;');expect(panel.webview.html).toContain('2000000');
        receive({command:'open',index:0});await Promise.resolve();expect(original.openObject).toHaveBeenCalledWith(root);
        receive({command:'sql',index:0});receive(null);receive('bad');receive({command:'open',index:0.5});
        receive({command:'refresh'});await new Promise<void>(resolve=>setImmediate(resolve));
        receive({command:'skew'});await new Promise<void>(resolve=>setImmediate(resolve));
        expect(analyze.mock.calls.map(call=>call[0])).toEqual([false,true]);
        analyze.mockRejectedValueOnce(new Error('EXPLAIN failed'));
        receive({command:'refresh'});await new Promise<void>(resolve=>setImmediate(resolve));
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Analysis failed: EXPLAIN failed');
        expect(panel.webview.html).toContain('NZPERF004');view.dispose();receive({command:'refresh'});view.showPerformance(report);view.showDependencies(dependency);
    });
    test('explicit refresh of dependency report applies current depth', async () => {
        const {view,actions,receive,panel}=setup();view.showDependencies(dependency);
        receive({command:'depth',value:100});await new Promise<void>(resolve=>setImmediate(resolve));
        expect(actions.dependencies).toHaveBeenCalledWith(100,expect.anything());
        receive({command:'refresh'});await new Promise<void>(resolve=>setImmediate(resolve));
        expect(actions.dependencies).toHaveBeenCalledTimes(2);expect(panel.webview.html).toContain('value="100" selected');
        actions.dependencies.mockRejectedValueOnce(new vscode.CancellationError());
        receive({command:'refresh'});await new Promise<void>(resolve=>setImmediate(resolve));view.dispose();
    });
});
