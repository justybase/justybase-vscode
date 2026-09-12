import type { SchemaTreeNode } from '@justybase/contracts';

export interface SchemaExplorerShortcuts {
  readonly favorites: readonly SchemaTreeNode[];
  readonly recent: readonly SchemaTreeNode[];
}

const STORAGE_PREFIX = 'justybase.electron.schema.';
const MAX_FAVORITES = 20;
const MAX_RECENT = 8;

export function schemaExplorerStorageKey(connectionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(connectionId)}`;
}

/**
 * IDs returned by the metadata API can change after a refresh. Shortcuts use
 * the catalog identity instead, so a refresh never silently breaks them.
 */
export function schemaObjectIdentity(node: SchemaTreeNode): string {
  return [
    node.kind,
    node.database ?? '',
    node.schema ?? '',
    node.objectName ?? node.label,
  ].join('\u001f');
}

function isPersistedObject(value: unknown): value is SchemaTreeNode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SchemaTreeNode>;
  return candidate.kind === 'object'
    && typeof candidate.id === 'string'
    && typeof candidate.label === 'string'
    && typeof candidate.hasChildren === 'boolean';
}

function persistableNode(node: SchemaTreeNode): SchemaTreeNode {
  return {
    id: node.id,
    kind: 'object',
    label: node.label,
    database: node.database,
    schema: node.schema,
    objectName: node.objectName,
    objectType: node.objectType,
    hasChildren: node.hasChildren,
  };
}

function getStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readSchemaExplorerShortcuts(connectionId: string): SchemaExplorerShortcuts {
  const storage = getStorage();
  if (!storage) return { favorites: [], recent: [] };
  try {
    const raw = storage.getItem(schemaExplorerStorageKey(connectionId));
    if (!raw) return { favorites: [], recent: [] };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { favorites: [], recent: [] };
    const value = parsed as { favorites?: unknown; recent?: unknown };
    return {
      favorites: Array.isArray(value.favorites) ? value.favorites.filter(isPersistedObject).map(persistableNode).slice(0, MAX_FAVORITES) : [],
      recent: Array.isArray(value.recent) ? value.recent.filter(isPersistedObject).map(persistableNode).slice(0, MAX_RECENT) : [],
    };
  } catch {
    return { favorites: [], recent: [] };
  }
}

export function writeSchemaExplorerShortcuts(connectionId: string, shortcuts: SchemaExplorerShortcuts): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(schemaExplorerStorageKey(connectionId), JSON.stringify({
      favorites: shortcuts.favorites.filter(node => node.kind === 'object').map(persistableNode).slice(0, MAX_FAVORITES),
      recent: shortcuts.recent.filter(node => node.kind === 'object').map(persistableNode).slice(0, MAX_RECENT),
    }));
  } catch {
    // A full or policy-blocked profile store must not make schema browsing fail.
  }
}

export function rememberSchemaObject(recent: readonly SchemaTreeNode[], node: SchemaTreeNode): readonly SchemaTreeNode[] {
  if (node.kind !== 'object') return recent;
  const identity = schemaObjectIdentity(node);
  return [persistableNode(node), ...recent.filter(item => schemaObjectIdentity(item) !== identity)].slice(0, MAX_RECENT);
}

export function toggleSchemaFavorite(favorites: readonly SchemaTreeNode[], node: SchemaTreeNode): readonly SchemaTreeNode[] {
  if (node.kind !== 'object') return favorites;
  const identity = schemaObjectIdentity(node);
  if (favorites.some(item => schemaObjectIdentity(item) === identity)) {
    return favorites.filter(item => schemaObjectIdentity(item) !== identity);
  }
  return [persistableNode(node), ...favorites].slice(0, MAX_FAVORITES);
}
