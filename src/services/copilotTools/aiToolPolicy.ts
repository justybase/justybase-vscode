import { ASSISTANT_TOOL_CATALOG, copilotToolName } from '../../core/assistant/toolCatalog';
import { allowedToolIds, type AiToolAccessConfig } from '../../core/assistant/toolPolicy';

/**
 * Tools that exist on the Copilot surface, regardless of the access profile.
 * The effective registration list is resolved from `justybase.ai.tools`.
 */
export const ALLOWED_AI_TOOL_NAMES: readonly string[] = ASSISTANT_TOOL_CATALOG
    .filter(tool => tool.surfaces.includes('copilot'))
    .map(tool => copilotToolName(tool.id));

/** Canonical ids enabled for the Copilot surface by the current access policy. */
export function resolveCopilotToolIds(config: AiToolAccessConfig): string[] {
    return allowedToolIds('copilot', config);
}

export function isAiToolAllowed(toolName: string): boolean {
    return ALLOWED_AI_TOOL_NAMES.includes(toolName);
}
