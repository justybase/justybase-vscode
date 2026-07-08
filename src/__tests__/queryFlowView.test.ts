import * as vscode from 'vscode';
import { QueryFlowView } from '../views/queryFlowView';
import type { QueryFlowGraph } from '../sqlParser';

jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: jest.fn()
    },
    ViewColumn: { One: 1, Beside: 2 }
}));

function createPanelMock() {
    let receiveMessageHandler: ((message: { command: string; nodeId?: string }) => void) | undefined;
    const webview = {
        html: '',
        onDidReceiveMessage: jest.fn((handler: (message: { command: string; nodeId?: string }) => void) => {
            receiveMessageHandler = handler;
            return { dispose: jest.fn() };
        })
    };
    const panel = {
        title: '',
        webview,
        reveal: jest.fn(),
        onDidDispose: jest.fn((_handler: () => void, _ctx?: unknown, disposables?: { dispose: () => void }[]) => {
            disposables?.push({ dispose: jest.fn() });
            return { dispose: jest.fn() };
        }),
        dispose: jest.fn()
    };
    return { panel, getReceiveMessageHandler: () => receiveMessageHandler };
}

describe('QueryFlowView', () => {
    const sampleGraph: QueryFlowGraph = {
        statementIndex: 0,
        statementKind: 'with_select',
        statementRange: { startOffset: 0, endOffset: 140, startLine: 0, endLine: 7 },
        rootNodeId: 'node-3',
        nodes: [
            { id: 'node-1', kind: 'table', label: 'SALES..ORDERS', statementIndex: 0, startOffset: 25, endOffset: 38, startLine: 1, endLine: 1 },
            { id: 'node-2', kind: 'cte', label: 'REGION_SALES', statementIndex: 0, startOffset: 0, endOffset: 70, startLine: 0, endLine: 3 },
            { id: 'node-3', kind: 'query', label: 'Final SELECT', statementIndex: 0, startOffset: 72, endOffset: 140, startLine: 5, endLine: 7 }
        ],
        edges: [
            { id: 'node-1->node-2:FROM', from: 'node-1', to: 'node-2', label: 'FROM' },
            { id: 'node-2->node-3:FROM', from: 'node-2', to: 'node-3', label: 'FROM' }
        ]
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (QueryFlowView as unknown as { currentPanel: undefined }).currentPanel = undefined;
    });

    it('renders the flow panel and reuses an existing panel', () => {
        const { panel } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        const revealNode = jest.fn();
        QueryFlowView.createOrShow(sampleGraph, revealNode);

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'netezza.queryFlow',
            'Query Flow Map',
            1,
            expect.objectContaining({ enableScripts: true })
        );
        expect(panel.webview.html).toContain('Interactive Execution Flow Map');
        expect(panel.webview.html).toContain('REGION_SALES');
        expect(panel.webview.html).toContain('original editor without leaving the flow map');
        expect(panel.webview.html).toContain('edge-label-bg');
        expect(panel.webview.html).toContain('setActiveNode(node.id)');
        expect(panel.webview.html).toContain('const stageMetrics =');
        expect(panel.webview.html).toContain('function getStageBounds(layout)');

        QueryFlowView.createOrShow(sampleGraph, revealNode);
        expect(panel.reveal).toHaveBeenCalled();
    });

    it('routes node click messages back to the extension host', async () => {
        const { panel, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        const revealNode = jest.fn().mockResolvedValue(undefined);
        QueryFlowView.createOrShow(sampleGraph, revealNode);

        const handler = getReceiveMessageHandler();
        expect(handler).toBeDefined();

        handler?.({ command: 'revealNode', nodeId: 'node-2' });
        await Promise.resolve();

        expect(revealNode).toHaveBeenCalledWith(sampleGraph.nodes[1]);
    });
});
