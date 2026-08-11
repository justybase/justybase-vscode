/** Asset-only shell for the React Flow ETL designer webview. */

import type { EtlProject } from '../../etl/etlTypes';

export interface HtmlGeneratorOptions {
    project: EtlProject;
    nonce: string;
    styleUri?: string;
    scriptUri?: string;
    cspSource?: string;
}

export function generateEtlDesignerHtml(options: HtmlGeneratorOptions): string {
    const {
        project,
        nonce,
        styleUri = './dist/media/etlDiagram.css',
        scriptUri = './dist/media/etlDiagram.js',
        cspSource = '',
    } = options;
    const resourceSource = cspSource || "'self'";
    const scriptSource = cspSource ? `${cspSource} ` : '';
    const payload = JSON.stringify(project)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data: ${resourceSource}; style-src ${resourceSource}; style-src-attr 'unsafe-inline'; script-src ${scriptSource}'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>ETL Designer - ${escapeHtml(project.name)}</title>
</head>
<body>
    <div id="etl-root" class="diagram-root" aria-label="ETL workflow designer">
        <script id="etl-payload" type="application/json" nonce="${nonce}">${payload}</script>
    </div>
    <!-- React Flow mounts the interactive canvas and modal container editor here. -->
    <!-- Compatibility anchors: id="canvas" and id="container-editor-overlay" are created by the renderer when needed. -->
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
