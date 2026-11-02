import * as vscode from "vscode";
import type { JoinGhostMode, JoinGhostSuggestion } from "../lsp/protocol";
import { joinGhostSlotOf, type JoinGhostStats } from "../knowledge/joinGhostStats";

export const ACCEPT_JOIN_GHOST_COMMAND = "netezza.acceptJoinGhostSuggestion";

export type JoinGhostRequest = (
  documentUri: string,
  position: { line: number; character: number },
  mode: JoinGhostMode,
  groupBy: boolean,
) => Promise<JoinGhostSuggestion | null>;

export interface GhostTextSettings {
  /** `justybase.sql.joinGhostText`. */
  mode: JoinGhostMode;
  /** `justybase.sql.groupByGhostText`. */
  groupBy: boolean;
}

/**
 * Shows a confident JOIN target or ON condition, or the `GROUP BY` list, as
 * inline ghost text (Tab accepts). The language server decides where a ghost applies and whether the
 * top suggestion is confident; accepting it is remembered like a selected
 * JOIN completion. Shown and accepted ghosts are counted per position.
 */
export class JoinGhostTextProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly request: JoinGhostRequest,
    private readonly getSettings: () => GhostTextSettings,
    private readonly stats?: JoinGhostStats,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const { mode, groupBy } = this.getSettings();
    // With the suggest widget open its own preview shows the selected item.
    if ((mode === "off" && !groupBy) || context.selectedCompletionInfo) {
      return undefined;
    }
    const ghost = await this.request(
      document.uri.toString(),
      { line: position.line, character: position.character },
      mode,
      groupBy,
    );
    if (!ghost || token.isCancellationRequested) {
      return undefined;
    }
    const slot = joinGhostSlotOf(ghost);
    void this.stats?.recordShown(
      slot,
      `${document.uri.toString()}#${position.line}:${position.character}#${ghost.insertText}`,
    );
    return [new vscode.InlineCompletionItem(
      ghost.insertText,
      new vscode.Range(position, position),
      {
        title: "Remember accepted JOIN suggestion",
        command: ACCEPT_JOIN_GHOST_COMMAND,
        arguments: [ghost.relation, slot],
      },
    )];
  }
}

export function readGhostTextSettings(): GhostTextSettings {
  const configuration = vscode.workspace.getConfiguration("justybase.sql");
  const value = configuration.get<string>("joinGhostText", "afterJoin");
  return {
    mode: value === "off" || value === "afterJoinAndNewLine" ? value : "afterJoin",
    groupBy: configuration.get<boolean>("groupByGhostText", true) !== false,
  };
}
