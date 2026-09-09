import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { createApiClient } from './api';
import './styles.css';

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
