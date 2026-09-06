import type {
  DatabaseDesignerCapability,
  DesignerOperation,
  SchemaTreeNode,
} from '@justybase/contracts';

export type DesignerTab = 'overview' | 'definition' | 'columns' | 'indexes' | 'partitions' | 'triggers' | 'constraints';

export interface DesignerTargetFlags {
  isTableTarget: boolean;
  isViewTarget: boolean;
  isRoutineTarget: boolean;
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
