import type { UiIdentity } from '@justybase/contracts';
import type { WorkspaceStorage } from '../workspacePersistence';
import {
  DEFAULT_DOCKYARD_EXPLORER_WIDTH,
  DOCKYARD_CONTENT_IDS,
  DOCKYARD_LAYOUT_IDS,
  DockyardManagerAdapter as SharedDockyardManagerAdapter,
  createDefaultDockyardLayout,
  explainToolId,
  filterDockyardContextMenu,
  normalizeDockyardSnapshot,
  queryDocumentId,
} from '@justybase/dockyard-layout';
import type {
  DockyardContentDefinition,
  DockyardManagerAdapterOptions as SharedDockyardManagerAdapterOptions,
  DockyardManagerCallbacks,
} from '@justybase/dockyard-layout';

export {
  DEFAULT_DOCKYARD_EXPLORER_WIDTH,
  DOCKYARD_CONTENT_IDS,
  DOCKYARD_LAYOUT_IDS,
  createDefaultDockyardLayout,
  explainToolId,
  filterDockyardContextMenu,
  normalizeDockyardSnapshot,
  queryDocumentId,
};
export type { DockyardContentDefinition, DockyardManagerCallbacks };

export interface DockyardManagerAdapterOptions extends Omit<SharedDockyardManagerAdapterOptions, 'identity' | 'storage'> {
  storage: WorkspaceStorage;
}

function identityFor(userId: string): UiIdentity {
  return { productId: 'web', userId, workspaceId: `web:${userId}` };
}

export class DockyardManagerAdapter extends SharedDockyardManagerAdapter {
  public constructor(options: DockyardManagerAdapterOptions) {
    super({ ...options, identity: identityFor(options.storage.userId) });
  }
}
