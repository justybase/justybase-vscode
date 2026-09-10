/**
 * Column metadata shared by in-memory and disk-backed result consumers.
 *
 * Kept in a leaf module so result-provider contracts do not need to import
 * the broad desktop type barrel.
 */
export interface ColumnDefinition {
  name: string;
  type?: string;
  scale?: number;
}
