import {
    getDatabaseDesignerCapabilities,
    UnsupportedDesignerOperationError,
    type DatabaseDesignerCapabilityKey,
    type DatabaseKind,
    type DesignerOperation,
} from '../contracts/database';

/**
 * Runtime guard shared by pure DDL builders. UI gating is helpful, but every
 * builder must also reject a construct that the selected dialect cannot emit.
 */
export function assertDesignerOperation(
    databaseKind: string | DatabaseKind | undefined,
    capabilityKey: DatabaseDesignerCapabilityKey,
    operation: DesignerOperation,
    allowAlternative = false,
): void {
    const capability = getDatabaseDesignerCapabilities(databaseKind);
    const blocked = !capability.constructs[capabilityKey].operations.includes(operation)
        || capability.constructs[capabilityKey].level === 'unsupported'
        || capability.constructs[capabilityKey].level === 'runtime-unavailable'
        || capability.constructs[capabilityKey].level === 'privilege-blocked'
        || (!allowAlternative && capability.constructs[capabilityKey].level === 'alternative');
    if (blocked) {
        throw new UnsupportedDesignerOperationError(
            capabilityKey,
            operation,
            capability.constructs[capabilityKey].reason,
        );
    }
}
