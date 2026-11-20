import {
    DEFAULT_AI_TOOL_ACCESS,
    allowedToolIds,
    effectiveToolTier,
    normalizeAiToolAccess,
    surfaceAllowsConnectionWrites,
} from '../../core/assistant/toolPolicy';
import { getAssistantTool } from '../../core/assistant/toolCatalog';

const executeSql = getAssistantTool('execute_sql')!;
const dropObject = getAssistantTool('drop_object')!;
const compileProcedure = getAssistantTool('compile_procedure')!;

describe('assistant tool access policy', () => {
    it('disables every assistant tool by default', () => {
        expect(allowedToolIds('copilot', DEFAULT_AI_TOOL_ACCESS)).toEqual([]);
        expect(allowedToolIds('mcp', DEFAULT_AI_TOOL_ACCESS, 'Dev')).toEqual([]);
        expect(allowedToolIds('mcpExternal', DEFAULT_AI_TOOL_ACCESS, 'Dev')).toEqual([]);
    });

    it('read-only exposes only read tools', () => {
        const access = normalizeAiToolAccess({ copilot: 'read-only' });
        const ids = allowedToolIds('copilot', access);
        expect(ids).toContain('get_context');
        expect(ids).not.toContain('execute_sql');
        expect(ids).not.toContain('drop_object');
        expect(ids).not.toContain('compile_procedure');
    });

    it('read-write exposes write tools but not destructive tools', () => {
        const access = normalizeAiToolAccess({ copilot: 'read-write' });
        expect(effectiveToolTier(executeSql, 'copilot', access)).toBe('write');
        expect(effectiveToolTier(compileProcedure, 'copilot', access)).toBe('write');
        expect(effectiveToolTier(dropObject, 'copilot', access)).toBeUndefined();
    });

    it('full exposes destructive tools', () => {
        const access = normalizeAiToolAccess({ copilot: 'full' });
        expect(effectiveToolTier(dropObject, 'copilot', access)).toBe('destructive');
        expect(effectiveToolTier(executeSql, 'copilot', access)).toBe('destructive');
        expect(effectiveToolTier(compileProcedure, 'copilot', access)).toBe('destructive');
    });

    it('narrows execute_sql to reads without disabling the tool', () => {
        const access = normalizeAiToolAccess({
            copilot: { access: 'read-write', overrides: { execute_sql: 'read' } },
        });
        expect(effectiveToolTier(executeSql, 'copilot', access)).toBe('read');
    });

    it('disables tools that have no reduced mode when narrowed below their tier', () => {
        const access = normalizeAiToolAccess({
            copilot: {
                access: 'full',
                overrides: { compile_procedure: 'read', drop_object: 'write' },
            },
        });
        expect(effectiveToolTier(compileProcedure, 'copilot', access)).toBeUndefined();
        expect(effectiveToolTier(dropObject, 'copilot', access)).toBeUndefined();
    });

    it('requires an allowlisted connection for MCP writes', () => {
        const access = normalizeAiToolAccess({
            mcp: 'read-write',
            writableConnections: ['Dev'],
        });
        expect(effectiveToolTier(executeSql, 'mcp', access, 'Dev')).toBe('write');
        expect(effectiveToolTier(executeSql, 'mcp', access, 'Production')).toBeUndefined();
        expect(surfaceAllowsConnectionWrites(access, 'mcp', 'Dev')).toBe(true);
        expect(surfaceAllowsConnectionWrites(access, 'mcp', 'Production')).toBe(false);
    });

    it('does not expose MCP writes on a read-only profile even with an allowlisted connection', () => {
        const access = normalizeAiToolAccess({
            mcp: 'read-only',
            writableConnections: ['Dev'],
        });
        expect(allowedToolIds('mcp', access, 'Dev')).not.toContain('execute_sql');
        expect(surfaceAllowsConnectionWrites(access, 'mcp', 'Dev')).toBe(false);
    });
});
