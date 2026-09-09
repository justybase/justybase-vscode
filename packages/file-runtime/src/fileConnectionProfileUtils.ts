import * as path from 'node:path';
import type { ConnectionDetails } from '@justybase/contracts';

export const FILE_WORKSPACE_OPTION = 'fileWorkspace';
export const FILE_WORKSPACE_VERSION = 1;

export interface FileWorkspaceConfig {
  version: typeof FILE_WORKSPACE_VERSION;
  files: string[];
}

export function normalizeFilePath(filePath: string): string {
  const trimmed = filePath.trim();
  return trimmed.length > 0 ? path.resolve(trimmed).split(path.sep).join('/') : '';
}

export function fileSourceConnectionBaseName(filePath: string): string {
  return `File SQL: ${path.basename(normalizeFilePath(filePath))}`;
}

export function parseFileWorkspace(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<FileWorkspaceConfig>;
    if (parsed.version !== FILE_WORKSPACE_VERSION || !Array.isArray(parsed.files)) {
      return undefined;
    }
    const files = parsed.files.filter((filePath): filePath is string => typeof filePath === 'string');
    return Array.from(new Set(files.map(normalizeFilePath).filter(filePath => filePath.length > 0)));
  } catch {
    return undefined;
  }
}

export function resolveFileSourceConnectionName(
  connections: readonly Pick<ConnectionDetails, 'name' | 'database' | 'dbType' | 'options'>[],
  filePath: string,
  dbType: 'file' | 'access',
): string {
  const preferred = fileSourceConnectionBaseName(filePath);
  const normalizedPath = normalizeFilePath(filePath);
  const sameSource = (connection: Pick<ConnectionDetails, 'name' | 'database' | 'dbType' | 'options'>): boolean =>
    connection.name === preferred
    && String(connection.dbType ?? '').toLowerCase() === dbType
    && normalizeFilePath(connection.database) === normalizedPath
    && !parseFileWorkspace(connection.options?.[FILE_WORKSPACE_OPTION]);

  const preferredConnection = connections.find(connection => connection.name === preferred);
  if (!preferredConnection || sameSource(preferredConnection)) {
    return preferred;
  }

  let suffix = 2;
  let candidate = `${preferred} (${suffix})`;
  const names = new Set(connections.map(connection => connection.name));
  while (names.has(candidate)) {
    suffix += 1;
    candidate = `${preferred} (${suffix})`;
  }
  return candidate;
}
