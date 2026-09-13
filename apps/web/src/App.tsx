import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { WebUser } from '@justybase/contracts';
import { AsyncStateView } from '@justybase/ui-react';
import { ApiClientProvider, ApiRequestError, createApiClient, useApiClient, type ApiClient } from './api';
import { Login } from './workspacePanels';
import { SharedWebWorkspace } from './sharedUiAdapter';

export function App({ apiClient }: { apiClient?: ApiClient } = {}): ReactElement {
  const defaultClientRef = useRef<ApiClient | undefined>(undefined);
  if (!defaultClientRef.current) defaultClientRef.current = apiClient ?? createApiClient();
  return <ApiClientProvider client={apiClient ?? defaultClientRef.current}><AuthenticatedApp /></ApiClientProvider>;
}

/** The production Web composition root always uses the host-independent Shared UI. */
function AuthenticatedApp(): ReactElement {
  const api = useApiClient();
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | undefined>(undefined);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setBootstrapError(undefined);
    void api.me().then(response => {
      if (live) setUser(response.user);
    }).catch(error => {
      if (!live) return;
      // A normal anonymous session belongs on the login screen. Transport,
      // API, and bootstrap failures need an actionable retry state instead of
      // silently looking like a logged-out user.
      if (error instanceof ApiRequestError && error.status === 401) {
        setUser(null);
        return;
      }
      setBootstrapError(error instanceof Error ? error.message : 'Could not contact the Web API.');
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [api, bootstrapAttempt]);

  if (loading) return <AsyncStateView state="loading" loadingLabel="Loading JustyBase…" />;
  if (bootstrapError) return <main className="center-message" role="alert"><div className="card"><h1>Web workspace unavailable</h1><p>{bootstrapError}</p><button type="button" onClick={() => setBootstrapAttempt(previous => previous + 1)}>Retry</button></div></main>;
  if (!user) return <Login onLogin={setUser} />;
  return <SharedWebWorkspace api={api} user={user} onLogout={() => setUser(null)} />;
}
