import * as vscode from "vscode";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { JoinKnowledgeState } from "@justybase/sql-core/joinKnowledge";
import { registerJoinKnowledgePortabilityCommands } from "../../commands/joinKnowledgePortabilityCommands";
import {
  JoinKnowledgeService,
  type JoinKnowledgePersistence,
} from "../../knowledge/joinKnowledgeService";

jest.mock("vscode");

class MemoryPersistence implements JoinKnowledgePersistence {
  public saves = 0;
  public state: JoinKnowledgeState = {
    version: 1,
    relationOverrides: [],
    objectOverrides: [],
    relationEvidence: [],
    objectEvidence: [],
  };

  async load(): Promise<JoinKnowledgeState> {
    return this.state;
  }

  async save(state: JoinKnowledgeState): Promise<void> {
    this.state = state;
    this.saves += 1;
  }
}

const relation = {
  left: { database: "BAZA", schema: "ADMIN", table: "USERS" },
  right: { database: "BAZA", schema: "ADMIN", table: "ORDERS" },
  columns: [{ left: "USER_ID", right: "OWNER_ID" }],
  databaseKind: "netezza",
};

async function newService(persistence = new MemoryPersistence()): Promise<JoinKnowledgeService> {
  const service = new JoinKnowledgeService(persistence, { now: () => "2026-10-26T10:00:00.000Z" });
  await service.initialize();
  return service;
}

function handlers(service: JoinKnowledgeService): Map<string, (...args: unknown[]) => Promise<unknown>> {
  const register = vscode.commands.registerCommand as jest.Mock;
  register.mockClear();
  registerJoinKnowledgePortabilityCommands(service);
  return new Map(register.mock.calls.map((call) => [call[0] as string, call[1]]));
}

describe("JOIN knowledge import/export commands", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "join-knowledge-portability-"));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("exports to the chosen file and imports it into a clean profile", async () => {
    const source = await newService();
    await source.confirmRelation(relation);
    const file = path.join(directory, "knowledge.json");
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(vscode.Uri.file(file));
    await handlers(source).get("netezza.exportJoinKnowledge")!();
    const written = await fs.readFile(file, "utf8");
    expect(JSON.parse(written).relations).toHaveLength(1);
    expect(written).not.toContain("createdAt");

    const persistence = new MemoryPersistence();
    const target = await newService(persistence);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([vscode.Uri.file(file)]);
    (vscode.window.showInformationMessage as jest.Mock)
      .mockResolvedValueOnce("Import")
      .mockResolvedValueOnce(undefined);
    await expect(handlers(target).get("netezza.importJoinKnowledge")!())
      .resolves.toMatchObject({ added: 1 });
    expect(persistence.saves).toBe(1);
    expect(target.getSnapshot().relations).toHaveLength(1);
  });

  it("rejects an invalid file without writing", async () => {
    const file = path.join(directory, "broken.json");
    await fs.writeFile(file, JSON.stringify({ format: "justybase-sql-knowledge", version: 7 }), "utf8");
    const persistence = new MemoryPersistence();
    const target = await newService(persistence);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([vscode.Uri.file(file)]);
    await handlers(target).get("netezza.importJoinKnowledge")!();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported export version 7"),
    );
    expect(persistence.saves).toBe(0);
  });

  it("keeps the local decision when the user cancels the conflict choice", async () => {
    const source = await newService();
    await source.confirmRelation(relation);
    const file = path.join(directory, "knowledge.json");
    await fs.writeFile(file, source.exportKnowledge().text, "utf8");

    const persistence = new MemoryPersistence();
    const target = await newService(persistence);
    await target.blockRelation(relation);
    const savesBefore = persistence.saves;
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([vscode.Uri.file(file)]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);
    await handlers(target).get("netezza.importJoinKnowledge")!();
    expect(persistence.saves).toBe(savesBefore);
    expect(target.getSnapshot().relations[0].decision).toBe("blocked");
  });
});
