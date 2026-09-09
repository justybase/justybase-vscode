import { isFresh } from './ttl';

export interface MetadataPrefetchPlanInput {
  lastPrefetchAt?: number;
  now: number;
  cacheTtl: number;
  snapshotComplete: boolean;
  force: boolean;
}

export interface MetadataPrefetchPlan {
  stale: boolean;
  skip: boolean;
  reason: 'forced' | 'missing' | 'stale' | 'complete';
}

/** Pure decision used by adapters before they acquire locks or execute I/O. */
export function createMetadataPrefetchPlan(input: MetadataPrefetchPlanInput): MetadataPrefetchPlan {
  if (input.force) return { stale: input.lastPrefetchAt !== undefined && !isFresh(input.lastPrefetchAt, input.now, input.cacheTtl), skip: false, reason: 'forced' };
  if (input.lastPrefetchAt === undefined) return { stale: false, skip: false, reason: 'missing' };
  const stale = !isFresh(input.lastPrefetchAt, input.now, input.cacheTtl);
  if (stale) return { stale: true, skip: false, reason: 'stale' };
  return { stale: false, skip: input.snapshotComplete, reason: input.snapshotComplete ? 'complete' : 'missing' };
}
