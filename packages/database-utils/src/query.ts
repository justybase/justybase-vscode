import type { DatabaseConnection } from '@justybase/contracts';

export async function executeDatabaseQuery<T = Record<string, unknown>>(
  connection: DatabaseConnection,
  sql: string,
): Promise<T[]> {
  const command = connection.createCommand(sql);
  const reader = await command.executeReader();
  const results: Record<string, unknown>[] = [];

  try {
    while (await reader.read()) {
      const row: Record<string, unknown> = {};
      for (let index = 0; index < reader.fieldCount; index += 1) {
        row[reader.getName(index)] = reader.getValue(index);
      }
      results.push(row);
    }
    return results as T[];
  } finally {
    await reader.close();
  }
}
