import type { QualificationProposal } from "./tableQualificationResolver";

export const MAX_QUALIFICATION_PROPOSALS = 6;

export interface QualificationActionProposal {
  qualifiedText: string;
  isPreferred?: boolean;
}

export function parseTableReferenceText(
  rawText: string,
): { database?: string; schema?: string; name: string } | undefined {
  const text = rawText.trim().replace(/[;,)]*$/g, "");
  if (!text || text.startsWith("(")) {
    return undefined;
  }

  if (text.includes("..")) {
    const [database, name, extra] = text.split("..");
    if (extra !== undefined || !database || !name) {
      return undefined;
    }
    return { database, name };
  }

  const parts = text.split(".").filter(Boolean);
  if (parts.length === 1) {
    return { name: parts[0] };
  }
  if (parts.length === 2) {
    return { schema: parts[0], name: parts[1] };
  }
  if (parts.length >= 3) {
    return { database: parts[0], schema: parts[1], name: parts[2] };
  }
  return undefined;
}

export function collectQualificationActionProposals(
  suggestedFix: string | undefined,
  proposals: readonly QualificationProposal[],
  maxProposals = MAX_QUALIFICATION_PROPOSALS,
): QualificationActionProposal[] {
  const merged = new Map<string, QualificationActionProposal>();

  if (suggestedFix?.trim()) {
    merged.set(suggestedFix.toUpperCase(), {
      qualifiedText: suggestedFix.trim(),
      isPreferred: true,
    });
  }

  for (const proposal of proposals) {
    merged.set(proposal.qualifiedText.toUpperCase(), {
      qualifiedText: proposal.qualifiedText,
      isPreferred: proposal.isPreferred ?? merged.get(proposal.qualifiedText.toUpperCase())?.isPreferred,
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => Number(!!right.isPreferred) - Number(!!left.isPreferred))
    .slice(0, maxProposals);
}

/** At most one proposal is marked preferred for quick-fix UI. */
export function resolveQualificationPreferredIndex(
  proposals: readonly QualificationActionProposal[],
  preferredFirst: boolean,
): number {
  if (proposals.length === 0) {
    return -1;
  }
  const preferredByFlag = proposals.findIndex((proposal) => proposal.isPreferred);
  if (preferredByFlag >= 0) {
    return preferredByFlag;
  }
  return preferredFirst ? 0 : -1;
}
