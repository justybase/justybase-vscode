/**
 * State management for ETL Designer webview
 */

import { EtlProject } from '../../../etl/etlTypes';

/**
 * Generates the state initialization section of the script
 */
export function getStateScript(project: EtlProject): string {
    return `
        const vscode = acquireVsCodeApi();
        
        // State
        let project = ${JSON.stringify(project)};
        let selectedNodeId = null;
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        let isConnecting = false;
        let connectionStart = null;
        let tempLine = null;
        
        // Zoom & Pan state
        let scale = 1;
        let pan = { x: 0, y: 0 };
        let isPanning = false;
        let panStart = { x: 0, y: 0 };

        // Container Editor state
        let containerEditorOpen = false;
        let editingContainerId = null;
        let containerNodes = [];
        let containerConnections = [];
        let containerSelectedNodeId = null;
        let containerIsDragging = false;
        let containerDragOffset = { x: 0, y: 0 };
        let containerIsConnecting = false;
        let containerConnectionStart = null;
        let containerTempLine = null;

        // Node icons
        const nodeIcons = {
            sql: '📜',
            python: '🐍',
            container: '📦',
            export: '📤',
            import: '📥',
            variable: '🔤'
        };
    `;
}
