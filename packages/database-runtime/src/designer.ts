import { UnsupportedDesignerOperationError } from '@justybase/contracts';
import type {
  DatabaseDesignerCapabilities,
  DatabaseSchemaChangePlan,
  DatabaseDesignerCapabilityKey,
  DesignerOperation,
} from '@justybase/contracts';

export { UnsupportedDesignerOperationError };

export class StaleDesignerSnapshotError extends Error {
  public readonly code = 'DESIGNER_SNAPSHOT_STALE';

  public constructor(
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super('The database object changed after the designer snapshot was loaded. Refresh before applying changes.');
    this.name = 'StaleDesignerSnapshotError';
  }
}

export class EmptyDesignerPlanError extends Error {
  public readonly code = 'DESIGNER_PLAN_EMPTY';

  public constructor() {
    super('The designer produced no database changes.');
    this.name = 'EmptyDesignerPlanError';
  }
}

function isDesignerOperationSupported(
  capability: DatabaseDesignerCapabilities['constructs'][DatabaseDesignerCapabilityKey],
  operation: DesignerOperation,
  allowAlternative: boolean,
): boolean {
  return capability.operations.includes(operation)
    && capability.level !== 'unsupported'
    && capability.level !== 'runtime-unavailable'
    && capability.level !== 'privilege-blocked'
    && (allowAlternative || capability.level !== 'alternative');
}

export function hasDesignerOperation(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): boolean {
  return isDesignerOperationSupported(capabilities.constructs[capabilityKey], operation, allowAlternative);
}

export function assertDesignerOperationSupported(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): void {
  const capability = capabilities.constructs[capabilityKey];
  if (!isDesignerOperationSupported(capability, operation, allowAlternative)) {
    throw new UnsupportedDesignerOperationError(capabilityKey, operation, capability.reason);
  }
}

export function assertDesignerPlanCurrent(
  plan: DatabaseSchemaChangePlan,
  currentFingerprint: string,
): void {
  if (plan.baseFingerprint !== currentFingerprint) {
    throw new StaleDesignerSnapshotError(plan.baseFingerprint, currentFingerprint);
  }
}

export function assertDesignerPlanHasChanges(plan: DatabaseSchemaChangePlan): void {
  if (plan.statements.length === 0) throw new EmptyDesignerPlanError();
}
