import {
  createPersistenceEnvelope,
  decodePersistenceEnvelope,
  encodePersistenceEnvelope,
} from '@justybase/ui-core';
import type { UiIdentity } from '@justybase/contracts';
import type { LayoutSnapshot } from 'avalondock-web';
import type { WorkspaceStorage } from '../workspacePersistence';

export const DOCKYARD_LAYOUT_STORAGE_KEY = 'dockyard_layout_v1';
export const DOCKYARD_LAYOUT_SCHEMA_VERSION = 1 as const;
export const DOCKYARD_UPSTREAM_VERSION = '0.1.0' as const;
export const DOCKYARD_UPSTREAM_COMMIT = '921b9a66cac88b07af6edb3ebd5cd47af500c900' as const;

const DOCKYARD_PERSISTENCE_FORMAT = 'justybase-dockyard-layout' as const;

interface DockyardLayoutPayload {
  readonly format: typeof DOCKYARD_PERSISTENCE_FORMAT;
  readonly dockyardVersion: typeof DOCKYARD_UPSTREAM_VERSION;
  readonly dockyardCommit: typeof DOCKYARD_UPSTREAM_COMMIT;
  readonly snapshot: LayoutSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDockyardSnapshot(value: unknown): value is LayoutSnapshot {
  if (!(isRecord(value)
    && value.format === 'avalondock-web'
    && value.version === 1
    && isRecord(value.layout))) return false;
  try {
    // The upstream serializer currently emits JSON-only layout records. Run
    // them through the shared persistence guard even during the direct-snapshot
    // migration so untrusted storage cannot smuggle secrets, result buffers,
    // DOM nodes, or runtime handles into the adapter.
    createPersistenceEnvelope(value, {
      schemaVersion: DOCKYARD_LAYOUT_SCHEMA_VERSION,
      scope: 'user',
      identity: identityFor('layout-validation'),
    });
    return true;
  } catch {
    return false;
  }
}

function isDockyardPayload(value: unknown): value is DockyardLayoutPayload {
  return isRecord(value)
    && value.format === DOCKYARD_PERSISTENCE_FORMAT
    && value.dockyardVersion === DOCKYARD_UPSTREAM_VERSION
    && value.dockyardCommit === DOCKYARD_UPSTREAM_COMMIT
    && isDockyardSnapshot(value.snapshot);
}

function identityFor(userId: string): UiIdentity {
  return { productId: 'web', userId, workspaceId: `web:${userId}` };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

/**
 * Turns Dockyard's serializer output into the only layout shape accepted by
 * browser storage. Content is represented solely by stable ContentIds in the
 * Dockyard snapshot; DOM nodes and React state never cross this boundary.
 */
export function parseDockyardLayout(value: unknown): LayoutSnapshot | undefined {
  if (typeof value === 'string') {
    try {
      return parseDockyardLayout(parseJson(value));
    } catch {
      return undefined;
    }
  }
  if (isDockyardPayload(value)) return value.snapshot;
  // This is a read-only migration path for the upstream serializer output.
  // New writes always use the user-scoped persistence envelope below.
  if (isDockyardSnapshot(value)) return value;
  return undefined;
}

export function saveDockyardLayout(storage: WorkspaceStorage, snapshot: LayoutSnapshot): void {
  const payload: DockyardLayoutPayload = {
    format: DOCKYARD_PERSISTENCE_FORMAT,
    dockyardVersion: DOCKYARD_UPSTREAM_VERSION,
    dockyardCommit: DOCKYARD_UPSTREAM_COMMIT,
    snapshot,
  };
  const envelope = createPersistenceEnvelope(payload, {
    schemaVersion: DOCKYARD_LAYOUT_SCHEMA_VERSION,
    scope: 'user',
    identity: identityFor(storage.userId),
  });
  storage.set(DOCKYARD_LAYOUT_STORAGE_KEY, encodePersistenceEnvelope(envelope));
}

/**
 * Corrupt, foreign, or future layout data is intentionally treated as a
 * missing layout. The caller can then keep the in-memory safe default and
 * overwrite the bad value after the next user layout change.
 */
export function loadDockyardLayout(storage: WorkspaceStorage): LayoutSnapshot | undefined {
  const raw = storage.get(DOCKYARD_LAYOUT_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const decoded = decodePersistenceEnvelope<DockyardLayoutPayload>(raw, {
      schemaVersion: DOCKYARD_LAYOUT_SCHEMA_VERSION,
      scope: 'user',
      identity: identityFor(storage.userId),
      validatePayload: isDockyardPayload,
    });
    if (decoded) return decoded.payload.snapshot;
  } catch {
    // A direct upstream snapshot is not an envelope, so the shared decoder
    // rejects it before returning. Continue to the read-only migration path;
    // malformed or foreign envelopes still fail the structural check below.
  }
  // Accept a one-time direct Dockyard snapshot written by an earlier R10
  // build. It is re-enveloped on the next layout event.
  return parseDockyardLayout(raw);
}

export function resetDockyardLayout(storage: WorkspaceStorage): void {
  storage.remove(DOCKYARD_LAYOUT_STORAGE_KEY);
}
