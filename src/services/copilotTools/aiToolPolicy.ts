/**
 * The only tools an AI request may register, advertise, or invoke.
 * Keep this list deliberately explicit: adding a tool requires a policy review.
 */
export const ALLOWED_AI_TOOL_NAMES = [
    'netezza_get_context',
    'netezza_search_catalog',
    'netezza_get_object_details',
    'netezza_explain_sql',
    'netezza_validate_sql',
    'netezza_validate_sql_on_database',
    'netezza_repair_procedure',
    'netezza_inspect_import_file',
    'netezza_propose_import_mapping',
    'netezza_get_dialect_reference'
] as const;

const allowedAiToolNames = new Set<string>(ALLOWED_AI_TOOL_NAMES);

export function isAiToolAllowed(toolName: string): boolean {
    return allowedAiToolNames.has(toolName);
}
