import {
    getDesignerCapability as getCoreDesignerCapability,
    isDesignerOperationSupported as isCoreDesignerOperationSupported,
} from '@justybase/designer-core';
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
    return getCoreDesignerCapability(capabilities, key);
}

export function isDesignerOperationSupported(
    capabilities: DatabaseDesignerCapabilities,
    key: DatabaseDesignerCapabilityKey,
    operation: DesignerOperation,
): boolean {
    return isCoreDesignerOperationSupported(capabilities, key, operation);
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
