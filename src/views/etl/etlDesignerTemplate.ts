/**
 * ETL Designer - HTML Template Generator
 * Generates the complete HTML for the ETL Designer webview
 */

import { EtlProject } from '../../etl/etlTypes';
import { getEtlDesignerStyles } from './etlDesignerStyles';
import { getEtlDesignerScript } from './etlDesignerScript';

export interface HtmlGeneratorOptions {
    project: EtlProject;
    nonce: string;
}

/**
 * Generates the toolbar HTML section
 */
function getToolbarHtml(projectName: string): string {
    return `
        <header class="toolbar">
            <div class="toolbar-left">
                <button id="btn-new" title="New Project">📄 New</button>
                <button id="btn-open" title="Open Project">📂 Open</button>
                <button id="btn-save" title="Save Project">💾 Save</button>
                <span class="separator"></span>
                <button id="btn-run" class="btn-primary" title="Run Project">▶️ Run</button>
                <button id="btn-stop" class="btn-danger" title="Stop Execution" style="display:none;">⏹️ Stop</button>
            </div>
            <div class="toolbar-center">
                <span class="project-name">${projectName}</span>
            </div>
            <div class="toolbar-right">
                <span class="status" id="status"></span>
            </div>
        </header>`;
}

/**
 * Generates the toolbox sidebar HTML section
 */
function getToolboxHtml(): string {
    return `
        <aside class="toolbox">
            <h3>📦 Tasks</h3>
            <div class="toolbox-items">
                <div class="toolbox-item" data-type="variable" draggable="true">
                    <span class="icon">🔤</span>
                    <span class="label">Variable</span>
                </div>
                <div class="toolbox-item" data-type="sql" draggable="true">
                    <span class="icon">📜</span>
                    <span class="label">SQL Task</span>
                </div>
                <div class="toolbox-item" data-type="python" draggable="true">
                    <span class="icon">🐍</span>
                    <span class="label">Python Script</span>
                </div>
                <div class="toolbox-item" data-type="container" draggable="true">
                    <span class="icon">📦</span>
                    <span class="label">Container</span>
                </div>
                <div class="toolbox-item" data-type="export" draggable="true">
                    <span class="icon">📤</span>
                    <span class="label">Export (CSV/XLSB)</span>
                </div>
                <div class="toolbox-item" data-type="import" draggable="true">
                    <span class="icon">📥</span>
                    <span class="label">Import (CSV/XLSB)</span>
                </div>
            </div>
            
            <h3>ℹ️ Help</h3>
            <div class="help-text">
                <p>Drag tasks to canvas</p>
                <p>Connect outputs to inputs</p>
                <p>Double-click to configure</p>
                <p>Connected = Sequential</p>
                <p>Unconnected = Parallel</p>
                <p>Use \${name} in SQL</p>
            </div>
        </aside>`;
}

/**
 * Generates the canvas HTML section
 */
function getCanvasHtml(): string {
    return `
        <main class="canvas-container" id="canvas">
            <div id="zoom-wrapper" class="zoom-wrapper">
                <svg class="connections-layer" id="connections-svg">
                    <defs>
                        <marker id="arrowhead" markerWidth="10" markerHeight="7" 
                            refX="10" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#4caf50" />
                        </marker>
                        <marker id="arrowhead-failure" markerWidth="10" markerHeight="7" 
                            refX="10" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#f44336" />
                        </marker>
                    </defs>
                </svg>
                <div class="nodes-layer" id="nodes-container"></div>
            </div>
        </main>`;
}

/**
 * Generates the properties panel HTML section
 */
function getPropertiesPanelHtml(): string {
    return `
        <aside class="properties-panel" id="properties">
            <h3>⚙️ Properties</h3>
            <div id="properties-content">
                <p class="placeholder">Select a task to view properties</p>
            </div>
        </aside>`;
}

/**
 * Generates the Container Editor Modal HTML
 */
function getContainerEditorHtml(): string {
    return `
        <div id="container-editor-overlay" class="container-editor-overlay" style="display:none;">
            <div class="container-editor-modal">
                <header class="container-editor-header">
                    <span id="container-editor-title" class="container-editor-title">📦 Edit Container</span>
                    <button id="container-editor-close" class="container-editor-close" title="Close">✕</button>
                </header>
                <div class="container-editor-content">
                    <aside class="container-editor-toolbox">
                        <h4>📦 Tasks</h4>
                        <div class="toolbox-item" data-type="variable" data-container="true" draggable="true">
                            <span class="icon">🔤</span>
                            <span class="label">Variable</span>
                        </div>
                        <div class="toolbox-item" data-type="sql" data-container="true" draggable="true">
                            <span class="icon">📜</span>
                            <span class="label">SQL Task</span>
                        </div>
                        <div class="toolbox-item" data-type="python" data-container="true" draggable="true">
                            <span class="icon">🐍</span>
                            <span class="label">Python</span>
                        </div>
                        <div class="toolbox-item" data-type="export" data-container="true" draggable="true">
                            <span class="icon">📤</span>
                            <span class="label">Export</span>
                        </div>
                        <div class="toolbox-item" data-type="import" data-container="true" draggable="true">
                            <span class="icon">📥</span>
                            <span class="label">Import</span>
                        </div>
                    </aside>
                    <div class="container-editor-canvas" id="container-canvas">
                        <div class="zoom-wrapper" id="container-zoom-wrapper">
                            <svg class="connections-layer" id="container-connections-svg">
                                <defs>
                                    <marker id="container-arrowhead" markerWidth="10" markerHeight="7" 
                                        refX="10" refY="3.5" orient="auto">
                                        <polygon points="0 0, 10 3.5, 0 7" fill="#4caf50" />
                                    </marker>
                                    <marker id="container-arrowhead-failure" markerWidth="10" markerHeight="7" 
                                        refX="10" refY="3.5" orient="auto">
                                        <polygon points="0 0, 10 3.5, 0 7" fill="#f44336" />
                                    </marker>
                                </defs>
                            </svg>
                            <div class="nodes-layer" id="container-nodes"></div>
                        </div>
                    </div>
                </div>
                <footer class="container-editor-footer">
                    <button id="container-editor-cancel" class="btn-cancel">Cancel</button>
                    <button id="container-editor-save" class="btn-save">💾 Save</button>
                </footer>
            </div>
        </div>`;
}

/**
 * Generates the complete HTML for the ETL Designer webview
 */
export function generateEtlDesignerHtml(options: HtmlGeneratorOptions): string {
    const { project, nonce } = options;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>ETL Designer - ${project.name}</title>
    <style>${getEtlDesignerStyles()}</style>
</head>
<body>
    <div class="etl-designer">
        ${getToolbarHtml(project.name)}

        <div class="main-content">
            ${getToolboxHtml()}
            ${getCanvasHtml()}
            ${getPropertiesPanelHtml()}
        </div>
    </div>

    ${getContainerEditorHtml()}

    <script nonce="${nonce}">
        ${getEtlDesignerScript(project)}
    </script>
</body>
</html>`;
}
