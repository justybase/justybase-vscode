import {
  getDatabaseDesignerCapabilities,
  resolveDatabaseDesignerCapabilities,
  type DesignerCapabilitiesResponse,
  type DesignerCapabilitiesRequest,
} from '@justybase/contracts';
import { isDuckDbRuntimeAvailable } from './duckdb';
import type { StoredConnection } from './store';

/**
 * The API currently has embedded runtimes for these three database kinds.
 * Other kinds remain visible through the shared manifest, but must not appear
 * executable until an API-side driver/runtime adapter is registered.
 */
function hasApiRuntime(profile: StoredConnection): boolean {
  if (profile.dbType === 'duckdb') return isDuckDbRuntimeAvailable();
  return profile.dbType === 'netezza' || profile.dbType === 'sqlite';
}

export function getDesignerCapabilitiesResponse(
  profile: StoredConnection,
  request: DesignerCapabilitiesRequest,
): DesignerCapabilitiesResponse {
  const runtimeAvailable = hasApiRuntime(profile);
  const target = {
    connectionId: profile.id,
    connectionName: profile.name,
    ...(request.database ? { database: request.database } : {}),
    ...(request.schema ? { schema: request.schema } : {}),
    ...(request.objectName ? { objectName: request.objectName } : {}),
    ...(request.objectType ? { objectType: request.objectType } : {}),
  };
  const base = getDatabaseDesignerCapabilities(profile.dbType);
  const capabilities = resolveDatabaseDesignerCapabilities(base, {
    databaseKind: profile.dbType,
    runtimeAvailable,
    readOnly: profile.readOnly,
    objectKind: request.objectType,
  });

  return {
    target,
    capabilities,
    runtimeAvailable,
    readOnly: profile.readOnly,
  };
}
