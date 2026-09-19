import type { MetadataNode } from './ports';

/**
 * Labels shared by the schema explorers and kept in the same vocabulary as
 * the VS Code Schema view commands. Host-specific components still own the
 * actual action handlers because Web and VS Code have different document
 * and clipboard boundaries.
 */
export const SCHEMA_CONTEXT_MENU_LABELS = {
  setActiveContext: 'Set as active context',
  refreshSelectedMetadata: 'Refresh Selected Metadata',
  insertQualifiedName: 'Insert qualified name',
  insertColumnName: 'Insert column name',
  copyName: 'Copy Name',
  selectTop1000: 'Select Top 1000',
  explainPlan: 'Explain plan',
  viewEditData: 'View/Edit Data (Limit 50k)',
  openObjectDesigner: 'Open Object Designer',
  createDdlCode: 'Create DDL Code',
  copyDdl: 'Copy DDL',
  importData: 'Import Data',
  addToFavorites: 'Add to favorites',
  removeFromFavorites: 'Remove from favorites',
} as const;

export type SchemaContextMenuLabel = keyof typeof SCHEMA_CONTEXT_MENU_LABELS;

/**
 * The common object action order. The list is intentionally data-only so each
 * host can omit an action when its adapter does not provide the corresponding
 * callback without silently changing the order of the remaining actions.
 */
export const SCHEMA_OBJECT_CONTEXT_MENU_ORDER: readonly SchemaContextMenuLabel[] = [
  'insertQualifiedName',
  'copyName',
  'selectTop1000',
  'explainPlan',
  'viewEditData',
  'openObjectDesigner',
  'createDdlCode',
  'copyDdl',
  'importData',
  'addToFavorites',
];

/** Returns whether a node can be addressed by schema context actions. */
export function hasSchemaContextName(node: Pick<MetadataNode, 'kind'>): boolean {
  return node.kind === 'connection' || node.kind === 'database' || node.kind === 'schema' || node.kind === 'object' || node.kind === 'column';
}
