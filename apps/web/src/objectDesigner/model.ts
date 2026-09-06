import type {
  DatabaseDesignerCapability,
  DatabaseDesignerCapabilityKey,
  DesignerOperation,
  SchemaTreeNode,
} from '@justybase/contracts';

export type DesignerTab = 'overview' | 'definition' | 'columns' | 'indexes' | 'partitions' | 'triggers' | 'constraints';

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

export function isMutatingCapability(
  capability: DatabaseDesignerCapability | undefined,
  operation: DesignerOperation,
): boolean {
  return Boolean(capability && capability.operations.includes(operation)
    && (capability.level === 'supported' || capability.level === 'limited'));
}

export function viewDefinitionFromMetadata(viewSql: string | undefined, description?: string): string {
  const source = (viewSql ?? description)?.trim() ?? '';
  if (!/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(source)) return '';
  const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b[\s\S]*?\bAS\s+([\s\S]*?)\s*;?$/i.exec(source);
  return match?.[1]?.trim().replace(/;\s*$/u, '') ?? '';
}

export interface DesignerTargetFlags {
  isTableTarget: boolean;
  isViewTarget: boolean;
  isRoutineTarget: boolean;
}

export function getDesignerTargetFlags(target: SchemaTreeNode): DesignerTargetFlags {
  const objectType = (target.objectType ?? '').toUpperCase();
  return {
    isTableTarget: (target.objectType ?? 'TABLE').toUpperCase() === 'TABLE',
    isViewTarget: objectType === 'VIEW',
    isRoutineTarget: objectType === 'PROCEDURE' || objectType === 'FUNCTION',
  };
}

export function getAvailableDesignerTabs(target: SchemaTreeNode): readonly DesignerTab[] {
  const { isTableTarget, isViewTarget, isRoutineTarget } = getDesignerTargetFlags(target);
  if (isTableTarget) return ['overview', 'columns', 'indexes', 'partitions', 'triggers', 'constraints'];
  if (isViewTarget) return ['overview', 'definition', 'triggers'];
  if (isRoutineTarget) return ['overview', 'definition'];
  return ['overview'];
}
