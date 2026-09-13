import type { UiDocumentState } from '@justybase/ui-core';
import {
  createPersistenceEnvelope,
  decodePersistenceEnvelope,
  encodePersistenceEnvelope,
  type JsonValue,
} from '@justybase/ui-core';
import type { DatabaseKind, UiIdentity } from '@justybase/contracts';
import type { WorkspaceStorage } from './workspacePersistence';
import { readLegacyWorkspaceValue } from './workspacePersistence';

/** Versioned, user-scoped document-only workspace storage for Shared Web. */
export const SHARED_WORKSPACE_STORAGE_KEY = 'shared_workspace_v2';
export const SHARED_WORKSPACE_SCHEMA_VERSION = 2;

interface PersistedSharedDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly dirty: boolean;
  readonly uri?: string;
  readonly connectionId?: string;
  readonly database?: string;
  readonly schema?: string;
  readonly databaseKind?: string;
}

interface SharedWorkspacePayload {
  readonly documents: readonly PersistedSharedDocument[];
  readonly documentOrder: readonly string[];
  readonly activeDocumentId: string;
  readonly selectedConnectionId?: string;
}

export interface RestoredSharedWorkspace {
  readonly documents: readonly UiDocumentState[];
  readonly documentOrder: readonly string[];
  readonly activeDocumentId: string;
  readonly selectedConnectionId?: string;
  readonly migratedFromLegacy: boolean;
}

function workspaceIdentity(userId: string): UiIdentity {
  return { productId: 'web', userId, workspaceId: `web:${userId}` };
}

export function sharedDocumentSourceId(userId: string, documentId: string): string {
  return `web:${userId}:document:${documentId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function documentFromPersisted(userId: string, value: unknown, fallbackTitle: string): UiDocumentState | undefined {
  if (!isRecord(value) || !nonEmptyString(value.id)) return undefined;
  const content = typeof value.content === 'string' ? value.content : typeof value.sql === 'string' ? value.sql : undefined;
  if (content === undefined) return undefined;
  const id = value.id;
  return {
    id,
    sourceId: sharedDocumentSourceId(userId, id),
    title: nonEmptyString(value.title) ? value.title : fallbackTitle,
    content,
    dirty: value.dirty === true,
    ...(optionalString(value.uri) === undefined ? {} : { uri: optionalString(value.uri) }),
    ...(optionalString(value.connectionId) === undefined ? {} : { connectionId: optionalString(value.connectionId) }),
    ...(optionalString(value.database) === undefined ? {} : { database: optionalString(value.database) }),
    ...(optionalString(value.schema) === undefined ? {} : { schema: optionalString(value.schema) }),
    ...(optionalString(value.databaseKind) === undefined ? {} : { databaseKind: optionalString(value.databaseKind) as DatabaseKind }),
  };
}

function defaultWorkspace(userId: string): RestoredSharedWorkspace {
  const document: UiDocumentState = {
    id: 'shared-scratch',
    sourceId: sharedDocumentSourceId(userId, 'shared-scratch'),
    title: 'scratch.sql',
    content: 'SELECT 1;',
    dirty: false,
    databaseKind: 'netezza',
  };
  return { documents: [document], documentOrder: [document.id], activeDocumentId: document.id, migratedFromLegacy: false };
}

function parseLegacyTabs(userId: string, value: unknown): RestoredSharedWorkspace | undefined {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown; } catch { return undefined; }
  }
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return undefined;
  const documents: UiDocumentState[] = [];
  const ids = new Set<string>();
  for (const [index, tab] of raw.tabs.entries()) {
    const document = documentFromPersisted(userId, tab, `Query ${index + 1}`);
    if (!document || ids.has(document.id)) continue;
    ids.add(document.id);
    documents.push(document);
  }
  if (documents.length === 0) return undefined;
  const documentOrder = documents.map(document => document.id);
  const requestedActive = optionalString(raw.activeTabId);
  const activeDocumentId = requestedActive && ids.has(requestedActive) ? requestedActive : documentOrder[0]!;
  return {
    documents,
    documentOrder,
    activeDocumentId,
    ...(optionalString(raw.selectedConnectionId) === undefined ? {} : { selectedConnectionId: optionalString(raw.selectedConnectionId) }),
    migratedFromLegacy: true,
  };
}

function validatePayload(value: unknown): value is SharedWorkspacePayload {
  if (!isRecord(value) || !Array.isArray(value.documents) || !Array.isArray(value.documentOrder) || typeof value.activeDocumentId !== 'string') return false;
  if (!value.documents.every(item => isRecord(item) && nonEmptyString(item.id) && typeof item.content === 'string' && typeof item.dirty === 'boolean')) return false;
  if (!value.documentOrder.every(item => typeof item === 'string')) return false;
  return value.selectedConnectionId === undefined || typeof value.selectedConnectionId === 'string';
}

function currentEnvelope(storage: WorkspaceStorage, userId: string): RestoredSharedWorkspace | undefined {
  const identity = workspaceIdentity(userId);
  try {
    const envelope = decodePersistenceEnvelope<SharedWorkspacePayload>(storage.get(SHARED_WORKSPACE_STORAGE_KEY), {
      schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION,
      scope: 'user',
      identity,
      migrations: {
        1: value => value,
      },
      validatePayload,
    });
    if (!envelope) return undefined;
    const documents: UiDocumentState[] = [];
    const seen = new Set<string>();
    for (const [index, value] of envelope.payload.documents.entries()) {
      const document = documentFromPersisted(userId, value, `Query ${index + 1}`);
      if (!document || seen.has(document.id)) continue;
      seen.add(document.id);
      documents.push(document);
    }
    if (documents.length === 0) return undefined;
    const documentOrder = envelope.payload.documentOrder.filter(id => seen.has(id));
    for (const document of documents) if (!documentOrder.includes(document.id)) documentOrder.push(document.id);
    const requestedActive = envelope.payload.activeDocumentId;
    return {
      documents,
      documentOrder,
      activeDocumentId: seen.has(requestedActive) ? requestedActive : documentOrder[0]!,
      ...(envelope.payload.selectedConnectionId === undefined ? {} : { selectedConnectionId: envelope.payload.selectedConnectionId }),
      migratedFromLegacy: false,
    };
  } catch {
    return undefined;
  }
}

/** Reads the current envelope and then the old Web `tabs` payload. */
export function restoreSharedWorkspace(storage: WorkspaceStorage, userId: string): RestoredSharedWorkspace {
  const current = currentEnvelope(storage, userId);
  if (current) return current;
  const legacy = storage.get('tabs') ?? readLegacyWorkspaceValue('jwb_tabs');
  const restored = parseLegacyTabs(userId, legacy);
  if (restored) return restored;
  return defaultWorkspace(userId);
}

function persistedDocument(document: UiDocumentState): PersistedSharedDocument {
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    dirty: document.dirty,
    ...(document.uri === undefined ? {} : { uri: document.uri }),
    ...(document.connectionId === undefined ? {} : { connectionId: document.connectionId }),
    ...(document.database === undefined ? {} : { database: document.database }),
    ...(document.schema === undefined ? {} : { schema: document.schema }),
    ...(document.databaseKind === undefined ? {} : { databaseKind: document.databaseKind }),
  };
}

/** Writes only document/context metadata; results, sockets and credentials never enter this payload. */
export function persistSharedWorkspace(
  storage: WorkspaceStorage,
  userId: string,
  workspace: Pick<RestoredSharedWorkspace, 'documents' | 'documentOrder' | 'activeDocumentId' | 'selectedConnectionId'>,
): void {
  const payload: SharedWorkspacePayload = {
    documents: workspace.documents.map(persistedDocument),
    documentOrder: [...workspace.documentOrder],
    activeDocumentId: workspace.activeDocumentId,
    ...(workspace.selectedConnectionId === undefined ? {} : { selectedConnectionId: workspace.selectedConnectionId }),
  };
  const envelope = createPersistenceEnvelope(payload as unknown as JsonValue, {
    schemaVersion: SHARED_WORKSPACE_SCHEMA_VERSION,
    scope: 'user',
    identity: workspaceIdentity(userId),
  });
  storage.set(SHARED_WORKSPACE_STORAGE_KEY, encodePersistenceEnvelope(envelope));
}
