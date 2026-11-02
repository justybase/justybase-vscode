import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseKind } from "../contracts/database";
import {
  parseWorkspaceIndexState,
  type WorkspaceIndexPersistedState,
} from "./workspaceIndexEngine";

const INDEX_FILE = "workspace-index.json";

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  // Checkpoints from file-watcher events can land in the same millisecond, so
  // the temporary name needs a random suffix; sharing it makes one rename fail
  // and silently drops the delta that would publish the file's evidence.
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
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
