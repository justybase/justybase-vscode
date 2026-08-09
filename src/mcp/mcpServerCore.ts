import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CatalogIntrospection } from '../core/catalogIntrospection';
import { createMcpToolDefinitions } from './mcpToolRegistry';
import { MCP_SERVER_ID } from './mcpToolCatalog';

/**
 * Builds the MCP `McpServer` exposing the read-only Netezza tool set.
 *
 * All tools are registered with the `readOnlyHint` annotation so MCP clients
 * (including VS Code Copilot Chat) do not ask for confirmation on every call.
 */
export function createNetezzaMcpServer(
    introspection: CatalogIntrospection,
    serverVersion = '1.0.0'
): McpServer {
    const tools = createMcpToolDefinitions(introspection);
    const server = new McpServer(
        { name: MCP_SERVER_ID, version: serverVersion },
        { capabilities: { tools: {} } }
    );

    for (const tool of tools) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: jsonSchemaToZod(tool.inputSchema),
                annotations: { readOnlyHint: true }
            },
            async (args) => {
                const result = await tool.handler(args as Record<string, unknown>);
                return {
                    content: [{ type: 'text', text: result.text }],
                    isError: result.isError === true
                };
            }
        );
    }

    return server;
}

/**
 * Translates the JSON Schema used by the tool registry into a zod schema.
 * Supports the subset used by the MCP tools: object with string/boolean/
 * number/array-of-string properties, required/optional fields, strict mode
 * and minItems.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((key): key is string => typeof key === 'string')
            : [],
    );
    const shape: Record<string, z.ZodType> = {};
    for (const [key, propertySchema] of Object.entries(properties)) {
        const property = jsonPropertyToZod(propertySchema);
        shape[key] = required.has(key) ? property : property.optional();
    }

    let result = z.object(shape);
    if (schema.additionalProperties === false) {
        result = result.strict();
    }
    return result;
}

function jsonPropertyToZod(property: Record<string, unknown>): z.ZodType {
    switch (property.type) {
        case 'string':
            return z.string();
        case 'boolean':
            return z.boolean();
        case 'number':
            return z.number();
        case 'array': {
            const items = jsonPropertyToZod((property.items as Record<string, unknown> | undefined) ?? { type: 'string' });
            let array = z.array(items);
            if (typeof property.minItems === 'number') {
                array = array.min(property.minItems);
            }
            return array;
        }
        default:
            return z.any();
    }
}
