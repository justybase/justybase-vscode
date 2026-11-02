import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseJoinKnowledgeState,
  type JoinKnowledgeState,
} from "@justybase/sql-core/joinKnowledge";
import type {
  JoinKnowledgePersistence,
} from "./joinKnowledgeService";

const RELATION_FILE = "overrides.json";
const OBJECT_FILE = "object-overrides.json";

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    // Missing or corrupt files both degrade to an empty decision set. The
    // store validates every record again, so a partial file cannot inject a
    // malformed decision into ranking.
    return undefined;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

/**
 * Workspace-scoped append-only JSON storage.
 *
 * The files contain identifiers, counters and timestamps only: no SQL text,
 * literals, hosts, connection names, history or salts are ever written.
 */
export class FileJoinKnowledgePersistence implements JoinKnowledgePersistence {
  constructor(private readonly directory: string) {}

  async load(): Promise<JoinKnowledgeState> {
    const [relationState, objectState] = await Promise.all([
      readJson(path.join(this.directory, RELATION_FILE)),
      readJson(path.join(this.directory, OBJECT_FILE)),
    ]);
    const relations = parseJoinKnowledgeState(relationState);
    const objects = parseJoinKnowledgeState(objectState);
    const executedEvents = relations.executedEvents ?? objects.executedEvents;
    return {
      version: 1,
      relationOverrides: relations.relationOverrides,
      relationScoreOverrides: relations.relationScoreOverrides,
      relationEvidence: relations.relationEvidence,
      objectOverrides: objects.objectOverrides,
      objectEvidence: objects.objectEvidence,
      ...(executedEvents && executedEvents.length > 0 ? { executedEvents } : {}),
      ...(relations.executedTruncated === true || objects.executedTruncated === true
        ? { executedTruncated: true }
        : {}),
      ...(relations.savedAt || objects.savedAt
        ? { savedAt: relations.savedAt ?? objects.savedAt }
        : {}),
    };
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    await Promise.all([
      writeJsonAtomic(path.join(this.directory, RELATION_FILE), {
        version: 1,
        relationOverrides: state.relationOverrides,
        relationScoreOverrides: state.relationScoreOverrides,
        relationEvidence: state.relationEvidence,
        ...(state.executedEvents && state.executedEvents.length > 0
          ? { executedEvents: state.executedEvents }
          : {}),
        ...(state.executedTruncated ? { executedTruncated: true } : {}),
        ...(state.savedAt ? { savedAt: state.savedAt } : {}),
      }),
      writeJsonAtomic(path.join(this.directory, OBJECT_FILE), {
        version: 1,
        objectOverrides: state.objectOverrides,
        objectEvidence: state.objectEvidence,
        ...(state.savedAt ? { savedAt: state.savedAt } : {}),
      }),
    ]);
  }
}
