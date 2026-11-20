import { getExtensionConfiguration } from '../compatibility/configuration';
import { normalizeAiToolAccess, type AiToolAccessConfig } from '../core/assistant/toolPolicy';

/** Reads and normalizes the single `justybase.ai.tools` access setting. */
export function getAiToolAccessConfig(): AiToolAccessConfig {
    return normalizeAiToolAccess(getExtensionConfiguration().get('ai.tools'));
}
