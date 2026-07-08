import * as vscode from 'vscode';
import type { ExplainPlanGraphWebviewToHostMessage } from '../contracts/webviews/explainPlanGraphContracts';

/**
 * Parsed node from EXPLAIN output
 */
interface ExplainNode {
    id: number;
    type: string; // e.g., "Sequential Scan", "Nested Loop", "Aggregate"
    table?: string; // table name if applicable
    alias?: string; // table alias
    cost: { start: number; end: number };
    rows: number;
    width: number;
    confidence: number;
    indent: number; // tree depth
    children: ExplainNode[];
    raw: string; // original line
    warnings: PlanWarning[];
    // VERBOSE specific
    projections?: string[];
    restrictions?: string[];
    nodeDetails?: string[]; // Additional details from VERBOSE output
}

interface PlanWarning {
    type: 'critical' | 'warning' | 'info';
    message: string;
    icon: string;
}

interface ParsedPlan {
    nodes: ExplainNode[];
    rawText: string;
    isVerbose: boolean;
    totalCost: number;
    warnings: PlanWarning[];
    costDistribution: CostDistribution;
}

interface CostDistribution {
    minCost: number;
    maxCost: number;
    avgCost: number;
    medianCost: number;
}

interface TuningHint {
    nodeId: number;
    severity: 'critical' | 'warning' | 'info';
    message: string;
    recommendation: string;
}

interface GraphNodePayload {
    id: number;
    parentId: number | null;
    depth: number;
    type: string;
    table?: string;
    alias?: string;
    costStart: number;
    costEnd: number;
    rows: number;
    width: number;
    confidence: number;
    warnings: PlanWarning[];
    isFullScan: boolean;
    isBroadcast: boolean;
    costIntensity: string;
}

/**
 * Parse EXPLAIN output text into structured data
 */
export function parseExplainOutput(text: string): ParsedPlan {
    const lines = text.split('\n').filter(l => l.trim());
    const isVerbose = text.includes('QUERY VERBOSE PLAN:') || text.includes('Node 1.');

    // Remove NOTICE prefix and headers
    const cleanLines = lines
        .map(l => l.replace(/^NOTICE:\s*/i, '').trim())
        .filter(l => l && !l.startsWith('QUERY PLAN') && !l.startsWith('QUERY VERBOSE'));

    const nodes: ExplainNode[] = [];
    const warnings: PlanWarning[] = [];
    let nodeId = 0;
    let totalCost = 0;

    // Parse tree-structured PLANTEXT
    const planTextStart = cleanLines.findIndex(l => l.includes('PLANTEXT:'));
    const planLines =
        planTextStart >= 0
            ? cleanLines.slice(planTextStart + 1).filter(l => !l.startsWith('(') && !l.includes('locus='))
            : cleanLines;

    const nodeStack: ExplainNode[] = [];

    for (const line of planLines) {
        if (!line.trim()) continue;

        // Skip metadata lines
        if (line.startsWith('(xpath_') || line.includes('locus=')) continue;

        // Calculate indent level
        const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length || 0;
        const indent = Math.floor(leadingSpaces / 3);

        // Parse node type and details
        // Pattern: "l: NodeType (cost=X..Y rows=N width=W conf=C)"
        // or just "NodeType (cost=X..Y rows=N width=W conf=C)"
        const nodeMatch = line.match(
            /^[\s]*(?:[lr]:\s*)?([\w][\w\s/-]*?)(?:\s+table\s+"([^"]+)")?(?:\s+{[^}]*})?\s*\(cost=([\d.]+)\.\.([\d.]+)\s+rows=([\d.]+)\s+width=([\d.]+)\s+conf=([\d.]+)\)/i
        );

        if (nodeMatch) {
            const [, typeRaw, tableName, costStart, costEnd, rows, width, conf] = nodeMatch;
            const type = typeRaw.trim();

            const node: ExplainNode = {
                id: ++nodeId,
                type,
                table: tableName,
                cost: { start: parseFloat(costStart), end: parseFloat(costEnd) },
                rows: parseInt(rows),
                width: parseInt(width),
                confidence: parseFloat(conf),
                indent,
                children: [],
                raw: line.trim(),
                warnings: []
            };

            // Detect performance issues
            detectWarnings(node);
            warnings.push(...node.warnings);

            // Track total cost
            if (node.cost.end > totalCost) {
                totalCost = node.cost.end;
            }

            // Build tree structure
            while (nodeStack.length > 0 && nodeStack[nodeStack.length - 1].indent >= indent) {
                nodeStack.pop();
            }

            if (nodeStack.length > 0) {
                nodeStack[nodeStack.length - 1].children.push(node);
            } else {
                nodes.push(node);
            }
            nodeStack.push(node);
        }
    }

    // Calculate cost distribution for heatmap
    const allCosts = collectAllNodeCosts(nodes);
    const costDistribution = calculateCostDistribution(allCosts);

    return {
        nodes,
        rawText: text,
        isVerbose,
        totalCost,
        warnings,
        costDistribution
    };
}

function collectAllNodeCosts(nodes: ExplainNode[]): number[] {
    const costs: number[] = [];
    const stack: ExplainNode[] = [...nodes];

    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {
            continue;
        }
        costs.push(node.cost.start, node.cost.end);
        if (node.children.length > 0) {
            stack.push(...node.children);
        }
    }

    return costs;
}

export function calculateCostDistribution(costs: number[]): CostDistribution {
    if (costs.length === 0) {
        return { minCost: 0, maxCost: 0, avgCost: 0, medianCost: 0 };
    }
    
    const sorted = [...costs].sort((a, b) => a - b);
    const minCost = sorted[0];
    const maxCost = sorted[sorted.length - 1];
    const avgCost = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const mid = Math.floor(sorted.length / 2);
    const medianCost = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    
    return { minCost, maxCost, avgCost, medianCost };
}

function isFullTableScan(node: ExplainNode): boolean {
    return /sequential\s+scan|full\s+scan|table\s+scan/i.test(node.type) || /full\s+scan/i.test(node.raw);
}

function isBroadcastOperation(node: ExplainNode): boolean {
    return /broadcast|fabric\s+broadcast|redistribute/i.test(node.type) || /broadcast|fabric\s+broadcast/i.test(node.raw);
}

/**
 * Detect performance warnings for a node
 */
function detectWarnings(node: ExplainNode): void {
    // Full table scan on large row count
    if (isFullTableScan(node) && node.rows > 50000) {
        node.warnings.push({
            type: 'warning',
            message: `Full table scan on ${node.table || 'table'} (${node.rows.toLocaleString()} rows) - consider index/filter tuning`,
            icon: '⚠️'
        });
    }

    // Fabric/broadcast operations often indicate expensive data movement
    if (isBroadcastOperation(node)) {
        node.warnings.push({
            type: 'critical',
            message: `Broadcast/Fabric data movement detected (${node.type}) - check distribution keys and join strategy`,
            icon: '🔴'
        });
    }

    // Nested Loop with high row count
    if (node.type.includes('Nested Loop') && node.rows > 100000) {
        node.warnings.push({
            type: 'critical',
            message: `Nested Loop producing ${node.rows.toLocaleString()} rows - potential performance issue`,
            icon: '🔴'
        });
    }

    // Very high cost (> 10,000,000,000)
    if (node.cost.end > 10000000000) {
        node.warnings.push({
            type: 'critical',
            message: `Very high estimated cost: ${node.cost.end.toExponential(2)}`,
            icon: '🔴'
        });
    } else if (node.cost.end > 10000000) {
        // High cost (> 10,000,000)
        node.warnings.push({
            type: 'warning',
            message: `High estimated cost: ${node.cost.end.toLocaleString()}`,
            icon: '⚠️'
        });
    }

    // Low confidence
    if (node.confidence === 0) {
        node.warnings.push({
            type: 'info',
            message: 'Low confidence estimate (conf=0) - statistics may be outdated',
            icon: 'ℹ️'
        });
    }
}

/**
 * Get node type color for visualization
 */
function getNodeColor(type: string): string {
    if (/broadcast|fabric\s+broadcast|redistribute/i.test(type)) return '#8e44ad'; // Purple-magenta
    if (/Sequential Scan|Full Scan|Table Scan/i.test(type)) return '#e74c3c'; // Red
    if (type.includes('Index Scan')) return '#27ae60'; // Green
    if (type.includes('Nested Loop')) return '#e67e22'; // Orange
    if (type.includes('Hash Join')) return '#3498db'; // Blue
    if (type.includes('Merge Join')) return '#9b59b6'; // Purple
    if (type.includes('Aggregate')) return '#1abc9c'; // Teal
    if (type.includes('Group')) return '#16a085'; // Dark Teal
    if (type.includes('Sort')) return '#f39c12'; // Yellow
    if (type.includes('Limit')) return '#95a5a6'; // Gray
    if (type.includes('Sub-query')) return '#34495e'; // Dark Gray
    return '#7f8c8d'; // Default gray
}

/**
 * Get cost heatmap color based on relative cost
 * Returns color from green (low) to red (high)
 */
export function getCostHeatmapColor(cost: number, distribution: CostDistribution): string {
    if (distribution.maxCost === distribution.minCost) {
        return '#3498db'; // Default blue when all costs are equal
    }
    
    const ratio = (cost - distribution.minCost) / (distribution.maxCost - distribution.minCost);
    
    // Gradient: green -> yellow -> orange -> red
    if (ratio < 0.33) {
        return '#27ae60'; // Green - low cost
    } else if (ratio < 0.66) {
        return '#f39c12'; // Yellow/Orange - medium cost
    } else {
        return '#e74c3c'; // Red - high cost
    }
}

/**
 * Get cost intensity class for styling
 */
export function getCostIntensity(cost: number, distribution: CostDistribution): string {
    if (distribution.maxCost === distribution.minCost) {
        return 'cost-normal';
    }
    
    const ratio = (cost - distribution.minCost) / (distribution.maxCost - distribution.minCost);
    
    if (ratio > 0.8) return 'cost-critical';
    if (ratio > 0.6) return 'cost-high';
    if (ratio > 0.4) return 'cost-medium';
    return 'cost-low';
}

/**
 * Generate tuning hints based on node analysis
 */
export function generateTuningHints(nodes: ExplainNode[]): TuningHint[] {
    const hints: TuningHint[] = [];
    
    for (const node of nodes) {
        // Full table scan on large table
        if (isFullTableScan(node) && node.rows > 100000) {
            const tableName = node.table || 'TABLE_NAME';
            hints.push({
                nodeId: node.id,
                severity: 'warning',
                message: `Full table scan on ${tableName} (${node.rows.toLocaleString()} rows)`,
                recommendation:
                    'Consider: push selective WHERE predicates, align DISTRIBUTE ON / ORGANIZE ON strategy, and run GENERATE STATISTICS ON ' +
                    tableName
            });
        }

        // Broadcast/Fabric data movement
        if (isBroadcastOperation(node)) {
            hints.push({
                nodeId: node.id,
                severity: 'critical',
                message: `Broadcast/Fabric movement in ${node.type}`,
                recommendation: 'Align DISTRIBUTE ON keys for large joins and reduce cross-node data movement'
            });
        }
        
        // Nested Loop with many rows
        if (node.type.includes('Nested Loop') && node.rows > 50000) {
            hints.push({
                nodeId: node.id,
                severity: 'critical',
                message: `Nested Loop producing ${node.rows.toLocaleString()} rows`,
                recommendation: 'Consider rewriting as Hash Join or adding filter conditions to reduce row count'
            });
        }
        
        // High cost nodes
        if (node.cost.end > 10000000) {
            hints.push({
                nodeId: node.id,
                severity: 'critical',
                message: `Very high cost: ${node.cost.end.toExponential(2)}`,
                recommendation: 'Review query structure, check for missing WHERE clauses or excessive joins'
            });
        }
        
        // Low confidence
        if (node.confidence === 0) {
            hints.push({
                nodeId: node.id,
                severity: 'info',
                message: 'Low confidence estimate (conf=0)',
                recommendation: 'Run: GENERATE STATISTICS ON ' + (node.table || 'relevant_table')
            });
        }
        
        // Recursively check children
        if (node.children.length > 0) {
            hints.push(...generateTuningHints(node.children));
        }
    }
    
    return hints;
}

function buildGraphNodePayload(
    nodes: ExplainNode[],
    distribution: CostDistribution,
    depth: number = 0,
    parentId: number | null = null
): GraphNodePayload[] {
    const payload: GraphNodePayload[] = [];

    for (const node of nodes) {
        payload.push({
            id: node.id,
            parentId,
            depth,
            type: node.type,
            table: node.table,
            alias: node.alias,
            costStart: node.cost.start,
            costEnd: node.cost.end,
            rows: node.rows,
            width: node.width,
            confidence: node.confidence,
            warnings: node.warnings,
            isFullScan: isFullTableScan(node),
            isBroadcast: isBroadcastOperation(node),
            costIntensity: getCostIntensity(node.cost.end, distribution)
        });

        if (node.children.length > 0) {
            payload.push(...buildGraphNodePayload(node.children, distribution, depth + 1, node.id));
        }
    }

    return payload;
}

/**
 * WebviewPanel for Explain Plan visualization
 */
export class ExplainPlanView {
    public static readonly viewType = 'netezza.explainPlan';
    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, plan: ParsedPlan, query: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update(plan, query);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (message: ExplainPlanGraphWebviewToHostMessage) => {
                switch (message.command) {
                    case 'copyPlan':
                        vscode.env.clipboard.writeText(plan.rawText);
                        vscode.window.showInformationMessage('Plan copied to clipboard');
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static createOrShow(extensionUri: vscode.Uri, plan: ParsedPlan, query: string) {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        const panel = vscode.window.createWebviewPanel(
            ExplainPlanView.viewType,
            'Query Execution Plan',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist'),
                ],
                retainContextWhenHidden: true
            }
        );

        new ExplainPlanView(panel, extensionUri, plan, query);
    }

    public dispose() {
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update(plan: ParsedPlan, query: string) {
        this._panel.title = 'Query Execution Plan';
        this._panel.webview.html = this._getHtmlForWebview(plan, query);
    }

    private _getHtmlForWebview(plan: ParsedPlan, query: string): string {
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'explainPlan.css')
        );
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'explainPlanGraph.js')
        );

        const nonce = getNonce();
        const queryEscaped = escapeHtml(query);
        const tuningHints = generateTuningHints(plan.nodes);
        const graphNodes = buildGraphNodePayload(plan.nodes, plan.costDistribution);
        const graphDataJson = JSON.stringify({
            nodes: graphNodes,
            costDistribution: plan.costDistribution
        }).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Query Execution Plan</title>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>Query Execution Plan</h2>
            <div class="header-actions">
                <button id="copyBtn" class="btn">📋 Copy Plan</button>
                <button id="toggleHeatmapBtn" class="btn">🔥 Cost Heatmap</button>
            </div>
        </div>

        ${plan.warnings.length > 0
                ? `
        <div class="warnings-summary">
            <h3>⚠️ Performance Issues Detected (${plan.warnings.length})</h3>
            <ul>
                ${plan.warnings.map(w => `<li class="warning-${w.type}">${w.icon} ${w.message}</li>`).join('')}
            </ul>
        </div>
        `
                : `
        <div class="no-warnings">
            <span>✅ No obvious performance issues detected</span>
        </div>
        `
            }

        ${tuningHints.length > 0 ? `
        <div class="tuning-hints">
            <h3>🔧 Tuning Advisor Suggestions (${tuningHints.length})</h3>
            <div class="hints-list">
                ${tuningHints.map(hint => `
                    <div class="hint-item hint-${hint.severity}" data-node-id="${hint.nodeId}">
                        <div class="hint-header">
                            <span class="hint-severity">${hint.severity === 'critical' ? '🔴' : hint.severity === 'warning' ? '⚠️' : 'ℹ️'}</span>
                            <span class="hint-message">${hint.message}</span>
                        </div>
                        <div class="hint-recommendation">
                            <code>${hint.recommendation}</code>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}

        <div class="stats-bar">
            <div class="stat">
                <span class="stat-label">Total Cost:</span>
                <span class="stat-value ${getCostIntensity(plan.totalCost, plan.costDistribution)}">${plan.totalCost > 1000000 ? plan.totalCost.toExponential(2) : plan.totalCost.toLocaleString()}</span>
            </div>
            <div class="stat">
                <span class="stat-label">Nodes:</span>
                <span class="stat-value">${countNodes(plan.nodes)}</span>
            </div>
            <div class="stat">
                <span class="stat-label">Cost Range:</span>
                <span class="stat-value">${plan.costDistribution.minCost.toLocaleString()} - ${plan.costDistribution.maxCost > 1000000 ? plan.costDistribution.maxCost.toExponential(2) : plan.costDistribution.maxCost.toLocaleString()}</span>
            </div>
        </div>

        <div class="cost-legend">
            <span class="legend-label">Cost Heatmap:</span>
            <span class="legend-item cost-low">Low</span>
            <span class="legend-item cost-medium">Medium</span>
            <span class="legend-item cost-high">High</span>
            <span class="legend-item cost-critical">Critical</span>
        </div>

        <div class="query-section">
            <h3>Query</h3>
            <pre class="query-text">${queryEscaped}</pre>
        </div>

        <div class="plan-section">
            <div class="plan-section-header">
                <h3>Execution Plan (Interactive DAG)</h3>
                <div class="graph-toolbar">
                    <button id="zoomOutBtn" class="btn">−</button>
                    <button id="zoomInBtn" class="btn">＋</button>
                    <button id="resetViewBtn" class="btn">Reset</button>
                    <button id="fitViewBtn" class="btn">Fit</button>
                    <span id="zoomLabel" class="zoom-label">100%</span>
                </div>
            </div>
            <div id="planGraphViewport" class="plan-graph-viewport">
                <div id="planGraphStage" class="plan-graph-stage">
                    <svg id="planGraphEdges" class="plan-graph-edges"></svg>
                    <div id="planGraphNodes" class="plan-graph-nodes pipeline-node"></div>
                </div>
            </div>
        </div>

        <div class="raw-section">
            <details>
                <summary>Raw Plan Output</summary>
                <pre class="raw-plan">${escapeHtml(plan.rawText)}</pre>
            </details>
        </div>
    </div>

    <script nonce="${nonce}">
        window.explainPlanGraphData = ${graphDataJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

export function renderPlanTree(nodes: ExplainNode[], depth: number = 0): string {
    return nodes
        .map(node => {
            const hasChildren = node.children.length > 0;
            const color = getNodeColor(node.type);
            const warningBadges = node.warnings
                .map(w => `<span class="warning-badge warning-${w.type}" title="${w.message}">${w.icon}</span>`)
                .join('');

            return `
        <div class="plan-node" style="--node-color: ${color}">
            <div class="node-header">
                ${hasChildren ? '<span class="toggle-btn">▼</span>' : '<span class="toggle-spacer"></span>'}
                <span class="node-type" style="background-color: ${color}">${node.type}</span>
                ${node.table ? `<span class="node-table">${node.table}${node.alias ? ` (${node.alias})` : ''}</span>` : ''}
                ${warningBadges}
            </div>
            <div class="node-metrics">
                <span class="metric"><b>Cost:</b> ${formatCost(node.cost.start)}..${formatCost(node.cost.end)}</span>
                <span class="metric"><b>Rows:</b> ${node.rows.toLocaleString()}</span>
                <span class="metric"><b>Width:</b> ${node.width}</span>
                <span class="metric ${node.confidence === 0 ? 'low-conf' : ''}"><b>Conf:</b> ${node.confidence}%</span>
            </div>
            ${hasChildren ? `<div class="node-children">${renderPlanTree(node.children, depth + 1)}</div>` : ''}
        </div>`;
        })
        .join('');
}

const costLabels: Record<string, string> = {
    'cost-low': 'Low',
    'cost-medium': 'Medium',
    'cost-high': 'High',
    'cost-critical': 'Critical',
    'cost-normal': 'Normal'
};

export function renderPlanTreeWithPipeline(nodes: ExplainNode[], costDistribution: CostDistribution, depth: number = 0): string {
    return nodes
        .map((node, index) => {
            const hasChildren = node.children.length > 0;
            const typeColor = getNodeColor(node.type);
            const costColor = getCostHeatmapColor(node.cost.end, costDistribution);
            const costIntensity = getCostIntensity(node.cost.end, costDistribution);
            const warningBadges = node.warnings
                .map(w => `<span class="warning-badge warning-${w.type}" title="${w.message}">${w.icon}</span>`)
                .join('');
            
            // Pipeline connector: check if there's a next sibling
            const isLastSibling = index === nodes.length - 1;
            const pipelineConnector = !isLastSibling ? '<div class="pipeline-connector horizontal"></div>' : '';

            return `
        <div class="plan-node pipeline-node ${costIntensity}" data-node-id="${node.id}" style="--node-color: ${typeColor}; --cost-color: ${costColor}">
            <div class="pipeline-line ${depth > 0 ? 'has-parent' : ''}"></div>
            <div class="node-content">
                <div class="node-header">
                    ${hasChildren ? '<span class="toggle-btn">▼</span>' : '<span class="toggle-spacer"></span>'}
                    <span class="node-type" style="background-color: ${typeColor}">${node.type}</span>
                    ${node.table ? `<span class="node-table">${node.table}${node.alias ? ` (${node.alias})` : ''}</span>` : ''}
                    ${warningBadges}
                </div>
                <div class="node-metrics">
                    <span class="metric cost-metric ${costIntensity}" title="Relative cost: ${costLabels[costIntensity] ?? 'Normal'}">
                        <b>Cost:</b> ${formatCost(node.cost.start)}..${formatCost(node.cost.end)}
                    </span>
                    <span class="metric"><b>Rows:</b> ${node.rows.toLocaleString()}</span>
                    <span class="metric"><b>Width:</b> ${node.width}</span>
                    <span class="metric ${node.confidence === 0 ? 'low-conf' : ''}"><b>Conf:</b> ${node.confidence}%</span>
                </div>
                ${hasChildren ? `<div class="node-children pipeline-children">${renderPlanTreeWithPipeline(node.children, costDistribution, depth + 1)}</div>` : ''}
            </div>
            ${pipelineConnector}
        </div>`;
        })
        .join('');
}

function formatCost(cost: number): string {
    if (cost > 1000000) {
        return cost.toExponential(1);
    }
    return cost.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function countNodes(nodes: ExplainNode[]): number {
    return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
