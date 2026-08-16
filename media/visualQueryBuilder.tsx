import { createRoot } from 'react-dom/client';
import { VisualQueryBuilderApp } from './visualQueryBuilder/VisualQueryBuilderApp.js';
import type { VisualQueryBuilderBootstrapState } from './visualQueryBuilder/hostContracts.js';
import './diagram/diagram.css';
import './visualQueryBuilder.css';
import '@xyflow/react/dist/style.css';

function readPayload(): VisualQueryBuilderBootstrapState | undefined {
    const element = document.getElementById('visual-query-builder-payload');
    if (!element?.textContent) return undefined;
    try {
        return JSON.parse(element.textContent) as VisualQueryBuilderBootstrapState;
    } catch {
        return undefined;
    }
}

const rootElement = document.getElementById('visual-query-builder-root');
if (rootElement) {
    createRoot(rootElement).render(<VisualQueryBuilderApp initialState={readPayload()} />);
}
