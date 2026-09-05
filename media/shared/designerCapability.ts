import type {
    DatabaseDesignerCapabilities,
    DatabaseDesignerCapability,
    DatabaseDesignerCapabilityKey,
    DesignerOperation,
} from '../../packages/contracts/src/database/designerCapabilities';

/** Small, framework-free helper used by desktop webviews to gate sections. */
export function getDesignerCapability(
    capabilities: DatabaseDesignerCapabilities,
    key: DatabaseDesignerCapabilityKey,
): DatabaseDesignerCapability {
    return capabilities.constructs[key];
}

export function isDesignerOperationSupported(
    capabilities: DatabaseDesignerCapabilities,
    key: DatabaseDesignerCapabilityKey,
    operation: DesignerOperation,
): boolean {
    const capability = getDesignerCapability(capabilities, key);
    return capability.operations.includes(operation)
        && capability.level !== 'unsupported'
        && capability.level !== 'runtime-unavailable'
        && capability.level !== 'privilege-blocked'
        && capability.level !== 'alternative';
}

export function isAlternativeConstruct(
    capabilities: DatabaseDesignerCapabilities,
    key: DatabaseDesignerCapabilityKey,
): boolean {
    return getDesignerCapability(capabilities, key).level === 'alternative';
}

export function unsupportedReason(
    capabilities: DatabaseDesignerCapabilities,
    key: DatabaseDesignerCapabilityKey,
): string | undefined {
    return getDesignerCapability(capabilities, key).reason;
}
