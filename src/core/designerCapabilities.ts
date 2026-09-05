import {
  getDatabaseDesignerCapabilities as getBaselineDesignerCapabilities,
  resolveDatabaseDesignerCapabilities,
  type DatabaseDesignerCapabilities,
  type DatabaseDesignerCapability,
  type DatabaseDesignerCapabilityKey,
  type DatabaseDesignerRuntimeContext,
  type DatabaseKind,
} from '../contracts/database';
import { resolveConnectionDatabaseKind, tryGetDatabaseDialect } from './connectionFactory';

/**
 * Returns the registered dialect baseline when one is supplied, otherwise the
 * shared contract manifest. This is the only core entry point UI code should
 * use for designer capability lookup.
 */
export function getCoreDatabaseDesignerCapabilities(
  kind?: string | DatabaseKind,
  context?: Omit<DatabaseDesignerRuntimeContext, 'databaseKind'>,
): DatabaseDesignerCapabilities {
  const normalizedKind = resolveConnectionDatabaseKind(kind);
  const dialect = tryGetDatabaseDialect(normalizedKind);
  const baseline = dialect?.designerCapabilities
    ?? getBaselineDesignerCapabilities(normalizedKind);

  return context
    ? resolveDatabaseDesignerCapabilities(baseline, {
      databaseKind: normalizedKind,
      ...context,
    })
    : baseline;
}

export function getCoreDesignerCapability(
  kind: string | DatabaseKind | undefined,
  key: DatabaseDesignerCapabilityKey,
  context?: Omit<DatabaseDesignerRuntimeContext, 'databaseKind'>,
): DatabaseDesignerCapability {
  return getCoreDatabaseDesignerCapabilities(kind, context).constructs[key];
}
