import * as vscode from "vscode";
import { promises as fs } from "fs";
import type { JoinKnowledgeImportItem } from "@justybase/sql-core/joinKnowledge";
import type { JoinKnowledgeService } from "../knowledge/joinKnowledgeService";

/** Above this size an import file is rejected before it is parsed. */
export const JOIN_KNOWLEDGE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

type ImportStrategyChoice = "keep-local" | "keep-import" | "per-item" | "cancel";

function describeConflict(item: JoinKnowledgeImportItem): string {
  return `${item.local ?? "local"} → ${item.imported}`;
}

async function chooseStrategy(conflicts: number, added: number): Promise<ImportStrategyChoice> {
  if (conflicts === 0) {
    const proceed = await vscode.window.showInformationMessage(
      `Import ${added} new JOIN knowledge decision(s)? Existing decisions are not changed.`,
      { modal: true },
      "Import",
    );
    return proceed === "Import" ? "keep-local" : "cancel";
  }
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Keep local decisions",
        description: "default",
        detail: `Add ${added} new decision(s); keep all ${conflicts} conflicting local decision(s).`,
        value: "keep-local" as const,
      },
      {
        label: "Prefer imported decisions",
        detail: `Add ${added} new decision(s); replace ${conflicts} conflicting local decision(s).`,
        value: "keep-import" as const,
      },
      {
        label: "Choose conflicts individually…",
        detail: "Pick which conflicting decisions come from the import.",
        value: "per-item" as const,
      },
    ],
    {
      title: "Import JOIN knowledge",
      placeHolder: `${conflicts} conflict(s) with your manual decisions`,
      ignoreFocusOut: true,
    },
  );
  return picked?.value ?? "cancel";
}

/**
 * Explicit, user-invoked JOIN knowledge export/import commands. No background
 * sync exists; nothing is written before validation, diff and a strategy.
 */
export function registerJoinKnowledgePortabilityCommands(
  service: JoinKnowledgeService,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("netezza.exportJoinKnowledge", async () => {
      const exported = service.exportKnowledge();
      const total = exported.document.relations.length
        + exported.document.scores.length
        + exported.document.objects.length;
      if (total === 0) {
        void vscode.window.showInformationMessage("There are no manual JOIN knowledge decisions to export.");
        return undefined;
      }
      const target = await vscode.window.showSaveDialog({
        title: "Export JOIN knowledge",
        saveLabel: "Export",
        filters: { "JOIN knowledge": ["json"] },
        defaultUri: vscode.workspace.workspaceFolders?.[0]
          ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "join-knowledge.json")
          : undefined,
      });
      if (!target) {
        return undefined;
      }
      await fs.writeFile(target.fsPath, exported.text, "utf8");
      void vscode.window.showInformationMessage(
        `Exported ${exported.document.relations.length} relation decision(s), `
        + `${exported.document.scores.length} score adjustment(s) and `
        + `${exported.document.objects.length} object preference(s). `
        + "Evidence, history and SQL text are not included.",
      );
      return target;
    }),

    vscode.commands.registerCommand("netezza.importJoinKnowledge", async () => {
      const [source] = await vscode.window.showOpenDialog({
        title: "Import JOIN knowledge",
        openLabel: "Preview import",
        canSelectMany: false,
        filters: { "JOIN knowledge": ["json"] },
      }) ?? [];
      if (!source) {
        return undefined;
      }
      const stat = await fs.stat(source.fsPath);
      if (stat.size > JOIN_KNOWLEDGE_IMPORT_MAX_BYTES) {
        void vscode.window.showErrorMessage("The JOIN knowledge file is too large; nothing was imported.");
        return undefined;
      }
      const preview = service.previewImport(await fs.readFile(source.fsPath, "utf8"));
      if (!preview.ok) {
        void vscode.window.showErrorMessage(`JOIN knowledge import rejected: ${preview.error} Nothing was changed.`);
        return undefined;
      }
      const { diff, document } = preview;
      if (diff.added === 0 && diff.conflicts === 0) {
        void vscode.window.showInformationMessage(
          `Nothing to import: all ${diff.unchanged} decision(s) already match.`,
        );
        return undefined;
      }
      const strategy = await chooseStrategy(diff.conflicts, diff.added);
      if (strategy === "cancel") {
        return undefined;
      }
      let takeImported: Set<string> | undefined;
      if (strategy === "per-item") {
        const conflicts = diff.items.filter((item) => item.status === "conflict");
        const picked = await vscode.window.showQuickPick(
          conflicts.map((item) => ({
            label: item.label,
            description: describeConflict(item),
            detail: item.domain,
            id: item.id,
          })),
          {
            title: "Take these decisions from the import",
            placeHolder: "Unselected conflicts keep the local decision",
            canPickMany: true,
            ignoreFocusOut: true,
          },
        );
        if (!picked) {
          return undefined;
        }
        takeImported = new Set(picked.map((item) => item.id));
      }
      const result = await service.importKnowledge(document, {
        strategy: strategy === "keep-import" ? "keep-import" : "keep-local",
        ...(takeImported ? { takeImported } : {}),
      });
      const action = await vscode.window.showInformationMessage(
        `JOIN knowledge imported: ${result.added} added, ${result.replaced} replaced, `
        + `${result.keptLocal} kept local, ${result.unchanged} unchanged.`,
        "Undo import",
      );
      if (action === "Undo import") {
        await service.undoLastImport();
      }
      return result;
    }),

    vscode.commands.registerCommand("netezza.undoJoinKnowledgeImport", async () => {
      if (!service.canUndoImport()) {
        void vscode.window.showInformationMessage("There is no JOIN knowledge import to undo in this session.");
        return false;
      }
      const undone = await service.undoLastImport();
      if (undone) {
        void vscode.window.showInformationMessage("The last JOIN knowledge import was undone.");
      }
      return undone;
    }),
  ];
}
