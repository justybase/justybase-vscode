import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../../../../packages/ui-react/src/resultGrid.css';
import '../../../../packages/ui-react/src/objectDesigner.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
