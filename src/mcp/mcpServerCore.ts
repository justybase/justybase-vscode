import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CatalogIntrospection } from '../core/catalogIntrospection';
import { createMcpToolDefinitions, type McpToolRuntime } from './mcpToolRegistry';
import { MCP_SERVER_ID } from './mcpToolCatalog';
import type { JsonObjectSchema } from '../core/assistant/toolCatalog';

export interface CreateNetezzaMcpServerOptions {
  readonly serverVersion?: string;
  readonly runtime?: McpToolRuntime;
  /** Effective access policy. Omit to register every tool (tests/diagnostics). */
  readonly allowedToolIds?: readonly string[];
}

/**
 * Builds the MCP `McpServer` for the Netezza tool set.
 *
 * Read tools carry the `readOnlyHint` annotation. Write tools are only part of
 * the instance when the resolved access policy includes them, and destructive
 * tools additionally carry `destructiveHint` so MCP clients ask for
 * confirmation.
 */
export function createNetezzaMcpServer(
  introspection: CatalogIntrospection,
  options: CreateNetezzaMcpServerOptions = {}
): McpServer {
  const serverVersion = options.serverVersion ?? '1.0.0';
  const runtime = options.runtime ?? { allowWrites: false, allowDestructive: false };
  const tools = createMcpToolDefinitions(introspection, runtime, options.allowedToolIds);
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
        annotations: tool.tier === 'read'
          ? { readOnlyHint: true }
          : { readOnlyHint: false, destructiveHint: tool.tier === 'destructive' }
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
 * Translates the JSON Schema used by the tool catalog into a zod schema.
 * Supports the subset used by the tools: object with string/boolean/number/
 * array properties, required/optional fields and strict mode.
 */
export function jsonSchemaToZod(schema: JsonObjectSchema): z.ZodType {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
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
    case 'string': {
      if (Array.isArray(property.enum) && property.enum.length > 0) {
        const values = property.enum.filter((value): value is string => typeof value === 'string');
        if (values.length === property.enum.length) {
          return z.enum(values as [string, ...string[]]);
        }
      }
      return z.string();
    }
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
