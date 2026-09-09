import {
  GenerationTracker,
  buildMetadataKey,
  buildObjectIndexes,
  casePreservingIdentifierPolicy,
  classifyTtl,
  createMetadataKeyCodec,
  createMetadataPrefetchPlan,
  evaluateCompleteness,
  lookupObject,
  mergeMissing,
  mergeObjectType,
  metadataIdentifier,
  TimedMetadataCache,
  type MetadataObjectLike,
} from '../src';

const netezzaPolicy = {
  normalizeUser: (value: string, quoted = false) => quoted ? value : value.toUpperCase(),
  normalizeCatalog: (value: string) => value,
};

describe('metadata-core rules', () => {
  it('keeps key segments distinct and round-trippable', () => {
    const codec = createMetadataKeyCodec(netezzaPolicy);
    const key = codec.build({
      namespace: 'api',
      ownerId: 'user|1',
      connectionId: 'conn',
      layer: 'table',
      database: metadataIdentifier('just_data', 'catalog'),
      schema: metadataIdentifier('S.1', 'catalog'),
      objectType: 'TABLE',
      objectName: metadataIdentifier('T|1', 'catalog'),
    });
    expect(codec.parse(key)).toEqual({
      namespace: 'api',
      ownerId: 'user|1',
      connectionId: 'conn',
      layer: 'table',
      database: 'just_data',
      schema: 'S.1',
      objectType: 'TABLE',
      objectName: 'T|1',
      columnName: undefined,
    });
    expect(buildMetadataKey({ connectionId: 'c', layer: 'table', database: metadataIdentifier('DB'), schema: metadataIdentifier('S') }, casePreservingIdentifierPolicy))
      .not.toBe(buildMetadataKey({ connectionId: 'c', layer: 'table', database: metadataIdentifier('db'), schema: metadataIdentifier('s') }, casePreservingIdentifierPolicy));
  });

  it('applies user folding without changing catalog values', () => {
    const codec = createMetadataKeyCodec(netezzaPolicy);
    const plain = codec.build({ connectionId: 'c', layer: 'table', database: metadataIdentifier('db'), schema: metadataIdentifier('schema') });
    const quoted = codec.build({ connectionId: 'c', layer: 'table', database: metadataIdentifier('db', 'user', true), schema: metadataIdentifier('schema', 'user', true) });
    const catalog = codec.build({ connectionId: 'c', layer: 'table', database: metadataIdentifier('db', 'catalog'), schema: metadataIdentifier('schema', 'catalog') });
    expect(plain).not.toBe(quoted);
    expect(catalog).toBe(quoted);
  });

  it('uses the exact TTL boundaries and accepts an explicit clock', () => {
    expect(classifyTtl(100, 100 + 10, 10, 20)).toBe('stale');
    expect(classifyTtl(100, 100 + 19, 10, 20)).toBe('stale');
    expect(classifyTtl(100, 100 + 20, 10, 20)).toBe('expired');
    expect(classifyTtl(100, 90, 10, 20)).toBe('fresh');
  });

  it('replaces only the refreshed object type', () => {
    const existing = [
      { name: 'T', schema: 'S', objectType: 'TABLE' },
      { name: 'V', schema: 'S', objectType: 'VIEW' },
    ];
    const result = mergeObjectType(existing, [{ name: 'V2', schema: 'S', objectType: 'view' }], {
      objectType: 'VIEW',
      getObjectType: value => value.objectType,
      normalizeObjectType: value => value.toUpperCase(),
      getIdentity: value => `${value.schema}|${value.name}|${value.objectType}`,
    });
    expect(result).toEqual([
      { name: 'T', schema: 'S', objectType: 'TABLE' },
      { name: 'V2', schema: 'S', objectType: 'view' },
    ]);
  });

  it('lets refreshed metadata replace an older record with the same identity', () => {
    const result = mergeObjectType(
      [{ name: 'T', schema: 'S', objectType: 'TABLE', description: 'old' }],
      [{ name: 'T', schema: 'S', objectType: 'TABLE', description: 'new' }],
      {
        objectType: 'TABLE',
        getObjectType: value => value.objectType,
        getIdentity: value => `${value.schema}|${value.name}|${value.objectType}`,
      },
    );

    expect(result).toEqual([
      { name: 'T', schema: 'S', objectType: 'TABLE', description: 'new' },
    ]);
  });

  it('skips records without a caller-defined identity', () => {
    const result = mergeObjectType(
      [{ name: 'T', objectType: 'TABLE' }, { name: '', objectType: 'TABLE' }],
      [{ name: '', objectType: 'TABLE' }, { name: 'V', objectType: 'VIEW' }],
      {
        objectType: 'TABLE',
        getObjectType: value => value.objectType,
        getIdentity: value => value.name || undefined,
      },
    );

    expect(result).toEqual([{ name: 'V', objectType: 'VIEW' }]);
  });

  it('fills missing columns without duplicating identities', () => {
    expect(mergeMissing([{ name: 'ID' }], [{ name: 'ID' }, { name: 'NAME' }], value => value.name))
      .toEqual([{ name: 'ID' }, { name: 'NAME' }]);
  });

  it('builds deterministic full and name-only indexes', () => {
    const values: MetadataObjectLike[] = [
      { name: 'T', database: 'DB', schema: 'S1', objectType: 'TABLE', objectId: 1 },
      { name: 'T', database: 'DB', schema: 'S2', objectType: 'VIEW', objectId: 2 },
    ];
    const indexes = buildObjectIndexes(values, {
      getQualifiedKey: value => `${value.database}|${value.schema}|${value.name}`,
      getNameOnlyKey: value => `${value.database}|${value.name}`,
    });
    expect(lookupObject(indexes, 'DB|S2|T')?.objectId).toBe(2);
    expect(lookupObject(indexes, 'missing', 'DB|T')?.objectId).toBe(1);
  });

  it('reports missing stages and column layers', () => {
    expect(evaluateCompleteness({
      databaseLoaded: true,
      schemaLoaded: true,
      objectsLoaded: true,
      proceduresLoaded: false,
      typeGroupsLoaded: true,
      expectedColumnKeys: ['a', 'b'],
      loadedColumnKeys: new Set(['a']),
    })).toEqual({ complete: false, missingStages: ['procedures'], missingColumnKeys: ['b'] });
  });

  it('invalidates generations monotonically', () => {
    const tracker = new GenerationTracker();
    const token = tracker.capture('conn');
    const otherToken = tracker.capture('other');
    expect(tracker.isCurrent(token)).toBe(true);
    tracker.invalidate('conn');
    expect(tracker.isCurrent(token)).toBe(false);
    expect(tracker.isCurrent(otherToken)).toBe(true);
    const globalGeneration = tracker.current();
    tracker.invalidate();
    expect(tracker.isCurrent(otherToken)).toBe(false);
    expect(tracker.current()).toBe(globalGeneration + 1);
  });

  it('separates prefetch planning from adapter I/O', () => {
    expect(createMetadataPrefetchPlan({ now: 100, cacheTtl: 10, snapshotComplete: true, force: false })).toEqual({
      stale: false,
      skip: false,
      reason: 'missing',
    });
    expect(createMetadataPrefetchPlan({ lastPrefetchAt: 95, now: 100, cacheTtl: 10, snapshotComplete: true, force: false })).toEqual({
      stale: false,
      skip: true,
      reason: 'complete',
    });
    expect(createMetadataPrefetchPlan({ lastPrefetchAt: 80, now: 100, cacheTtl: 10, snapshotComplete: true, force: false })).toEqual({
      stale: true,
      skip: false,
      reason: 'stale',
    });
    expect(createMetadataPrefetchPlan({ lastPrefetchAt: 95, now: 100, cacheTtl: 10, snapshotComplete: true, force: true })).toEqual({
      stale: false,
      skip: false,
      reason: 'forced',
    });
  });

  it('invalidates only the requested timed-cache scope', () => {
    const cache = new TimedMetadataCache();
    const first = cache.getGeneration('connection-1');
    const second = cache.getGeneration('connection-2');
    cache.write('connection-1|entry', 'one', 100, first);
    cache.write('connection-2|entry', 'two', 100, second);
    const firstInFlight = new Promise<string>(() => undefined);
    const secondInFlight = new Promise<string>(() => undefined);
    cache.setInFlight('connection-1|entry', firstInFlight);
    cache.setInFlight('connection-2|entry', secondInFlight);

    cache.invalidate('connection-1');

    expect(cache.read('connection-1|entry', 100, 10, 20)).toBeUndefined();
    expect(cache.read<string>('connection-2|entry', 100, 10, 20)?.value).toBe('two');
    expect(cache.getInFlight('connection-1|entry')).toBeUndefined();
    expect(cache.getInFlight('connection-2|entry')).toBe(secondInFlight);
    expect(cache.isCurrent(first)).toBe(false);
    expect(cache.isCurrent(second)).toBe(true);

    cache.invalidate();
    expect(cache.getInFlight('connection-2|entry')).toBeUndefined();
  });
});
