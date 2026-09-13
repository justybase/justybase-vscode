import { createContext, createElement, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createApiClient as createSharedApiClient } from '@justybase/api-client';
import type {
  ApiClientOptions,
  WorkspaceApi,
} from '@justybase/api-client';

export { ApiRequestError } from '@justybase/api-client';
export type { ApiClientOptions, QueryEventSubscription } from '@justybase/api-client';

/** Web keeps only the React context; HTTP, CSRF and WebSocket behavior is shared. */
export function createApiClient(options: ApiClientOptions = {}): WorkspaceApi {
  return createSharedApiClient(options);
}

export type ApiClient = WorkspaceApi;

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }): ReactElement {
  return createElement(ApiClientContext.Provider, { value: client, children });
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used below ApiClientProvider.');
  return client;
}

/** Allows reusable Web panels to be embedded below a different composition root. */
export function useOptionalApiClient(): ApiClient | null {
  return useContext(ApiClientContext);
}
