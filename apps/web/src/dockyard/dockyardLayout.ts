import type { UiIdentity } from '@justybase/contracts';
import type { LayoutSnapshot } from 'avalondock-web';
import type { WorkspaceStorage } from '../workspacePersistence';
import {
  DOCKYARD_LAYOUT_SCHEMA_VERSION,
  DOCKYARD_LAYOUT_STORAGE_KEY,
  DOCKYARD_UPSTREAM_COMMIT,
  DOCKYARD_UPSTREAM_VERSION,
  loadDockyardLayout as loadSharedDockyardLayout,
  parseDockyardLayout,
  resetDockyardLayout as resetSharedDockyardLayout,
  saveDockyardLayout as saveSharedDockyardLayout,
} from '@justybase/dockyard-layout';

export {
  DOCKYARD_LAYOUT_SCHEMA_VERSION,
  DOCKYARD_LAYOUT_STORAGE_KEY,
  DOCKYARD_UPSTREAM_COMMIT,
  DOCKYARD_UPSTREAM_VERSION,
  parseDockyardLayout,
};

function identityFor(userId: string): UiIdentity {
  return { productId: 'web', userId, workspaceId: `web:${userId}` };
}

export function saveDockyardLayout(storage: WorkspaceStorage, snapshot: LayoutSnapshot): void {
  saveSharedDockyardLayout(storage, identityFor(storage.userId), snapshot);
}

export function loadDockyardLayout(storage: WorkspaceStorage): LayoutSnapshot | undefined {
  return loadSharedDockyardLayout(storage, identityFor(storage.userId));
}

export function resetDockyardLayout(storage: WorkspaceStorage): void {
  resetSharedDockyardLayout(storage);
}
