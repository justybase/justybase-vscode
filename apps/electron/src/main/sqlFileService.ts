import path from 'node:path';
import {
  HARD_SQL_FILE_MAX_BYTES,
  MAX_SQL_FILE_PATH_LENGTH,
  SOFT_SQL_FILE_WARN_BYTES,
  SQL_FILE_EXTENSION,
} from '@justybase/contracts';
import type { ElectronSqlFile, ElectronSqlSaveResult } from '@justybase/contracts';

export interface SqlFileOpenDialog {
  showOpenDialog(
    owner: unknown,
    options: {
      readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
      readonly properties: readonly string[];
    },
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

export interface SqlFileSaveDialog {
  showSaveDialog(
    owner: unknown,
    options: {
      readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
      readonly defaultPath?: string;
    },
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
}

export interface SqlFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, content: string, encoding: 'utf8'): Promise<void>;
  statSize(filePath: string): Promise<number>;
  byteLength(content: string): number;
}

export interface SqlFileServiceOptions {
  readonly dialog: SqlFileOpenDialog & SqlFileSaveDialog;
  readonly owner: () => unknown;
  readonly fs: SqlFileSystem;
}

function sqlFilters(): readonly { readonly name: string; readonly extensions: readonly string[] }[] {
  return [{ name: 'SQL', extensions: [SQL_FILE_EXTENSION] }];
}

function fileNameFor(filePath: string): string {
  const base = path.basename(filePath);
  return base.length > 0 ? base : filePath;
}

function ensureSqlExtension(filePath: string): string {
  if (filePath.toLowerCase().endsWith(`.${SQL_FILE_EXTENSION}`)) return filePath;
  return `${filePath}.${SQL_FILE_EXTENSION}`;
}

function failSafeMessage(message: string): Error {
  return new Error(message);
}

function validateReadablePath(filePath: string): string {
  const normalized = path.normalize(filePath);
  if (!path.isAbsolute(normalized)) throw failSafeMessage('SQL file path must be absolute.');
  if (normalized.length === 0 || normalized.length > MAX_SQL_FILE_PATH_LENGTH) {
    throw failSafeMessage('SQL file path has an unsupported length.');
  }
  if (normalized.includes('\0')) throw failSafeMessage('SQL file path is invalid.');
  if (!normalized.toLowerCase().endsWith(`.${SQL_FILE_EXTENSION}`)) {
    throw failSafeMessage('Only .sql files are supported.');
  }
  return normalized;
}

/** Main-process SQL file access. Dialog-gated paths are the only writable authorization. */
export function createSqlFileService(options: SqlFileServiceOptions): {
  readonly openSqlFile: () => Promise<ElectronSqlFile | null>;
  readonly saveSqlFile: (filePath: string, content: string) => Promise<ElectronSqlSaveResult>;
  readonly saveSqlFileAs: (suggestedName: string | undefined, content: string) => Promise<ElectronSqlSaveResult | null>;
} {
  const granted = new Set<string>();

  async function readSqlFile(normalizedPath: string): Promise<ElectronSqlFile> {
    let sizeBytes: number;
    try {
      sizeBytes = await options.fs.statSize(normalizedPath);
    } catch {
      throw failSafeMessage(`Could not read SQL file: ${fileNameFor(normalizedPath)}`);
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > HARD_SQL_FILE_MAX_BYTES) {
      throw failSafeMessage(
        `SQL file “${fileNameFor(normalizedPath)}” is too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). The limit is 25 MB.`,
      );
    }
    let content: string;
    try {
      content = await options.fs.readFile(normalizedPath, 'utf8');
    } catch {
      throw failSafeMessage(`Could not read SQL file: ${fileNameFor(normalizedPath)}`);
    }
    const payloadBytes = options.fs.byteLength(content);
    if (payloadBytes > HARD_SQL_FILE_MAX_BYTES) {
      throw failSafeMessage(`SQL file “${fileNameFor(normalizedPath)}” is too large. The limit is 25 MB.`);
    }
    granted.add(normalizedPath);
    return {
      filePath: normalizedPath,
      fileName: fileNameFor(normalizedPath),
      content,
      sizeBytes,
      oversize: sizeBytes > SOFT_SQL_FILE_WARN_BYTES || payloadBytes > SOFT_SQL_FILE_WARN_BYTES,
    };
  }

  async function writeSqlFile(normalizedPath: string, content: string): Promise<ElectronSqlSaveResult> {
    const payloadBytes = options.fs.byteLength(content);
    if (payloadBytes > HARD_SQL_FILE_MAX_BYTES) {
      throw failSafeMessage('SQL document is too large to save. The limit is 25 MB.');
    }
    try {
      await options.fs.writeFile(normalizedPath, content, 'utf8');
    } catch {
      throw failSafeMessage(`Could not save SQL file: ${fileNameFor(normalizedPath)}`);
    }
    granted.add(normalizedPath);
    let sizeBytes: number;
    try {
      sizeBytes = await options.fs.statSize(normalizedPath);
    } catch {
      sizeBytes = payloadBytes;
    }
    return { filePath: normalizedPath, fileName: fileNameFor(normalizedPath), sizeBytes };
  }

  return {
    openSqlFile: async () => {
      const owner = options.owner();
      const selection = await options.dialog.showOpenDialog(owner, {
        filters: sqlFilters(),
        properties: ['openFile'],
      });
      const selected = selection.filePaths[0];
      if (selection.canceled || selected === undefined) return null;
      return readSqlFile(validateReadablePath(selected));
    },
    saveSqlFile: async (filePath, content) => {
      if (typeof content !== 'string' || content.length > HARD_SQL_FILE_MAX_BYTES) {
        throw failSafeMessage('SQL document is too large to save. The limit is 25 MB.');
      }
      const normalized = validateReadablePath(filePath);
      if (!granted.has(normalized)) {
        throw failSafeMessage('Choose a save location first (Save As).');
      }
      return writeSqlFile(normalized, content);
    },
    saveSqlFileAs: async (suggestedName, content) => {
      if (typeof content !== 'string' || content.length > HARD_SQL_FILE_MAX_BYTES) {
        throw failSafeMessage('SQL document is too large to save. The limit is 25 MB.');
      }
      const owner = options.owner();
      const defaultName = typeof suggestedName === 'string' && suggestedName.trim().length > 0
        ? suggestedName.trim().slice(0, 128)
        : 'query.sql';
      const selection = await options.dialog.showSaveDialog(owner, {
        filters: sqlFilters(),
        defaultPath: defaultName.toLowerCase().endsWith('.sql') ? defaultName : `${defaultName}.sql`,
      });
      if (selection.canceled || selection.filePath === undefined || selection.filePath.length === 0) return null;
      const normalized = validateReadablePath(ensureSqlExtension(selection.filePath));
      return writeSqlFile(normalized, content);
    },
  };
}
