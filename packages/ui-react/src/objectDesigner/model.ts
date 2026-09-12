import type {
  DatabaseDesignerCapability,
  DatabaseDesignerCapabilityKey,
} from '@justybase/contracts';
import {
  getAvailableDesignerTabs,
  getDesignerTargetFlags,
  isMutatingCapability,
  viewDefinitionFromMetadata,
  type DesignerTab,
  type DesignerTargetFlags,
} from '@justybase/designer-core';

export { getAvailableDesignerTabs, getDesignerTargetFlags, isMutatingCapability, viewDefinitionFromMetadata };
export type { DesignerTab, DesignerTargetFlags };

export const CAPABILITY_ROWS: ReadonlyArray<{ key: DatabaseDesignerCapabilityKey; label: string }> = [
  { key: 'alterTable', label: 'Table structure' },
  { key: 'indexes', label: 'Indexes / physical design' },
  { key: 'partitions', label: 'Partitions / distribution' },
  { key: 'foreignKeys', label: 'Foreign keys' },
  { key: 'checks', label: 'CHECK constraints' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'views', label: 'Views' },
  { key: 'materializedViews', label: 'Materialized views' },
  { key: 'procedures', label: 'Procedures / functions' },
  { key: 'sequences', label: 'Sequences' },
  { key: 'usersRoles', label: 'Users / roles' },
];

export function capabilityClass(capability: DatabaseDesignerCapability): string {
  return `object-designer-capability object-designer-capability-${capability.level}`;
}

export function capabilityLabel(level: DatabaseDesignerCapability['level']): string {
  switch (level) {
    case 'supported': return 'Supported';
    case 'limited': return 'Limited';
    case 'alternative': return 'Native alternative';
    case 'privilege-blocked': return 'Read-only';
    case 'runtime-unavailable': return 'Runtime unavailable';
    default: return 'Unsupported';
  }
}
