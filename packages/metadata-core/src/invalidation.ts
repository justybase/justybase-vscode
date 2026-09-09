import type { MetadataInvalidationScope } from './types';

export function matchesInvalidationScope(
  value: { connectionId: string; database?: string; schema?: string },
  scope: MetadataInvalidationScope,
): boolean {
  if (value.connectionId !== scope.connectionId) return false;
  if (scope.database !== undefined && value.database !== scope.database) return false;
  return scope.schema === undefined || value.schema === scope.schema;
}

export function filterInvalidatedEntries<T>(
  entries: ReadonlyMap<string, T>,
  matches: (value: T, key: string) => boolean,
): Map<string, T> {
  const result = new Map(entries);
  for (const [key, value] of entries) {
    if (matches(value, key)) result.delete(key);
  }
  return result;
}

export class GenerationTracker {
  private globalGeneration = 0;
  private readonly generations = new Map<string, number>();

  public current(connectionId?: string): number {
    if (connectionId === undefined) return this.globalGeneration;
    return Math.max(this.globalGeneration, this.generations.get(connectionId) ?? 0);
  }

  public capture(connectionId: string): { connectionId: string; generation: number } {
    return { connectionId, generation: this.current(connectionId) };
  }

  public invalidate(connectionId?: string): number {
    if (connectionId !== undefined) {
      const next = this.current(connectionId) + 1;
      this.generations.set(connectionId, next);
      return next;
    }

    this.globalGeneration += 1;
    for (const [id, generation] of this.generations) {
      this.generations.set(id, Math.max(generation, this.globalGeneration) + 1);
    }
    return this.globalGeneration;
  }

  public isCurrent(token: { connectionId: string; generation: number }): boolean {
    return token.generation === this.current(token.connectionId);
  }
}
