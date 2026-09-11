import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { createApiClient } from './api';
import './styles.css';
import '../../../packages/ui-react/src/resultGrid.css';

// Vite replaces VITE_UI_MODE at build time. Keep the selected mode on the
// runtime global consumed by the composition root so direct component tests
// can still override it without adding mode state to the API or browser
// persistence layer.
const webRuntimeConfig = globalThis as {
  __JUSTYBASE_UI_MODE__?: unknown;
  __JUSTYBASE_ENABLE_TEST_LOGIN__?: boolean;
};
if (import.meta.env.VITE_UI_MODE !== undefined) webRuntimeConfig.__JUSTYBASE_UI_MODE__ = import.meta.env.VITE_UI_MODE;

// Vite replaces these values at build time. Keeping the test-only flag on a
// runtime global makes the Login component easy to exercise in jsdom without
// ever putting test credentials in the module graph or browser storage.
webRuntimeConfig.__JUSTYBASE_ENABLE_TEST_LOGIN__ = import.meta.env.MODE === 'test'
  && import.meta.env.VITE_ENABLE_TEST_LOGIN === '1';

const queryClient = new QueryClient();
const apiClient = createApiClient({
  httpBaseUrl: import.meta.env.VITE_API_HTTP_BASE_URL,
  webSocketBaseUrl: import.meta.env.VITE_API_WEBSOCKET_BASE_URL,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App apiClient={apiClient} />
    </QueryClientProvider>
  </StrictMode>,
);
