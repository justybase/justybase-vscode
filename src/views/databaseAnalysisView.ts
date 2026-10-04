import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { DependencyReport } from '../services/analysis/dependencyIndex';
import type { PerformanceReport } from '../services/analysis/performanceAdvisor';
import { objectLabel, objectId, type ObjectReference } from '../services/analysis/sqlAnalysis';

export function escapeAnalysisHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const escape = escapeAnalysisHtml;
export interface AnalysisViewActions {
    dependencies?: (depth: number, token: vscode.CancellationToken) => Promise<DependencyReport>;
    performance?: (measureSkew: boolean, token: vscode.CancellationToken) => Promise<PerformanceReport>;
    openObject: (object: ObjectReference) => Promise<unknown>;
    onDispose?: () => void;
    showSql?: (start: number, end: number) => Promise<void>;
}
/** One ephemeral report per panel. Closing cancels refreshes; revisions reject stale responses. */
export class DatabaseAnalysisView implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private readonly cancellation = new vscode.CancellationTokenSource();
    private listeners: vscode.Disposable[];
    private revision = 0;
    private disposed = false;
    private depth = 2;
    private dependency?: DependencyReport;
    private performance?: PerformanceReport;
    constructor(private readonly context: vscode.ExtensionContext, title: string, private readonly actions: AnalysisViewActions) {
        this.panel = vscode.window.createWebviewPanel('justybase.databaseAnalysis', title, vscode.ViewColumn.Beside,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'media')] });
        this.listeners = [this.panel.onDidDispose(() => this.dispose()), this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message); })];
    }
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true; this.revision++; this.cancellation.cancel(); this.cancellation.dispose();
        this.listeners.forEach(listener => listener.dispose()); this.panel.dispose(); this.actions.onDispose?.();
    }
    showDependencies(report: DependencyReport): void { if (!this.disposed) { this.dependency = report; this.performance = undefined; this.render(); } }
    showPerformance(report: PerformanceReport): void { if (!this.disposed) { this.performance = report; this.dependency = undefined; this.render(); } }
    private async handle(message: unknown): Promise<void> {
        if (this.disposed || !message || typeof message !== 'object') { return; }
        const data = message as Record<string, unknown>;
        try {
            if (data.command === 'open' && typeof data.index === 'number' && Number.isInteger(data.index)) {
                const object = this.dependency?.affected[data.index]?.object ?? this.performance?.recommendations[data.index]?.object;
                if (object) { await this.actions.openObject(object); }
            } else if (data.command === 'sql' && typeof data.index === 'number') {
                const range = this.performance?.recommendations[data.index]?.sqlRange;
                if (range) { await this.actions.showSql?.(range.start, range.end); }
            } else if (data.command === 'depth' && [1,2,3,100].includes(Number(data.value)) && this.actions.dependencies) {
                this.depth = Number(data.value);
                await this.refresh(token => this.actions.dependencies!(this.depth, token));
            } else if (data.command === 'refresh') {
                if (this.actions.dependencies) { await this.refresh(token => this.actions.dependencies!(this.depth, token)); }
                else if (this.actions.performance) { await this.refresh(token => this.actions.performance!(false, token)); }
            } else if (data.command === 'skew' && this.actions.performance) {
                await this.refresh(token => this.actions.performance!(true, token));
            }
        } catch (error) {
            if (!this.disposed && !(error instanceof vscode.CancellationError)) { void vscode.window.showErrorMessage(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
    }
    private async refresh(action: (token: vscode.CancellationToken) => Promise<DependencyReport | PerformanceReport>): Promise<void> {
        const revision = ++this.revision;
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing database objects', cancellable: true }, async (_progress, token) => {
            const source = new vscode.CancellationTokenSource();
            const listeners = [token.onCancellationRequested(() => source.cancel()), this.cancellation.token.onCancellationRequested(() => source.cancel())];
            if (token.isCancellationRequested || this.cancellation.token.isCancellationRequested) { source.cancel(); }
            try { return await action(source.token); } finally { listeners.forEach(listener => listener.dispose()); source.dispose(); }
        });
        if (this.disposed || revision !== this.revision) { return; }
        if ('affected' in result) { this.showDependencies(result); } else { this.showPerformance(result); }
    }
    private render(): void {
        const nonce = randomBytes(16).toString('hex');
        const webview = this.panel.webview;
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'databaseAnalysis.js'));
        const report = this.dependency ?? this.performance!;
        const issues = report.issues.slice(0,100).map(issue => `<li>${escape(issue)}</li>`).join('');
        let content: string;
        if (this.dependency) {
            const dependency = this.dependency;
            const objects = [dependency.root, ...dependency.affected.map(a => a.object)];
            const positions = new Map(objects.map((o,i) => [objectId(o), { x: i === 0 ? 20 : 300 * Math.min(dependency.affected[i-1].depth, 4), y: i === 0 ? 30 : 30 + (i-1)*65 }]));
            const graphEdges = new Map(dependency.edges.map(edge => [JSON.stringify([objectId(edge.source), objectId(edge.target)]), edge]));
            const lines = [...graphEdges.values()].map(edge => { const a = positions.get(objectId(edge.source)), b = positions.get(objectId(edge.target)); return a && b ? `<path d="M${a.x+125},${a.y+20} L${b.x+125},${b.y+20}" marker-end="url(#arrow)"/>` : ''; }).join('');
            const nodes = objects.map((o,i) => { const p = positions.get(objectId(o))!; return `<g class="node ${o.type.toLowerCase().replace(/ /g, '-')}" transform="translate(${p.x},${p.y})" ${i ? `data-command="open" data-index="${i-1}" tabindex="0" role="button"` : ''}><rect width="250" height="45" rx="4"/><text x="8" y="17">${escape(o.name.length > 30 ? `${o.name.slice(0,27)}…` : o.name)}</text><text x="8" y="35" class="type">${escape(o.type)}</text><title>${escape(objectLabel(o))}</title></g>`; }).join('');
            const direct = dependency.affected.filter(a => a.depth === 1).length;
            const indirect = dependency.affected.filter(a => a.depth > 1).length;
            const truncationNotice = dependency.truncated ? ' · Graph truncated at its safety limit' : '';
            const graphHeight = Math.max(350,objects.length*65);
            const depthOptions = [1,2,3,100].map(n => `<option value="${n}" ${n === this.depth ? 'selected' : ''}>${n === 100 ? 'All (bounded)' : n}</option>`).join('');
            const affectedCards = dependency.affected.map((item,i) => `<article><strong>${item.severity.toUpperCase()}</strong> <button data-command="open" data-index="${i}">${escape(objectLabel(item.object))}</button><p>Depth ${item.depth} · ${escape(item.reason)}</p></article>`).join('');
            content = `<h1>${dependency.direction === 'incoming' ? 'Used By / Impact Analysis' : 'Depends On'}</h1><h2>${escape(objectLabel(dependency.root))}</h2>${dependency.proposedChange ? `<p>Proposed change: ${escape(dependency.proposedChange)}</p>` : ''}
                <p>${direct} direct · ${indirect} indirect references${truncationNotice}</p>
                <label>Depth <select id="depth">${depthOptions}</select></label> <button data-command="refresh">Refresh report</button>
                <p>Arrows point from the referencing object to its dependency. Click a node for DDL. Use wheel to zoom and drag to pan.</p>
                <div class="graph"><svg id="graph" viewBox="0 0 1500 ${graphHeight}" aria-label="Dependency graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z"/></marker></defs>${lines}${nodes}</svg></div>
                ${affectedCards}`;
        } else {
            const performance = this.performance!;
            const findingCards = performance.recommendations.map((finding, i) => {
                const evidence = finding.evidence.map(e => `<li><strong>${escape(e.source)}</strong>: ${escape(e.summary)}${e.value !== undefined ? ` (${escape(String(e.value))})` : ''}${e.details ? `<pre>${escape(e.details)}</pre>` : ''}</li>`).join('');
                const objectAction = finding.object ? `<button data-command="open" data-index="${i}">Show object DDL</button>` : '';
                const sqlAction = finding.sqlRange ? `<button data-command="sql" data-index="${i}">Show in SQL</button>` : '';
                const planAction = finding.planNodeIds ? `<button data-command="plan" data-nodes="${finding.planNodeIds.join(',')}">Show explain steps</button>` : '';
                return `<article><strong>${finding.severity.toUpperCase()} · ${escape(finding.id)}</strong><h2>${escape(finding.title)}</h2><p>${escape(finding.summary)}</p><p>Confidence ${Math.round(finding.confidence*100)}% · ${escape(finding.category)}</p><ul>${evidence}</ul>${objectAction}${sqlAction}${planAction}</article>`;
            }).join('');
            const capturedSql = escape(performance.sql);
            const planText = escape(performance.plan?.rawPlan ?? 'EXPLAIN unavailable');
            const planNodes = performance.plan?.nodes.map(n => `<pre id="plan-${n.id}">${escape(n.raw)}</pre>`).join('') ?? '';
            content = `<h1>Netezza Performance Advisor</h1><p>${escape(performance.summary)}</p><p>Analysis runs an extra EXPLAIN statement; the analyzed SQL is not executed.</p>
                <button data-command="refresh">Refresh analysis</button> <button data-command="skew">Measure skew (scans referenced tables)</button>
                <details><summary>Captured SQL</summary><pre>${capturedSql}</pre></details>
                ${findingCards}
                <details id="plan"><summary>Structured EXPLAIN / raw plan</summary>${planNodes}<pre>${planText}</pre></details>`;
        }
        webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource};"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">
            body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px}h1{font-size:1.5em}h2{font-size:1.15em}button,select{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer;margin:3px}button:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}article{border:1px solid var(--vscode-panel-border);padding:14px;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family)}.graph{height:450px;border:1px solid var(--vscode-panel-border);overflow:hidden}svg{height:100%;width:100%;touch-action:none}svg path{stroke:var(--vscode-foreground);fill:none;stroke-width:1.4}marker path{fill:var(--vscode-foreground)}.node rect{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-blue)}.node.view rect{stroke:var(--vscode-charts-green)}.node.procedure rect{stroke:var(--vscode-charts-orange)}.node text{fill:var(--vscode-foreground);font-size:13px}.node .type{font-size:11px}.node{cursor:pointer}.highlight{outline:2px solid var(--vscode-focusBorder)}
            </style></head><body>${content}<details open><summary>Coverage and limitations</summary><ul>${issues}</ul></details><script nonce="${nonce}" src="${script}"></script></body></html>`;
    }
}
