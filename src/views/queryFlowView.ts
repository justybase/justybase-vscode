import * as vscode from 'vscode';
import type { QueryFlowGraph, QueryFlowNode } from '../sqlParser';

type RevealNodeHandler = (node: QueryFlowNode) => Thenable<void> | void;

export class QueryFlowView {
    public static currentPanel: QueryFlowView | undefined;
    public static readonly viewType = 'netezza.queryFlow';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _graph: QueryFlowGraph;
    private _revealNode: RevealNodeHandler;

    public static createOrShow(graph: QueryFlowGraph, revealNode: RevealNodeHandler): void {
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : undefined;

        if (QueryFlowView.currentPanel) {
            QueryFlowView.currentPanel._panel.reveal(column);
            QueryFlowView.currentPanel._update(graph, revealNode);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            QueryFlowView.viewType,
            'Query Flow Map',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        QueryFlowView.currentPanel = new QueryFlowView(panel, graph, revealNode);
    }

    private constructor(panel: vscode.WebviewPanel, graph: QueryFlowGraph, revealNode: RevealNodeHandler) {
        this._panel = panel;
        this._graph = graph;
        this._revealNode = revealNode;

        this._update(graph, revealNode);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(message => {
            if (message.command !== 'revealNode' || typeof message.nodeId !== 'string') {
                return;
            }

            const targetNode = this._graph.nodes.find(node => node.id === message.nodeId);
            if (!targetNode) {
                return;
            }

            void Promise.resolve(this._revealNode(targetNode));
        }, null, this._disposables);
    }

    public dispose(): void {
        QueryFlowView.currentPanel = undefined;
        this._panel.dispose();

        while (this._disposables.length > 0) {
            const disposable = this._disposables.pop();
            disposable?.dispose();
        }
    }

    private _update(graph: QueryFlowGraph, revealNode: RevealNodeHandler): void {
        this._graph = graph;
        this._revealNode = revealNode;
        this._panel.title = 'Query Flow Map';
        this._panel.webview.html = this._getHtmlForWebview(graph);
    }

    private _getHtmlForWebview(graph: QueryFlowGraph): string {
        const nonce = getNonce();
        const graphPayload = JSON.stringify(graph).replace(/</g, '\\u003c');
        const nodeCount = graph.nodes.length;
        const edgeCount = graph.edges.length;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Query Flow Map</title>
    <style>
        ${this._getStyles()}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h2>Interactive Execution Flow Map</h2>
                <p class="subtitle">Statement ${graph.statementIndex + 1} · ${formatStatementKind(graph.statementKind)}</p>
            </div>
            <div class="summary">
                <span class="badge">${nodeCount} nodes</span>
                <span class="badge">${edgeCount} edges</span>
                <span class="badge">Lines ${graph.statementRange.startLine + 1}-${graph.statementRange.endLine + 1}</span>
            </div>
        </div>

        <div class="legend">
            <span class="legend-item query">Final Query</span>
            <span class="legend-item cte">CTE</span>
            <span class="legend-item subquery">Subquery</span>
            <span class="legend-item temp">Temp Table</span>
            <span class="legend-item relation">Table / View</span>
        </div>

        <div class="instructions">
            Click any node to highlight its SQL source range in the original editor without leaving the flow map.
        </div>

        <div class="graph-shell">
            <div id="graphViewport" class="graph-viewport">
                <div id="graphStage" class="graph-stage">
                    <svg id="graphEdges" class="graph-edges"></svg>
                    <div id="graphNodes" class="graph-nodes"></div>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const graph = ${graphPayload};

        const viewport = document.getElementById('graphViewport');
        const stage = document.getElementById('graphStage');
        const edgeLayer = document.getElementById('graphEdges');
        const nodeLayer = document.getElementById('graphNodes');
        const nodeElements = new Map();
        let activeNodeId = graph.rootNodeId || null;
        const stageMetrics = {
            minWidth: 800,
            minHeight: 500,
            paddingX: 120,
            paddingY: 120
        };

        const levelMap = computeLevels(graph.nodes, graph.edges, graph.rootNodeId);
        const layout = layoutNodes(graph.nodes, levelMap);
        renderNodes(graph.nodes, layout);
        renderEdges(graph.edges, layout);
        fitStage(layout);
        syncActiveNode();

        function computeLevels(nodes, edges, rootNodeId) {
            const incoming = new Map();
            const outgoing = new Map();
            const levelMap = new Map();

            nodes.forEach(node => {
                incoming.set(node.id, 0);
                outgoing.set(node.id, []);
                levelMap.set(node.id, node.id === rootNodeId ? 0 : 0);
            });

            edges.forEach(edge => {
                incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
                const list = outgoing.get(edge.from) || [];
                list.push(edge.to);
                outgoing.set(edge.from, list);
            });

            const queue = [];
            nodes.forEach(node => {
                if ((incoming.get(node.id) || 0) === 0) {
                    queue.push(node.id);
                }
            });

            while (queue.length > 0) {
                const nodeId = queue.shift();
                const currentLevel = levelMap.get(nodeId) || 0;
                const targets = outgoing.get(nodeId) || [];
                targets.forEach(targetId => {
                    levelMap.set(targetId, Math.max(levelMap.get(targetId) || 0, currentLevel + 1));
                    incoming.set(targetId, (incoming.get(targetId) || 1) - 1);
                    if ((incoming.get(targetId) || 0) === 0) {
                        queue.push(targetId);
                    }
                });
            }

            return levelMap;
        }

        function layoutNodes(nodes, levelMap) {
            const groups = new Map();
            const nodeWidth = 220;
            const nodeHeight = 88;
            const columnGap = 120;
            const rowGap = 36;

            nodes.forEach(node => {
                const level = levelMap.get(node.id) || 0;
                const bucket = groups.get(level) || [];
                bucket.push(node);
                groups.set(level, bucket);
            });

            const positions = new Map();
            Array.from(groups.keys()).sort((left, right) => left - right).forEach(level => {
                const groupNodes = groups.get(level) || [];
                groupNodes.forEach((node, index) => {
                    positions.set(node.id, {
                        x: 48 + (level * (nodeWidth + columnGap)),
                        y: 48 + (index * (nodeHeight + rowGap)),
                        width: nodeWidth,
                        height: nodeHeight
                    });
                });
            });

            return positions;
        }

        function renderNodes(nodes, layout) {
            nodeLayer.innerHTML = '';
            nodeElements.clear();
            nodes.forEach(node => {
                const position = layout.get(node.id);
                if (!position) {
                    return;
                }

                const element = document.createElement('button');
                element.className = 'flow-node kind-' + node.kind;
                element.type = 'button';
                element.style.left = position.x + 'px';
                element.style.top = position.y + 'px';
                element.style.width = position.width + 'px';
                element.style.height = position.height + 'px';
                element.title = node.label + ' (' + node.kind.replace(/_/g, ' ') + ', lines ' + (node.startLine + 1) + '-' + (node.endLine + 1) + ')';
                element.setAttribute('aria-label', element.title);
                element.innerHTML = [
                    '<span class="node-kind">' + escapeHtml(node.kind.replace(/_/g, ' ')) + '</span>',
                    '<span class="node-label">' + escapeHtml(node.label) + '</span>',
                    '<span class="node-lines">L' + (node.startLine + 1) + '-L' + (node.endLine + 1) + '</span>'
                ].join('');
                element.addEventListener('click', () => {
                    setActiveNode(node.id);
                    vscode.postMessage({ command: 'revealNode', nodeId: node.id });
                });
                nodeLayer.appendChild(element);
                nodeElements.set(node.id, element);
            });
        }

        function renderEdges(edges, layout) {
            const paths = [];
            const reservedLabelBounds = [];
            const stageBounds = getStageBounds(layout);

            edges.forEach(edge => {
                const from = layout.get(edge.from);
                const to = layout.get(edge.to);
                if (!from || !to) {
                    return;
                }

                const startX = from.x + from.width;
                const startY = from.y + (from.height / 2);
                const endX = to.x;
                const endY = to.y + (to.height / 2);
                const delta = Math.max(40, (endX - startX) / 2);
                const startPoint = { x: startX, y: startY };
                const controlPointA = { x: startX + delta, y: startY };
                const controlPointB = { x: endX - delta, y: endY };
                const endPoint = { x: endX, y: endY };
                const labelSize = estimateEdgeLabelSize(edge.label);
                const curveMidpoint = cubicBezierPoint(startPoint, controlPointA, controlPointB, endPoint, 0.5);
                const curveTangent = cubicBezierTangent(startPoint, controlPointA, controlPointB, endPoint, 0.5);
                const labelCenter = resolveEdgeLabelCenter(curveMidpoint, curveTangent, labelSize, reservedLabelBounds);

                paths.push([
                    '<path class="edge-path" d="M', startX, ',', startY,
                    ' C', startX + delta, ',', startY,
                    ' ', endX - delta, ',', endY,
                    ' ', endX, ',', endY,
                    '" marker-end="url(#arrow)"></path>',
                    '<g class="edge-label-group" transform="translate(', labelCenter.x, ',', labelCenter.y, ')">',
                    '<title>', escapeHtml(edge.label), '</title>',
                    '<rect class="edge-label-bg" x="', -labelSize.width / 2, '" y="', -labelSize.height / 2, '" width="', labelSize.width, '" height="', labelSize.height, '" rx="', labelSize.height / 2, '" ry="', labelSize.height / 2, '"></rect>',
                    '<text class="edge-label" x="0" y="0">',
                    escapeHtml(edge.label),
                    '</text>',
                    '</g>'
                ].join(''));
            });

            edgeLayer.setAttribute('viewBox', '0 0 ' + stageBounds.width + ' ' + stageBounds.height);
            edgeLayer.setAttribute('width', String(stageBounds.width));
            edgeLayer.setAttribute('height', String(stageBounds.height));
            edgeLayer.innerHTML = [
                '<defs>',
                '  <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">',
                '    <path d="M0,0 L12,6 L0,12 z" class="arrow-head"></path>',
                '  </marker>',
                '</defs>',
                paths.join('')
            ].join('');
        }

        function setActiveNode(nodeId) {
            activeNodeId = nodeId;
            syncActiveNode();
        }

        function syncActiveNode() {
            nodeElements.forEach((element, nodeId) => {
                element.classList.toggle('is-active', nodeId === activeNodeId);
            });
        }

        function estimateEdgeLabelSize(label) {
            return {
                width: Math.max(54, (label.length * 7.2) + 18),
                height: 22
            };
        }

        function resolveEdgeLabelCenter(midpoint, tangent, labelSize, reservedLabelBounds) {
            const normal = getNormalVector(tangent);
            const offsets = [18, -18, 34, -34, 50, -50];

            for (const offset of offsets) {
                const candidate = {
                    x: midpoint.x + (normal.x * offset),
                    y: midpoint.y + (normal.y * offset)
                };
                const collides = reservedLabelBounds.some(bounds =>
                    Math.abs(bounds.x - candidate.x) < ((bounds.width + labelSize.width) / 2) + 14
                    && Math.abs(bounds.y - candidate.y) < ((bounds.height + labelSize.height) / 2) + 8
                );
                if (!collides) {
                    reservedLabelBounds.push({ ...candidate, width: labelSize.width, height: labelSize.height });
                    return candidate;
                }
            }

            const fallback = {
                x: midpoint.x + (normal.x * 66),
                y: midpoint.y + (normal.y * 66)
            };
            reservedLabelBounds.push({ ...fallback, width: labelSize.width, height: labelSize.height });
            return fallback;
        }

        function getNormalVector(tangent) {
            const magnitude = Math.hypot(tangent.x, tangent.y);
            if (magnitude < 0.001) {
                return { x: 0, y: -1 };
            }

            return {
                x: -tangent.y / magnitude,
                y: tangent.x / magnitude
            };
        }

        function cubicBezierPoint(startPoint, controlPointA, controlPointB, endPoint, t) {
            const inverse = 1 - t;
            const inverseSquared = inverse * inverse;
            const inverseCubed = inverseSquared * inverse;
            const squared = t * t;
            const cubed = squared * t;

            return {
                x: (inverseCubed * startPoint.x)
                    + (3 * inverseSquared * t * controlPointA.x)
                    + (3 * inverse * squared * controlPointB.x)
                    + (cubed * endPoint.x),
                y: (inverseCubed * startPoint.y)
                    + (3 * inverseSquared * t * controlPointA.y)
                    + (3 * inverse * squared * controlPointB.y)
                    + (cubed * endPoint.y)
            };
        }

        function cubicBezierTangent(startPoint, controlPointA, controlPointB, endPoint, t) {
            const inverse = 1 - t;
            const inverseSquared = inverse * inverse;
            const squared = t * t;

            return {
                x: (3 * inverseSquared * (controlPointA.x - startPoint.x))
                    + (6 * inverse * t * (controlPointB.x - controlPointA.x))
                    + (3 * squared * (endPoint.x - controlPointB.x)),
                y: (3 * inverseSquared * (controlPointA.y - startPoint.y))
                    + (6 * inverse * t * (controlPointB.y - controlPointA.y))
                    + (3 * squared * (endPoint.y - controlPointB.y))
            };
        }

        function getStageBounds(layout) {
            return Array.from(layout.values()).reduce((acc, item) => {
                acc.width = Math.max(acc.width, item.x + item.width + stageMetrics.paddingX);
                acc.height = Math.max(acc.height, item.y + item.height + stageMetrics.paddingY);
                return acc;
            }, {
                width: stageMetrics.minWidth,
                height: stageMetrics.minHeight
            });
        }

        function fitStage(layout) {
            const bounds = getStageBounds(layout);

            stage.style.width = bounds.width + 'px';
            stage.style.height = bounds.height + 'px';
            edgeLayer.setAttribute('width', String(bounds.width));
            edgeLayer.setAttribute('height', String(bounds.height));
            viewport.scrollLeft = 0;
            viewport.scrollTop = 0;
        }

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    </script>
</body>
</html>`;
    }

    private _getStyles(): string {
        return `
            :root {
                color-scheme: dark;
                --bg: #111827;
                --panel: #1f2937;
                --panel-border: #374151;
                --text: #e5e7eb;
                --muted: #9ca3af;
                --accent: #60a5fa;
                --query: #2563eb;
                --cte: #7c3aed;
                --subquery: #0f766e;
                --temp: #ea580c;
                --relation: #1d4ed8;
                --view: #0284c7;
            }

            * {
                box-sizing: border-box;
            }

            body {
                margin: 0;
                font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
                background: var(--bg);
                color: var(--text);
            }

            .container {
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 14px;
            }

            .header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 16px;
            }

            .header h2 {
                margin: 0 0 4px;
                font-size: 22px;
            }

            .subtitle {
                margin: 0;
                color: var(--muted);
            }

            .summary {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                justify-content: flex-end;
            }

            .badge {
                padding: 6px 10px;
                border-radius: 999px;
                background: #1e3a8a;
                color: #dbeafe;
                font-size: 12px;
                font-weight: 600;
            }

            .legend {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }

            .legend-item {
                padding: 6px 10px;
                border-radius: 999px;
                font-size: 12px;
                font-weight: 600;
                border: 1px solid var(--panel-border);
                background: rgba(255, 255, 255, 0.04);
            }

            .legend-item.query { border-color: var(--query); color: #bfdbfe; }
            .legend-item.cte { border-color: var(--cte); color: #ddd6fe; }
            .legend-item.subquery { border-color: var(--subquery); color: #99f6e4; }
            .legend-item.temp { border-color: var(--temp); color: #fdba74; }
            .legend-item.relation { border-color: var(--relation); color: #93c5fd; }

            .instructions {
                color: var(--muted);
            }

            .graph-shell {
                border: 1px solid var(--panel-border);
                border-radius: 14px;
                background: rgba(255, 255, 255, 0.02);
                overflow: hidden;
            }

            .graph-viewport {
                position: relative;
                overflow: auto;
                min-height: 520px;
                max-height: calc(100vh - 240px);
            }

            .graph-stage {
                position: relative;
                min-width: 820px;
                min-height: 520px;
            }

            .graph-edges {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                overflow: visible;
            }

            .graph-nodes {
                position: absolute;
                inset: 0;
            }

            .flow-node {
                position: absolute;
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                justify-content: center;
                gap: 6px;
                padding: 14px 16px;
                border-radius: 16px;
                border: 1px solid var(--panel-border);
                background: var(--panel);
                color: var(--text);
                text-align: left;
                cursor: pointer;
                transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
            }

            .flow-node:hover {
                transform: translateY(-2px);
                box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
            }

            .flow-node.kind-query { border-color: var(--query); box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.18); }
            .flow-node.kind-cte { border-color: var(--cte); box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.18); }
            .flow-node.kind-subquery { border-color: var(--subquery); box-shadow: inset 0 0 0 1px rgba(45, 212, 191, 0.18); }
            .flow-node.kind-temp_table { border-color: var(--temp); box-shadow: inset 0 0 0 1px rgba(251, 146, 60, 0.18); }
            .flow-node.kind-view { border-color: var(--view); box-shadow: inset 0 0 0 1px rgba(125, 211, 252, 0.18); }
            .flow-node.kind-table { border-color: var(--relation); box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.18); }

            .flow-node.is-active {
                border-color: #93c5fd;
                box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.26), 0 18px 40px rgba(15, 23, 42, 0.44);
                transform: translateY(-2px);
            }

            .node-kind {
                font-size: 11px;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                color: var(--muted);
            }

            .node-label {
                font-size: 15px;
                font-weight: 700;
                line-height: 1.25;
                word-break: break-word;
            }

            .node-lines {
                font-size: 12px;
                color: var(--muted);
            }

            .edge-path {
                fill: none;
                stroke: rgba(148, 163, 184, 0.88);
                stroke-width: 2.2;
                stroke-linecap: round;
            }

            .arrow-head {
                fill: rgba(148, 163, 184, 0.88);
            }

            .edge-label-group {
                pointer-events: none;
            }

            .edge-label-bg {
                fill: rgba(15, 23, 42, 0.94);
                stroke: rgba(148, 163, 184, 0.35);
                stroke-width: 1;
            }

            .edge-label {
                fill: #e2e8f0;
                font-size: 11px;
                font-weight: 700;
                font-family: var(--vscode-editor-font-family, monospace);
                text-anchor: middle;
                dominant-baseline: middle;
                letter-spacing: 0.02em;
            }
        `;
    }
}

function formatStatementKind(kind: QueryFlowGraph['statementKind']): string {
    switch (kind) {
        case 'with_select':
            return 'WITH + SELECT';
        case 'with_insert':
            return 'WITH + INSERT';
        case 'with_update':
            return 'WITH + UPDATE';
        case 'with_delete':
            return 'WITH + DELETE';
        default:
            return kind.replace(/_/g, ' ').toUpperCase();
    }
}

function getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let index = 0; index < 32; index++) {
        nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return nonce;
}
