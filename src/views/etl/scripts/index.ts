/**
 * Main assembler for ETL Designer webview script
 * Combines all modular script sections into a single executable script
 */

import { EtlProject } from '../../../etl/etlTypes';
import { getStateScript } from './state';
import { getUtilsScript } from './utils';
import { getZoomPanScript } from './zoomPan';
import { getConnectionsScript } from './connections';
import { getEventHandlersScript } from './eventHandlers';
import { getPropertiesScript } from './properties';
import { getMainCanvasScript } from './mainCanvas';
import { getContainerEditorScript } from './containerEditor';

/**
 * Generates the complete JavaScript code for the ETL Designer webview
 */
export function generateEtlDesignerScript(project: EtlProject): string {
    return `
        (function() {
            'use strict';
            
            ${getStateScript(project)}
            
            ${getUtilsScript()}
            
            ${getZoomPanScript()}
            
            ${getConnectionsScript()}
            
            ${getMainCanvasScript()}
            
            ${getPropertiesScript()}
            
            ${getEventHandlersScript()}
            
            ${getContainerEditorScript()}
            
            // Initialize function
            function init() {
                renderNodes();
                renderConnections();
                setupToolboxDrag();
                setupCanvasDrop();
                setupToolbarButtons();
                setupKeyboardEvents();
                setupZoomPan();
                setupContainerEditor();
                
                // Request current project state
                vscode.postMessage({ type: 'getProject' });
            }
            
            // Start
            init();
        })();
    `;
}
