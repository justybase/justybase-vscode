/**
 * The only tools an AI request may register, advertise, or invoke.
 * Keep this list deliberately explicit: adding a tool requires a policy review.
 */
export const ALLOWED_AI_TOOL_NAMES = [
    'netezza_get_sql_schema',
    'netezza_get_columns',
    'netezza_get_tables',
    'netezza_get_databases',
    'netezza_get_schemas',
    'netezza_get_views',
    'netezza_get_procedures',
    'netezza_get_ddl',
    'netezza_get_table_stats',
    'netezza_search_schema',
    'netezza_get_dependencies',
    'netezza_get_external_tables',
    'netezza_find_table_locations',
    'netezza_get_comments',
    'netezza_get_favorites',
    'netezza_validate_sql',
    'netezza_validate_sql_on_database',
    'netezza_get_sql_diagnostics',
    'netezza_inspect_import_file',
    'netezza_propose_import_mapping',
    'netezza_explain_plan',
    'netezza_get_tuning_advice'
] as const;

const allowedAiToolNames = new Set<string>(ALLOWED_AI_TOOL_NAMES);

export function isAiToolAllowed(toolName: string): boolean {
    return allowedAiToolNames.has(toolName);
}
