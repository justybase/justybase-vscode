import { UnsupportedDesignerOperationError } from '@justybase/contracts';
import type {
  DatabaseDesignerCapability,
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

export function getDesignerCapability(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
): DatabaseDesignerCapabilities['constructs'][DatabaseDesignerCapabilityKey] {
  return capabilities.constructs[capabilityKey];
}

export function isDesignerCapabilityOperationSupported(
  capability: DatabaseDesignerCapability | undefined,
  operation: DesignerOperation,
  allowAlternative = false,
): boolean {
  return Boolean(capability
    && capability.operations.includes(operation)
    && capability.level !== 'unsupported'
    && capability.level !== 'runtime-unavailable'
    && capability.level !== 'privilege-blocked'
    && (allowAlternative || capability.level !== 'alternative'));
}

export function assertDesignerCapabilityOperationSupported(
  capability: DatabaseDesignerCapability | undefined,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): void {
  if (!isDesignerCapabilityOperationSupported(capability, operation, allowAlternative)) {
    throw new UnsupportedDesignerOperationError(
      capabilityKey,
      operation,
      capability?.reason ?? `The ${capabilityKey} operation is not available for this target.`,
    );
  }
}

export function hasDesignerOperation(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): boolean {
  return isDesignerCapabilityOperationSupported(capabilities.constructs[capabilityKey], operation, allowAlternative);
}

export function isDesignerOperationSupported(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): boolean {
  return hasDesignerOperation(capabilities, capabilityKey, operation, allowAlternative);
}

export function assertDesignerOperationSupported(
  capabilities: DatabaseDesignerCapabilities,
  capabilityKey: DatabaseDesignerCapabilityKey,
  operation: DesignerOperation,
  allowAlternative = false,
): void {
  const capability = capabilities.constructs[capabilityKey];
  assertDesignerCapabilityOperationSupported(capability, capabilityKey, operation, allowAlternative);
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
