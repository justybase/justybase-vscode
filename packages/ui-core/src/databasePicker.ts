import type { MetadataDatabase } from '@justybase/contracts';

export interface DatabasePickerState {
  readonly value: string;
  readonly options: MetadataDatabase[];
}

/**
 * Keeps a document's database visible while the catalog is loading or when a
 * connection profile points at a database the catalog response does not list.
 * Matching database names case-insensitively also avoids an empty native
 * select when Netezza returns catalog names in a different case.
 */
export function resolveDatabasePicker(
  databases: readonly MetadataDatabase[],
  currentDatabase?: string,
): DatabasePickerState {
  const current = currentDatabase?.trim() ?? '';
  if (!current) return { value: '', options: [...databases] };

  const exact = databases.find(database => database.name === current);
  const listed = exact ?? databases.find(database => database.name.toUpperCase() === current.toUpperCase());
  if (listed) return { value: listed.name, options: [...databases] };

  return { value: current, options: [{ name: current }, ...databases] };
}
