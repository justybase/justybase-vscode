import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseKind } from "../contracts/database";
import {
  parseWorkspaceIndexState,
  type WorkspaceIndexPersistedState,
} from "./workspaceIndexEngine";

const INDEX_FILE = "workspace-index.json";

/**
 * Windows can transiently reject `rename` while another process (antivirus,
 * indexer) holds the destination. Retrying briefly avoids dropping a checkpoint
 * for a problem that resolves on its own.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [25, 50, 100] as const;

function isTransientRenameError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && TRANSIENT_RENAME_CODES.has(String((error as { code?: unknown }).code ?? ""));
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error: unknown) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(error)) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function writeJsonAtomicNow(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  // Checkpoints from file-watcher events can land in the same millisecond, so
  // the temporary name needs a random suffix; sharing it makes one rename fail
  // and silently drops the delta that would publish the file's evidence.
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await renameWithRetry(temporaryPath, filePath);
  } catch (error: unknown) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Serialize checkpoints for one file. Two concurrent saves used to race two
 * renames onto the same destination; on Windows the loser can fail with EPERM
 * even when both temporary names are unique.
 */
const writeQueues = new Map<string, Promise<void>>();

function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeJsonAtomicNow(filePath, value));
  writeQueues.set(filePath, next);
  const clearQueue = (): void => {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  };
  void next.then(clearQueue, clearQueue);
  return next;
}

/**
 * Workspace-scoped per-file index persistence.
 *
 * The file contains relative paths, hashes, identifiers and counters only.
 * SQL text, literals, credentials and connection names are never written.
 */
export class FileWorkspaceIndexPersistence {
  constructor(private readonly directory: string) {}

  async load(
    databaseKind?: DatabaseKind,
  ): Promise<WorkspaceIndexPersistedState> {
    try {
      const text = await fs.readFile(path.join(this.directory, INDEX_FILE), "utf8");
      return parseWorkspaceIndexState(JSON.parse(text), databaseKind);
    } catch {
      return parseWorkspaceIndexState(undefined, databaseKind);
    }
  }

  async save(state: WorkspaceIndexPersistedState): Promise<void> {
    await writeJsonAtomic(path.join(this.directory, INDEX_FILE), state);
  }
}
