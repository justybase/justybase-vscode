import type {
    CanvasPoint,
    ExplainPlanGraphNode,
    ExplainPlanGraphPayload,
    ExplainPlanGraphWebviewToHostMessage,
    NodeDragState,
    PanDragState,
    TransformState,
} from './hostContracts.js';
import { postToHost } from './protocol.js';
import { escapeHtml, formatCost, getNodeColor } from './utils.js';

const graphPayload = ((window as unknown as { explainPlanGraphData?: ExplainPlanGraphPayload }).explainPlanGraphData || {});
const graphNodes: ExplainPlanGraphNode[] = Array.isArray(graphPayload.nodes) ? graphPayload.nodes : [];

const NODE_WIDTH = 300;
const NODE_HEIGHT = 122;
const NODE_GAP_X = 360;
const NODE_GAP_Y = 182;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

const viewport = document.getElementById('planGraphViewport');
const stage = document.getElementById('planGraphStage');
const edgesSvg = document.getElementById('planGraphEdges');
const nodesContainer = document.getElementById('planGraphNodes');
const zoomLabel = document.getElementById('zoomLabel');
const copyBtn = document.getElementById('copyBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const resetViewBtn = document.getElementById('resetViewBtn');
const fitViewBtn = document.getElementById('fitViewBtn');
const toggleHeatmapBtn = document.getElementById('toggleHeatmapBtn');

const nodePositions = new Map<number, CanvasPoint>();
let heatmapEnabled = true;
let nodeDragState: NodeDragState | null = null;
let panDragState: PanDragState | null = null;
let transformState: TransformState = {
    scale: 1,
    panX: 48,
    panY: 36
};

if (graphNodes.length === 0) {
    renderEmptyPlanState();
} else {
    initializePositions();
    renderGraph();
    fitView();
    registerEvents();
}

function renderEmptyPlanState(): void {
    if (!viewport) {
        return;
    }
    viewport.innerHTML = `
        <div class="plan-empty-state" role="status">
            <p>No execution plan nodes were available to render.</p>
            <p class="plan-empty-state-hint">Open the raw plan output below or re-run EXPLAIN for this query.</p>
        </div>
    `;
    copyBtn?.setAttribute('disabled', 'true');
    zoomInBtn?.setAttribute('disabled', 'true');
    zoomOutBtn?.setAttribute('disabled', 'true');
    resetViewBtn?.setAttribute('disabled', 'true');
    fitViewBtn?.setAttribute('disabled', 'true');
    toggleHeatmapBtn?.setAttribute('disabled', 'true');
}

function registerEvents(): void {
    copyBtn?.addEventListener('click', () => {
        postToHost({ command: 'copyPlan' });
    });

    zoomInBtn?.addEventListener('click', () => {
        zoomAtViewportCenter(0.12);
    });

    zoomOutBtn?.addEventListener('click', () => {
        zoomAtViewportCenter(-0.12);
    });

    resetViewBtn?.addEventListener('click', () => {
        transformState.scale = 1;
        transformState.panX = 48;
        transformState.panY = 36;
        applyTransform();
    });

    fitViewBtn?.addEventListener('click', () => {
        fitView();
    });

    toggleHeatmapBtn?.addEventListener('click', () => {
        heatmapEnabled = !heatmapEnabled;
        document.body.classList.toggle('heatmap-disabled', !heatmapEnabled);
        if (toggleHeatmapBtn) {
            toggleHeatmapBtn.style.opacity = heatmapEnabled ? '1' : '0.6';
            toggleHeatmapBtn.textContent = heatmapEnabled ? '🔥 Cost Heatmap' : '💤 Heatmap Off';
        }
    });

    viewport?.addEventListener('wheel', event => {
        event.preventDefault();
        const delta = event.deltaY < 0 ? 0.08 : -0.08;
        zoomAt(event.clientX, event.clientY, delta);
    }, { passive: false });

    viewport?.addEventListener('mousedown', event => {
        if (event.button !== 0) {
            return;
        }
        if (event.target instanceof Element && event.target.closest('.graph-node')) {
            return;
        }
        panDragState = {
            startClientX: event.clientX,
            startClientY: event.clientY,
            originPanX: transformState.panX,
            originPanY: transformState.panY
        };
        document.addEventListener('mousemove', handlePanMove);
        document.addEventListener('mouseup', stopPan);
    });

    window.addEventListener('resize', () => {
        renderEdges();
    });

    document.querySelectorAll('.hint-item').forEach(hint => {
        hint.addEventListener('click', () => {
            const nodeIdText = hint.getAttribute('data-node-id');
            const nodeId = Number(nodeIdText);
            if (!Number.isFinite(nodeId)) {
                return;
            }
            focusNode(nodeId);
        });
    });
}

function initializePositions(): void {
    const nodesByDepth = new Map<number, ExplainPlanGraphNode[]>();
    for (const node of graphNodes) {
        const depthKey = Number(node.depth || 0);
        if (!nodesByDepth.has(depthKey)) {
            nodesByDepth.set(depthKey, []);
        }
        nodesByDepth.get(depthKey)!.push(node);
    }

    const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);
    for (const depth of sortedDepths) {
        const levelNodes = nodesByDepth.get(depth) || [];
        for (let index = 0; index < levelNodes.length; index += 1) {
            const node = levelNodes[index];
            nodePositions.set(node.id, {
                x: 80 + depth * NODE_GAP_X,
                y: 70 + index * NODE_GAP_Y
            });
        }
    }
}

function renderGraph(): void {
    renderNodes();
    renderEdges();
    applyTransform();
}

function renderNodes(): void {
    if (!nodesContainer) {
        return;
    }

    nodesContainer.innerHTML = graphNodes.map(node => renderNodeHtml(node)).join('');

    for (const node of graphNodes) {
        const position = nodePositions.get(node.id);
        const element = nodesContainer.querySelector(`.graph-node[data-node-id="${node.id}"]`) as HTMLElement | null;
        if (!position || !element) {
            continue;
        }

        element.style.left = `${position.x}px`;
        element.style.top = `${position.y}px`;

        const dragHandle = element.querySelector('.graph-node-header');
        if (dragHandle) {
            dragHandle.addEventListener('mousedown', (event) => {
                startNodeDrag(event as MouseEvent, node.id);
            });
        }
    }
}

function renderNodeHtml(node: ExplainPlanGraphNode): string {
    const warningBadges = Array.isArray(node.warnings)
        ? node.warnings.map(warning => {
            const warningType = String(warning.type || 'info');
            const warningIcon = escapeHtml(String(warning.icon || '⚠️'));
            const warningMessage = escapeHtml(String(warning.message || ''));
            return `<span class="warning-badge warning-${warningType}" title="${warningMessage}">${warningIcon}</span>`;
        }).join('')
        : '';

    const operationBadges: string[] = [];
    if (node.isFullScan) {
        operationBadges.push('<span class="op-badge op-badge-scan" title="Full table scan">Full Scan</span>');
    }
    if (node.isBroadcast) {
        operationBadges.push('<span class="op-badge op-badge-broadcast" title="Broadcast/Fabric movement">Fabric Broadcast</span>');
    }

    const extraOperationClass = [
        node.isFullScan ? 'op-full-scan' : '',
        node.isBroadcast ? 'op-broadcast' : ''
    ].join(' ').trim();

    return `
        <div class="graph-node pipeline-node ${escapeHtml(String(node.costIntensity || 'cost-normal'))} ${extraOperationClass}" data-node-id="${node.id}">
            <div class="graph-node-header">
                <span class="node-type" style="background-color: ${escapeHtml(getNodeColor(node.type))}">${escapeHtml(node.type)}</span>
                ${node.table ? `<span class="node-table">${escapeHtml(node.table)}${node.alias ? ` (${escapeHtml(node.alias)})` : ''}</span>` : ''}
                ${warningBadges}
            </div>
            <div class="node-metrics graph-node-metrics">
                <span class="metric cost-metric ${escapeHtml(String(node.costIntensity || 'cost-normal'))}"><b>Cost:</b> ${formatCost(Number(node.costStart))}..${formatCost(Number(node.costEnd))}</span>
                <span class="metric"><b>Rows:</b> ${Number(node.rows || 0).toLocaleString()}</span>
                <span class="metric"><b>Width:</b> ${Number(node.width || 0)}</span>
                <span class="metric ${Number(node.confidence) === 0 ? 'low-conf' : ''}"><b>Conf:</b> ${Number(node.confidence || 0)}%</span>
            </div>
            ${operationBadges.length > 0 ? `<div class="graph-node-ops">${operationBadges.join('')}</div>` : ''}
        </div>
    `;
}

function renderEdges(): void {
    if (!edgesSvg || !stage) {
        return;
    }

    const bounds = getGraphBounds();
    const stageWidth = Math.max(2400, bounds.maxX + NODE_WIDTH + 220);
    const stageHeight = Math.max(1600, bounds.maxY + NODE_HEIGHT + 220);
    stage.style.width = `${stageWidth}px`;
    stage.style.height = `${stageHeight}px`;
    edgesSvg.setAttribute('width', String(stageWidth));
    edgesSvg.setAttribute('height', String(stageHeight));
    edgesSvg.innerHTML = '';

    for (const node of graphNodes) {
        if (node.parentId === null || node.parentId === undefined) {
            continue;
        }

        const parentPos = nodePositions.get(node.parentId);
        const childPos = nodePositions.get(node.id);
        if (!parentPos || !childPos) {
            continue;
        }

        const startX = parentPos.x + NODE_WIDTH;
        const startY = parentPos.y + NODE_HEIGHT / 2;
        const endX = childPos.x;
        const endY = childPos.y + NODE_HEIGHT / 2;
        const horizontalDistance = Math.max(100, Math.abs(endX - startX));
        const curve = horizontalDistance / 2;
        const controlA = startX + curve;
        const controlB = endX - curve;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${startX} ${startY} C ${controlA} ${startY}, ${controlB} ${endY}, ${endX} ${endY}`);
        path.setAttribute(
            'class',
            node.isBroadcast || node.isFullScan ? 'graph-edge edge-critical' : 'graph-edge'
        );
        edgesSvg.appendChild(path);
    }
}

function startNodeDrag(event: MouseEvent, nodeId: number): void {
    if (event.button !== 0) {
        return;
    }

    const position = nodePositions.get(nodeId);
    if (!position) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    nodeDragState = {
        nodeId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: position.x,
        originY: position.y
    };

    document.addEventListener('mousemove', handleNodeDragMove);
    document.addEventListener('mouseup', stopNodeDrag);
}

function handleNodeDragMove(event: MouseEvent): void {
    if (!nodeDragState) {
        return;
    }

    const deltaX = (event.clientX - nodeDragState.startClientX) / transformState.scale;
    const deltaY = (event.clientY - nodeDragState.startClientY) / transformState.scale;
    const nextX = Math.max(12, nodeDragState.originX + deltaX);
    const nextY = Math.max(12, nodeDragState.originY + deltaY);

    nodePositions.set(nodeDragState.nodeId, { x: nextX, y: nextY });

    const nodeElement = nodesContainer?.querySelector(`.graph-node[data-node-id="${nodeDragState.nodeId}"]`) as HTMLElement | null;
    if (nodeElement) {
        nodeElement.style.left = `${nextX}px`;
        nodeElement.style.top = `${nextY}px`;
    }

    renderEdges();
}

function stopNodeDrag(): void {
    nodeDragState = null;
    document.removeEventListener('mousemove', handleNodeDragMove);
    document.removeEventListener('mouseup', stopNodeDrag);
}

function handlePanMove(event: MouseEvent): void {
    if (!panDragState) {
        return;
    }

    transformState.panX = panDragState.originPanX + (event.clientX - panDragState.startClientX);
    transformState.panY = panDragState.originPanY + (event.clientY - panDragState.startClientY);
    applyTransform();
}

function stopPan(): void {
    panDragState = null;
    document.removeEventListener('mousemove', handlePanMove);
    document.removeEventListener('mouseup', stopPan);
}

function zoomAtViewportCenter(step: number): void {
    if (!viewport) {
        return;
    }
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, step);
}

function zoomAt(clientX: number, clientY: number, step: number): void {
    if (!viewport) {
        return;
    }

    const previousScale = transformState.scale;
    const nextScale = clampScale(previousScale + step);
    if (nextScale === previousScale) {
        return;
    }

    const rect = viewport.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;
    const worldX = (viewX - transformState.panX) / previousScale;
    const worldY = (viewY - transformState.panY) / previousScale;

    transformState.scale = nextScale;
    transformState.panX = viewX - worldX * nextScale;
    transformState.panY = viewY - worldY * nextScale;
    applyTransform();
}

function clampScale(scale: number): number {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

function applyTransform(): void {
    if (!stage) {
        return;
    }

    stage.style.transformOrigin = '0 0';
    stage.style.transform = `translate(${transformState.panX}px, ${transformState.panY}px) scale(${transformState.scale})`;

    if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(transformState.scale * 100)}%`;
    }
}

function fitView(): void {
    if (!viewport || graphNodes.length === 0) {
        return;
    }

    const bounds = getGraphBounds();
    const rect = viewport.getBoundingClientRect();
    const graphWidth = Math.max(1, bounds.maxX - bounds.minX + NODE_WIDTH);
    const graphHeight = Math.max(1, bounds.maxY - bounds.minY + NODE_HEIGHT);
    const scaleX = (rect.width - 80) / graphWidth;
    const scaleY = (rect.height - 80) / graphHeight;
    const scale = clampScale(Math.min(scaleX, scaleY));

    transformState.scale = scale;
    transformState.panX = (rect.width - graphWidth * scale) / 2 - bounds.minX * scale;
    transformState.panY = (rect.height - graphHeight * scale) / 2 - bounds.minY * scale;
    applyTransform();
}

function focusNode(nodeId: number): void {
    const nodeElement = nodesContainer?.querySelector(`.graph-node[data-node-id="${nodeId}"]`);
    const position = nodePositions.get(nodeId);
    if (!nodeElement || !position || !viewport) {
        return;
    }

    const rect = viewport.getBoundingClientRect();
    transformState.panX = rect.width / 2 - (position.x + NODE_WIDTH / 2) * transformState.scale;
    transformState.panY = rect.height / 2 - (position.y + NODE_HEIGHT / 2) * transformState.scale;
    applyTransform();

    nodeElement.classList.add('focused');
    setTimeout(() => nodeElement.classList.remove('focused'), 1500);
}

function getGraphBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    if (nodePositions.size === 0) {
        return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const position of nodePositions.values()) {
        if (position.x < minX) minX = position.x;
        if (position.x > maxX) maxX = position.x;
        if (position.y < minY) minY = position.y;
        if (position.y > maxY) maxY = position.y;
    }

    return { minX, maxX, minY, maxY };
}
