/**
 * ETL Designer - CSS Styles
 * Contains all styling for the ETL Designer webview
 */

export function getEtlDesignerStyles(): string {
    return `
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --bg-hover: var(--vscode-list-hoverBackground);
            --border-color: var(--vscode-panel-border);
            --text-color: var(--vscode-editor-foreground);
            --text-muted: var(--vscode-descriptionForeground);
            --accent-color: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --success-color: #4CAF50;
            --error-color: #f44336;
            --warning-color: #ff9800;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            overflow: hidden;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--text-color);
            background: var(--bg-primary);
        }

        .etl-designer {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        /* Toolbar */
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 16px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
        }

        .toolbar button {
            padding: 6px 12px;
            margin-right: 4px;
            border: 1px solid var(--border-color);
            background: var(--bg-primary);
            color: var(--text-color);
            cursor: pointer;
            border-radius: 4px;
        }

        .toolbar button:hover {
            background: var(--bg-hover);
        }

        .toolbar .btn-primary {
            background: var(--accent-color);
            border-color: var(--accent-color);
        }

        .toolbar .btn-primary:hover {
            background: var(--accent-hover);
        }

        .toolbar .btn-danger {
            background: var(--error-color);
            border-color: var(--error-color);
            color: white;
        }

        .toolbar .btn-danger:hover {
            opacity: 0.8;
        }

        .toolbar .separator {
            display: inline-block;
            width: 1px;
            height: 20px;
            background: var(--border-color);
            margin: 0 8px;
        }

        .project-name {
            font-weight: bold;
            font-size: 1.1em;
        }

        .status {
            color: var(--text-muted);
            font-size: 0.9em;
        }

        /* Main Content */
        .main-content {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        /* Toolbox */
        .toolbox {
            width: 200px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border-color);
            padding: 12px;
            overflow-y: auto;
        }

        .toolbox h3 {
            margin: 0 0 12px 0;
            font-size: 0.9em;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .toolbox-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 12px;
            margin-bottom: 6px;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            cursor: grab;
            transition: all 0.15s ease;
        }

        .toolbox-item:hover {
            border-color: var(--accent-color);
            transform: translateX(3px);
        }

        .toolbox-item:active {
            cursor: grabbing;
        }

        .toolbox-item .icon {
            font-size: 1.2em;
        }

        .toolbox-item .label {
            font-size: 0.85em;
        }

        .help-text {
            font-size: 0.8em;
            color: var(--text-muted);
            line-height: 1.6;
        }

        .help-text p {
            margin: 4px 0;
        }

        /* Canvas */
        .canvas-container {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: var(--bg-primary);
            cursor: grab;
        }
        
        .canvas-container:active {
            cursor: grabbing;
        }

        .zoom-wrapper {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            transform-origin: 0 0;
            background: 
                linear-gradient(90deg, rgba(128,128,128,0.1) 1px, transparent 1px),
                linear-gradient(rgba(128,128,128,0.1) 1px, transparent 1px);
            background-size: 20px 20px;
        }

        .connections-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
        }

        .connections-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 5;
            pointer-events: none;
        }

        .connections-layer path.connection-line {
            stroke: var(--success-color);
            stroke-width: 2;
            fill: none;
            pointer-events: none;
        }
        
        .connections-layer path.connection-failure {
            stroke: var(--error-color);
        }
        
        .connections-layer path.connection-hit {
            stroke: transparent;
            stroke-width: 15px;
            fill: none;
            pointer-events: stroke;
            cursor: pointer;
        }

        .connections-layer path.connection-hit:hover + .connection-line {
            stroke-width: 3;
            filter: drop-shadow(0 0 2px currentColor);
        }

        .connections-layer marker polygon {
            fill: var(--accent-color);
        }

        .nodes-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2;
            pointer-events: none;
        }

        .etl-node {
            pointer-events: all;
        }

        /* Nodes */
        .etl-node {
            position: absolute;
            min-width: 160px;
            background: var(--bg-secondary);
            border: 2px solid var(--border-color);
            border-radius: 8px;
            cursor: move;
            user-select: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }

        .etl-node:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }

        .etl-node.selected {
            border-color: var(--accent-color);
        }

        .etl-node.running {
            border-color: var(--warning-color);
            animation: pulse 1s infinite;
        }

        .etl-node.success {
            border-color: var(--success-color);
        }

        .etl-node.error {
            border-color: var(--error-color);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }

        .node-type-indicator {
            height: 4px;
            border-radius: 6px 6px 0 0;
        }

        .etl-node.sql .node-type-indicator { background: #4CAF50; }
        .etl-node.python .node-type-indicator { background: #3776AB; }
        .etl-node.container .node-type-indicator { background: #FF9800; }
        .etl-node.export .node-type-indicator { background: #2196F3; }
        .etl-node.import .node-type-indicator { background: #9C27B0; }

        .node-content {
            padding: 10px 12px;
        }

        .node-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
        }

        .node-icon {
            font-size: 1.2em;
        }

        .node-name {
            font-weight: 500;
            font-size: 0.9em;
        }

        .node-type {
            font-size: 0.75em;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .node-connectors {
            position: relative;
        }

        .node-actions {
            position: absolute;
            top: -8px;
            right: -8px;
            display: none;
        }

        .etl-node:hover .node-actions,
        .etl-node.selected .node-actions {
            display: block;
        }

        .node-delete-btn {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: var(--error-color);
            color: white;
            border: 2px solid var(--bg-secondary);
            font-size: 12px;
            line-height: 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .node-delete-btn:hover {
            transform: scale(1.2);
        }

        .connector {
            width: 14px;
            height: 14px;
            background: var(--accent-color);
            border: 2px solid var(--bg-secondary);
            border-radius: 50%;
            position: absolute;
            cursor: crosshair;
            z-index: 10;
        }

        .connector.input {
            left: -9px;
            top: 50%;
            transform: translateY(-50%);
        }

        .connector.output {
            right: -9px;
            top: 50%;
            transform: translateY(-50%);
        }

        .connector:hover {
            transform: translateY(-50%) scale(1.3);
        }

        /* Properties Panel */
        .properties-panel {
            width: 250px;
            background: var(--bg-secondary);
            border-left: 1px solid var(--border-color);
            padding: 12px;
            overflow-y: auto;
        }

        .properties-panel h3 {
            margin: 0 0 12px 0;
            font-size: 0.9em;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .properties-panel .placeholder {
            color: var(--text-muted);
            font-style: italic;
        }

        .property-group {
            margin-bottom: 16px;
        }

        .property-label {
            display: block;
            font-size: 0.8em;
            color: var(--text-muted);
            margin-bottom: 4px;
        }

        .property-value {
            font-size: 0.9em;
            word-break: break-word;
        }

        .property-code {
            font-family: monospace;
            font-size: 0.8em;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 6px 8px;
            margin: 4px 0 0 0;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 80px;
            overflow-y: auto;
        }

        .configure-btn {
            width: 100%;
            margin-top: 16px;
            padding: 8px 12px;
            background: var(--accent-color);
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85em;
        }

        .configure-btn:hover {
            background: var(--accent-hover);
        }

        /* Connection line being drawn */
        .temp-connection {
            stroke: var(--accent-color);
            stroke-width: 2;
            stroke-dasharray: 5,5;
            fill: none;
            pointer-events: none;
        }

        /* Container Editor Modal */
        .container-editor-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .container-editor-modal {
            width: 90%;
            height: 85%;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }

        .container-editor-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border-color);
            border-radius: 8px 8px 0 0;
        }

        .container-editor-title {
            font-weight: 600;
            font-size: 1.1em;
        }

        .container-editor-close {
            width: 28px;
            height: 28px;
            border: none;
            background: transparent;
            color: var(--text-color);
            font-size: 18px;
            cursor: pointer;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .container-editor-close:hover {
            background: var(--error-color);
            color: white;
        }

        .container-editor-content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }

        .container-editor-toolbox {
            width: 180px;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border-color);
            padding: 12px;
            overflow-y: auto;
        }

        .container-editor-toolbox h4 {
            margin: 0 0 10px 0;
            font-size: 0.85em;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .container-editor-canvas {
            flex: 1;
            position: relative;
            overflow: hidden;
            background: var(--bg-primary);
        }

        .container-editor-canvas .zoom-wrapper {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: 
                linear-gradient(90deg, rgba(128,128,128,0.08) 1px, transparent 1px),
                linear-gradient(rgba(128,128,128,0.08) 1px, transparent 1px);
            background-size: 20px 20px;
        }

        .container-editor-footer {
            padding: 10px 16px;
            background: var(--bg-secondary);
            border-top: 1px solid var(--border-color);
            border-radius: 0 0 8px 8px;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .container-editor-footer button {
            padding: 6px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
        }

        .container-editor-footer .btn-save {
            background: var(--accent-color);
            color: white;
            border: none;
        }

        .container-editor-footer .btn-save:hover {
            background: var(--accent-hover);
        }

        .container-editor-footer .btn-cancel {
            background: transparent;
            color: var(--text-color);
            border: 1px solid var(--border-color);
        }

        .container-editor-footer .btn-cancel:hover {
            background: var(--bg-hover);
        }

        /* Container node badge showing child count */
        .node-child-count {
            font-size: 0.7em;
            background: var(--warning-color);
            color: white;
            padding: 2px 6px;
            border-radius: 10px;
            margin-left: 4px;
        }
    `;
}
