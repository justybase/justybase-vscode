/**
 * Provider-backed capability manifest.
 *
 * Some `DatabaseCapabilities` flags are only honest when the dialect ships the
 * matching `DatabaseAdvancedFeatures` provider. Declaring a flag without its
 * provider produces menus that open and then fail (for example `EXPLAIN` with
 * no dialect-specific statement). This manifest is the single mapping between
 * the two surfaces so declarations and providers can be checked together.
 *
 * This module deliberately imports no contract types: `database/index.ts`
 * re-exports it, and a type-only import would still register as a dependency
 * cycle in the architecture gate. Callers keep their full typing through the
 * generic parameters below.
 */

/** Capability flag → the advanced-feature provider that must exist for it. */
export const PROVIDER_BACKED_CAPABILITIES = {
  supportsExplainPlan: 'explain',
  supportsExplainGraph: 'explain',
  supportsTuningAdvisor: 'tuningAdvisor',
  supportsTableMaintenance: 'maintenance',
  supportsSessionMonitor: 'sessionMonitor',
} as const;

export type ProviderBackedCapabilityKey = keyof typeof PROVIDER_BACKED_CAPABILITIES;

export type ProviderBackedFeatureKey =
  (typeof PROVIDER_BACKED_CAPABILITIES)[ProviderBackedCapabilityKey];

export const PROVIDER_BACKED_CAPABILITY_KEYS = Object.keys(
  PROVIDER_BACKED_CAPABILITIES,
) as ProviderBackedCapabilityKey[];

export function isProviderBackedCapability(
  key: string,
): key is ProviderBackedCapabilityKey {
  return Object.prototype.hasOwnProperty.call(PROVIDER_BACKED_CAPABILITIES, key);
}

/**
 * Returns a copy of `capabilities` with every provider-backed flag derived from
 * provider presence. Dialects that pass their advanced features through this
 * function cannot advertise a provider they do not ship.
 */
export function resolveProviderBackedCapabilities<T extends object>(
  capabilities: T,
  advancedFeatures: object | undefined,
): T {
  const resolved = { ...capabilities } as Record<string, unknown>;
  const providers = advancedFeatures as Record<string, unknown> | undefined;
  for (const capability of PROVIDER_BACKED_CAPABILITY_KEYS) {
    const feature = PROVIDER_BACKED_CAPABILITIES[capability];
    resolved[capability] = Boolean(providers?.[feature]);
  }
  return resolved as T;
}

/**
 * Lists the provider-backed flags a dialect declares but cannot back with a
 * provider, plus providers that exist without their flag. Used by the
 * capability consistency test to keep every dialect honest.
 */
export function findCapabilityDrift(
  capabilities: object,
  advancedFeatures: object | undefined,
): { missingProvider: ProviderBackedCapabilityKey[]; missingFlag: ProviderBackedFeatureKey[] } {
  const declared = capabilities as Record<string, unknown>;
  const providers = advancedFeatures as Record<string, unknown> | undefined;
  const missingProvider: ProviderBackedCapabilityKey[] = [];
  const missingFlag: ProviderBackedFeatureKey[] = [];
  const seenFeatures = new Set<ProviderBackedFeatureKey>();

  for (const capability of PROVIDER_BACKED_CAPABILITY_KEYS) {
    const feature = PROVIDER_BACKED_CAPABILITIES[capability];
    const hasProvider = Boolean(providers?.[feature]);
    if (declared[capability] === true && !hasProvider) {
      missingProvider.push(capability);
    }
    if (hasProvider) {
      seenFeatures.add(feature);
    }
  }

  for (const feature of seenFeatures) {
    const isDeclared = PROVIDER_BACKED_CAPABILITY_KEYS
      .filter((capability) => PROVIDER_BACKED_CAPABILITIES[capability] === feature)
      .some((capability) => declared[capability] === true);
    if (!isDeclared) {
      missingFlag.push(feature);
    }
  }

  return { missingProvider, missingFlag };
}
