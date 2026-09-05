import {
    getDatabaseDesignerCapabilities,
    resolveDatabaseDesignerCapabilities,
    UnsupportedDesignerOperationError,
    type DatabaseDesignerCapabilityKey,
    type DatabaseDesignerRuntimeContext,
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
    context?: Omit<DatabaseDesignerRuntimeContext, 'databaseKind'>,
): void {
    const base = getDatabaseDesignerCapabilities(databaseKind);
    const capabilities = context
        ? resolveDatabaseDesignerCapabilities(base, { databaseKind: base.kind, ...context })
        : base;
    const designerCapability = capabilities.constructs[capabilityKey];
    const blocked = !designerCapability.operations.includes(operation)
        || designerCapability.level === 'unsupported'
        || designerCapability.level === 'runtime-unavailable'
        || designerCapability.level === 'privilege-blocked'
        || (!allowAlternative && designerCapability.level === 'alternative');
    if (blocked) {
        throw new UnsupportedDesignerOperationError(
            capabilityKey,
            operation,
            designerCapability.reason,
        );
    }
}
