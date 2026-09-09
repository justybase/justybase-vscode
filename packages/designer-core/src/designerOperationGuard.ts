import {
  assertDesignerOperationSupported,
} from './designer';
import {
  getDatabaseDesignerCapabilities,
  resolveDatabaseDesignerCapabilities,
  type DatabaseDesignerCapabilityKey,
  type DatabaseDesignerRuntimeContext,
  type DatabaseKind,
  type DesignerOperation,
} from '@justybase/contracts';

/**
 * Runtime guard shared by pure DDL builders. UI gating is helpful, but every
 * builder must also reject a construct that the selected dialect cannot emit.
 */
export function assertDesignerOperation(
  databaseKind: string | DatabaseKind | undefined,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
  context?: Omit<DatabaseDesignerRuntimeContext, 'databaseKind'>,
): void {
  const base = getDatabaseDesignerCapabilities(databaseKind);
  const capabilities = context
    ? resolveDatabaseDesignerCapabilities(base, { databaseKind: base.kind, ...context })
    : base;
  assertDesignerOperationSupported(capabilities, capabilityKey, operation, allowAlternative);
}
