/**
 * Access policy for assistant tools.
 *
 * Each surface has a profile (`read-only`, `read-write`, `full`) and optional
 * per-tool overrides. An override can only narrow access; it can never widen
 * the surface profile. MCP write tools additionally require the selected
 * connection to be listed in `writableConnections`.
 */

import {
  ASSISTANT_TOOL_CATALOG,
  copilotToolName,
  type AssistantToolDefinition,
  type ToolSurface,
  type ToolTier,
} from './toolCatalog';

export type AccessProfile = 'off' | 'read-only' | 'read-write' | 'full';

export type ToolAccessLevel = 'off' | 'read' | 'write' | 'destructive';

export interface ToolSurfaceAccess {
  readonly access: AccessProfile;
  readonly overrides: Readonly<Record<string, ToolAccessLevel>>;
}

export interface AiToolAccessConfig {
  readonly copilot: ToolSurfaceAccess;
  readonly mcp: ToolSurfaceAccess;
  readonly mcpExternal: ToolSurfaceAccess;
  readonly writableConnections: readonly string[];
}

const TIER_RANK: Record<ToolTier, number> = { read: 1, write: 2, destructive: 3 };
const PROFILE_RANK: Record<AccessProfile, number> = { off: 0, 'read-only': 1, 'read-write': 2, full: 3 };
const ACCESS_LEVEL_RANK: Record<ToolAccessLevel, number> = {
  off: 0,
  read: 1,
  write: 2,
  destructive: 3,
};
const RANK_TIER: readonly ToolTier[] = ['read', 'write', 'destructive'];
const ACCESS_PROFILES: readonly AccessProfile[] = ['off', 'read-only', 'read-write', 'full'];
const ACCESS_LEVELS: readonly ToolAccessLevel[] = ['off', 'read', 'write', 'destructive'];

export const DEFAULT_SURFACE_ACCESS: ToolSurfaceAccess = {
  access: 'off',
  overrides: {},
};

export const DEFAULT_AI_TOOL_ACCESS: AiToolAccessConfig = {
  copilot: DEFAULT_SURFACE_ACCESS,
  mcp: DEFAULT_SURFACE_ACCESS,
  mcpExternal: DEFAULT_SURFACE_ACCESS,
  writableConnections: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProfile(value: unknown, fallback: AccessProfile): AccessProfile {
  return typeof value === 'string' && (ACCESS_PROFILES as readonly string[]).includes(value)
    ? (value as AccessProfile)
    : fallback;
}

function normalizeLevel(value: unknown): ToolAccessLevel | undefined {
  return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as ToolAccessLevel)
    : undefined;
}

function normalizeOverrides(value: unknown): Record<string, ToolAccessLevel> {
  if (!isRecord(value)) return {};
  const overrides: Record<string, ToolAccessLevel> = {};
  for (const [key, raw] of Object.entries(value)) {
    const level = normalizeLevel(raw);
    if (level !== undefined) overrides[key] = level;
  }
  return overrides;
}

function normalizeSurface(value: unknown): ToolSurfaceAccess {
  // Accept the shorthand `"read-write"` as well as the object form.
  if (typeof value === 'string') {
    return { access: normalizeProfile(value, 'off'), overrides: {} };
  }
  if (!isRecord(value)) return DEFAULT_SURFACE_ACCESS;
  return {
    access: normalizeProfile(value.access, 'off'),
    overrides: normalizeOverrides(value.overrides),
  };
}

/** Defensive parse of the `justybase.ai.tools` setting. */
export function normalizeAiToolAccess(value: unknown): AiToolAccessConfig {
  if (!isRecord(value)) return DEFAULT_AI_TOOL_ACCESS;
  const writable = Array.isArray(value.writableConnections)
    ? value.writableConnections.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    copilot: normalizeSurface(value.copilot),
    mcp: normalizeSurface(value.mcp),
    mcpExternal: normalizeSurface(value.mcpExternal),
    writableConnections: writable,
  };
}

export function surfaceAccess(config: AiToolAccessConfig, surface: ToolSurface): ToolSurfaceAccess {
  return config[surface];
}

function overrideFor(tool: AssistantToolDefinition, surfaceAccessValue: ToolSurfaceAccess): ToolAccessLevel | undefined {
  return (
    surfaceAccessValue.overrides[tool.id]
    ?? surfaceAccessValue.overrides[copilotToolName(tool.id)]
  );
}

function connectionAllowsWrites(config: AiToolAccessConfig, connectionName?: string): boolean {
  const selected = (connectionName ?? '').trim().toLowerCase();
  if (!selected) return false;
  return config.writableConnections.some(name => name.trim().toLowerCase() === selected);
}

/**
 * Effective capability for a tool on a surface, or `undefined` when the tool is
 * not available.
 *
 * The surface profile is a hard upper bound: a write tool is never available on
 * `read-only`, and a destructive tool is never available below `full`. An
 * override can narrow the effective capability further (for example
 * `execute_sql: read` on a `read-write` profile). Tools that have no reduced
 * mode (DROP, procedure compilation) disappear when the override would reduce
 * them below their required tier.
 */
export function effectiveToolTier(
  tool: AssistantToolDefinition,
  surface: ToolSurface,
  config: AiToolAccessConfig,
  connectionName?: string,
): ToolTier | undefined {
  if (!tool.surfaces.includes(surface)) return undefined;

  const access = surfaceAccess(config, surface);
  const requiredRank = TIER_RANK[tool.tier];
  const profileRank = PROFILE_RANK[access.access];
  if (profileRank < requiredRank) return undefined;

  const override = overrideFor(tool, access);
  const overrideRank = override === undefined ? profileRank : ACCESS_LEVEL_RANK[override];
  let limit = Math.min(profileRank, overrideRank);

  if (limit < requiredRank && tool.supportsReducedTier !== true) return undefined;
  if (tool.supportsDestructiveStatements !== true) {
    // Read/write tools never gain destructive capability just because the
    // surface profile is full.
    limit = Math.min(limit, requiredRank);
  }
  if (limit < ACCESS_LEVEL_RANK.read) return undefined;

  // MCP surfaces only expose write-capable tools for allowlisted connections.
  if (surface !== 'copilot' && limit > ACCESS_LEVEL_RANK.read && !connectionAllowsWrites(config, connectionName)) {
    return undefined;
  }

  return RANK_TIER[limit - 1];
}

export function isToolAllowed(
  tool: AssistantToolDefinition,
  surface: ToolSurface,
  config: AiToolAccessConfig,
  connectionName?: string,
): boolean {
  return effectiveToolTier(tool, surface, config, connectionName) !== undefined;
}

export function allowedToolsForSurface(
  surface: ToolSurface,
  config: AiToolAccessConfig,
  connectionName?: string,
): AssistantToolDefinition[] {
  return ASSISTANT_TOOL_CATALOG.filter(tool => isToolAllowed(tool, surface, config, connectionName));
}

export function allowedToolIds(
  surface: ToolSurface,
  config: AiToolAccessConfig,
  connectionName?: string,
): string[] {
  return allowedToolsForSurface(surface, config, connectionName).map(tool => tool.id);
}

/** Effective capability per canonical tool id for one surface. */
export function effectiveToolTiers(
  surface: ToolSurface,
  config: AiToolAccessConfig,
  connectionName?: string,
): Readonly<Record<string, ToolTier>> {
  const tiers: Record<string, ToolTier> = {};
  for (const tool of ASSISTANT_TOOL_CATALOG) {
    const tier = effectiveToolTier(tool, surface, config, connectionName);
    if (tier !== undefined) tiers[tool.id] = tier;
  }
  return tiers;
}

/** True when the surface can run statements that write to the database. */
export function surfaceAllowsWrites(config: AiToolAccessConfig, surface: ToolSurface): boolean {
  return PROFILE_RANK[surfaceAccess(config, surface).access] >= PROFILE_RANK['read-write'];
}

/** True when the surface can run destructive statements. */
export function surfaceAllowsDestructive(config: AiToolAccessConfig, surface: ToolSurface): boolean {
  return PROFILE_RANK[surfaceAccess(config, surface).access] >= PROFILE_RANK.full;
}

/**
 * True when the surface exposes at least one write-capable tool for this
 * connection. MCP surfaces additionally require the connection in
 * `writableConnections`.
 */
export function surfaceAllowsConnectionWrites(
  config: AiToolAccessConfig,
  surface: ToolSurface,
  connectionName?: string,
): boolean {
  return allowedToolsForSurface(surface, config, connectionName).some(
    tool => effectiveToolTier(tool, surface, config, connectionName) !== 'read',
  );
}
