import { generateEtlDesignerHtml } from '../views/etl/etlDesignerTemplate';
import { getEtlDesignerStyles } from '../views/etl/etlDesignerStyles';
import { getEtlDesignerScript } from '../views/etl/etlDesignerScript';
import { generateEtlDesignerScript } from '../views/etl/scripts/index';
import { getConnectionsScript } from '../views/etl/scripts/connections';
import { getContainerEditorScript } from '../views/etl/scripts/containerEditor';
import { getEventHandlersScript } from '../views/etl/scripts/eventHandlers';
import { getMainCanvasScript } from '../views/etl/scripts/mainCanvas';
import { getPropertiesScript } from '../views/etl/scripts/properties';
import { getStateScript } from '../views/etl/scripts/state';
import { getUtilsScript } from '../views/etl/scripts/utils';
import { getZoomPanScript } from '../views/etl/scripts/zoomPan';
import { EtlProject } from '../etl/etlTypes';

describe('views/etl generated assets', () => {
    const project: EtlProject = {
        name: 'Sample ETL',
        version: '1.0.0',
        nodes: [
            {
                id: 'n1',
                type: 'sql',
                name: 'Load Data',
                position: { x: 100, y: 200 },
                config: { type: 'sql', query: 'SELECT 1' }
            }
        ],
        connections: []
    };

    it('should generate etl styles with expected selectors', () => {
        const css = getEtlDesignerStyles();
        expect(css).toContain('.etl-designer');
        expect(css).toContain('.toolbar');
        expect(css).toContain('.canvas-container');
    });

    it('should generate all script fragments', () => {
        expect(getStateScript(project)).toContain('let project =');
        expect(getUtilsScript()).toContain('function escapeHtml');
        expect(getZoomPanScript()).toContain('function setupZoomPan');
        expect(getConnectionsScript()).toContain('function renderConnections');
        expect(getMainCanvasScript()).toContain('function renderNodes');
        expect(getPropertiesScript()).toContain('function updatePropertiesPanel');
        expect(getEventHandlersScript()).toContain('function setupToolbarButtons');
        expect(getContainerEditorScript()).toContain('function openContainerEditor');
    });

    it('should generate assembled script and wrapper script', () => {
        const script = generateEtlDesignerScript(project);
        const wrapper = getEtlDesignerScript(project);

        expect(script).toContain('function init()');
        expect(script).toContain("vscode.postMessage({ type: 'getProject' })");
        expect(wrapper).toContain('function init()');
        expect(wrapper).toContain('renderNodes();');
    });

    it('should generate full etl designer html', () => {
        const html = generateEtlDesignerHtml({ project, nonce: 'abc123' });

        expect(html).toContain('<title>ETL Designer - Sample ETL</title>');
        expect(html).toContain("script-src 'nonce-abc123'");
        expect(html).toContain('id="canvas"');
        expect(html).toContain('id="container-editor-overlay"');
        expect(html).toContain('Load Data');
    });
});

