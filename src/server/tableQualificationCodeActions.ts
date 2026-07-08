import type { Range } from "vscode-languageserver/node";
import { CodeAction, CodeActionKind } from "vscode-languageserver/node";
import type { Diagnostic } from "vscode-languageserver/node";
import {
  collectQualificationActionProposals,
  parseTableReferenceText,
  resolveQualificationPreferredIndex,
} from "../core/tableQualificationActions";
import type { QualificationProposal } from "../core/tableQualificationResolver";
import type { MetadataBridge } from "./metadataBridge";

export function getDiagnosticSuggestedFix(diagnostic: unknown): string | undefined {
  const data = (diagnostic as Record<string, unknown>).data as
    | { suggestedFix?: unknown }
    | undefined;
  return typeof data?.suggestedFix === "string" && data.suggestedFix.trim()
    ? data.suggestedFix.trim()
    : undefined;
}

export async function buildTableQualificationCodeActions(
  documentUri: string,
  diagnostic: Diagnostic,
  range: Range,
  rangeText: string,
  metadataBridge: MetadataBridge | undefined,
  preferredFirst: boolean,
): Promise<CodeAction[]> {
  const suggestedFix = getDiagnosticSuggestedFix(diagnostic);
  const parsed = parseTableReferenceText(rangeText);

  let resolverProposals: QualificationProposal[] = [];
  if (parsed && metadataBridge) {
    resolverProposals = await metadataBridge.qualifyTable(documentUri, {
      database: parsed.database,
      schema: parsed.schema,
      name: parsed.name,
    });
  }

  const actionProposals = collectQualificationActionProposals(
    suggestedFix,
    resolverProposals,
  );
  const preferredIndex = resolveQualificationPreferredIndex(
    actionProposals,
    preferredFirst,
  );

  return actionProposals.map((proposal, index) => ({
    title: `Qualify as ${proposal.qualifiedText}`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: index === preferredIndex,
    edit: {
      changes: {
        [documentUri]: [{ range, newText: proposal.qualifiedText }],
      },
    },
  } satisfies CodeAction));
}
