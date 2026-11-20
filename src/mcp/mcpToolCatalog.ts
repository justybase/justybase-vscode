/**
 * Static catalog of MCP server tools.
 *
 * The single source of truth is the assistant tool catalog; this module only
 * exposes the MCP-facing projection plus the server identity used by the
 * transport and the Settings view.
 */
import { ASSISTANT_TOOL_CATALOG, type ToolTier } from '../core/assistant/toolCatalog';

export interface McpToolCatalogEntry {
    name: string;
    title: string;
    description: string;
    tier: ToolTier;
    supportsDestructiveStatements?: boolean;
}

export const MCP_TOOL_CATALOG: readonly McpToolCatalogEntry[] = ASSISTANT_TOOL_CATALOG
    .filter(tool => tool.surfaces.includes('mcp') || tool.surfaces.includes('mcpExternal'))
    .map(tool => ({
        name: tool.id,
        title: tool.title,
        description: tool.description,
        tier: tool.tier,
        supportsDestructiveStatements: tool.supportsDestructiveStatements
    }));

export const MCP_SERVER_NAME = 'Netezza MCP Server';
export const MCP_SERVER_ID = 'netezza-schema';
export const MCP_SERVER_VERSION = '2.0.0';
