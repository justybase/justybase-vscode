import { createRoot } from 'react-dom/client';
import { EtlDiagramApp } from './diagram/EtlDiagramApp';
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

const payload = readPayload<import('../src/etl/etlTypes').EtlProject>('etl-payload');
const rootElement = document.getElementById('etl-root');
if (payload && rootElement) {
    createRoot(rootElement).render(<EtlDiagramApp project={payload} />);
}
