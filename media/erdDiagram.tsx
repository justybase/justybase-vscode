import { createRoot } from 'react-dom/client';
import { ErdDiagramApp } from './diagram/ErdDiagramApp';
import './diagram/diagram.css';
import '@xyflow/react/dist/style.css';

function readPayload<T>(elementId: string): T | undefined {
    const element = document.getElementById(elementId);
    if (!element?.textContent) return undefined;
    try {
        return JSON.parse(element.textContent) as T;
    } catch {
        return undefined;
    }
}

const payload = readPayload<import('../src/schema/erdProvider').ERDData>('erd-payload');
const rootElement = document.getElementById('erd-root');
if (payload && rootElement) {
    createRoot(rootElement).render(<ErdDiagramApp data={payload} />);
}
