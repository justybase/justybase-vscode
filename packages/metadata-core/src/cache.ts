import { GenerationTracker } from './invalidation';
import type { MetadataGenerationToken, MetadataTtlState, TimedMetadataEntry } from './types';
import { classifyTtl } from './ttl';

export interface MetadataCacheRead<T> {
  value: T;
  state: MetadataTtlState;
}

/** Small adapter-friendly cache for API and other non-desktop consumers. */
export class TimedMetadataCache {
  private readonly entries = new Map<string, TimedMetadataEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly generations = new GenerationTracker();

  public read<T>(key: string, now: number, freshTtl: number, staleTtl: number): MetadataCacheRead<T> | undefined {
    const entry = this.entries.get(key) as TimedMetadataEntry<T> | undefined;
    if (!entry) return undefined;
    const state = classifyTtl(entry.timestamp, now, freshTtl, staleTtl);
    if (state === 'expired') {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value, state };
  }

  public write<T>(key: string, value: T, timestamp: number, token?: MetadataGenerationToken): boolean {
    if (token && !this.isCurrent(token)) return false;
    this.entries.set(key, { value, timestamp });
    return true;
  }

  public getGeneration(connectionId: string): MetadataGenerationToken {
    return this.generations.capture(connectionId);
  }

  public invalidate(connectionId?: string): void {
    if (connectionId === undefined) {
      this.generations.invalidate();
      this.entries.clear();
      this.inFlight.clear();
      return;
    }
    this.generations.invalidate(connectionId);
    const matchesConnection = (key: string): boolean =>
      key.includes(`|${encodeURIComponent(connectionId)}|`)
      || key.startsWith(`${encodeURIComponent(connectionId)}|`);
    for (const key of this.entries.keys()) {
      if (matchesConnection(key)) this.entries.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (matchesConnection(key)) this.inFlight.delete(key);
    }
  }

  public isCurrent(token: MetadataGenerationToken): boolean {
    return this.generations.isCurrent(token);
  }

  public getInFlight<T>(key: string): Promise<T> | undefined {
    return this.inFlight.get(key) as Promise<T> | undefined;
  }

  public setInFlight<T>(key: string, promise: Promise<T>): void {
    this.inFlight.set(key, promise);
    void promise.then(
      () => this.clearInFlight(key, promise),
      () => this.clearInFlight(key, promise),
    );
  }

  private clearInFlight<T>(key: string, promise: Promise<T>): void {
    if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
  }

  public clear(): void {
    this.generations.invalidate();
    this.entries.clear();
    this.inFlight.clear();
  }

  public delete(key: string): void {
    this.entries.delete(key);
  }

  public clearWhere(predicate: (key: string) => boolean): void {
    for (const key of this.entries.keys()) {
      if (predicate(key)) this.entries.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (predicate(key)) this.inFlight.delete(key);
    }
  }

  public size(): number {
    return this.entries.size;
  }
}
