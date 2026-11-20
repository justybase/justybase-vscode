/**
 * Backward-compatible re-export of the shared planner-only EXPLAIN gate.
 *
 * The implementation lives in `src/core/assistant/sqlAccess.ts` and is shared
 * with the MCP server so both surfaces apply exactly the same rules.
 */
export { buildSafeExplainSql } from '../../core/assistant/sqlAccess';
