import { ApiMetadataService } from '../src/metadataCache';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ApiMetadataService', () => {
  it('isolates owners and preserves case for non-Netezza key policies', async () => {
    let calls = 0;
    const service = new ApiMetadataService({ now: () => 1000 });
    const profile = { id: 'connection-1', dbType: 'sqlite' as const };
    const load = () => Promise.resolve([{ name: `OBJECT-${++calls}` }]);

    await service.load('user-1', profile, 'objects', ['Db', 'Schema'], load);
    await service.load('user-1', profile, 'objects', ['db', 'schema'], load);
    await service.load('user-2', profile, 'objects', ['Db', 'Schema'], load);

    expect(calls).toBe(3);
  });

  it('does not share entries between independently composed API instances', async () => {
    let calls = 0;
    const firstService = new ApiMetadataService({ now: () => 1000 });
    const secondService = new ApiMetadataService({ now: () => 1000 });
    const profile = { id: 'connection-1', dbType: 'sqlite' as const };
    const load = () => Promise.resolve(++calls);

    await expect(firstService.load('user-1', profile, 'objects', ['db'], load)).resolves.toBe(1);
    await expect(secondService.load('user-1', profile, 'objects', ['db'], load)).resolves.toBe(2);
  });

  it('retains Netezza user folding while keeping quoted names distinct', async () => {
    let calls = 0;
    const service = new ApiMetadataService({ now: () => 1000 });
    const profile = { id: 'connection-1', dbType: 'netezza' as const };
    const load = () => Promise.resolve(++calls);

    await service.load('user-1', profile, 'objects', ['db', 'schema'], load);
    await service.load('user-1', profile, 'objects', ['DB', 'SCHEMA'], load);
    await service.load('user-1', profile, 'objects', ['"db"', '"schema"'], load);

    expect(calls).toBe(2);
  });

  it('does not allow an invalidated in-flight result to populate a new generation', async () => {
    const service = new ApiMetadataService({ now: () => 1000 });
    const profile = { id: 'connection-1', dbType: 'sqlite' as const };
    const first = deferred<string>();
    const second = deferred<string>();
    const loader = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const oldRequest = service.load('user-1', profile, 'objects', ['db'], loader);
    service.invalidate('user-1', 'connection-1');
    const newRequest = service.load('user-1', profile, 'objects', ['db'], loader);
    first.resolve('old');
    second.resolve('new');

    await expect(oldRequest).resolves.toBe('old');
    await expect(newRequest).resolves.toBe('new');
    expect(loader).toHaveBeenCalledTimes(2);
    await expect(service.load('user-1', profile, 'objects', ['db'], loader)).resolves.toBe('new');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('serves stale data only when the refresh fails', async () => {
    let now = 1000;
    const service = new ApiMetadataService({ now: () => now, schemaTtlMs: 10, lspTtlMs: 10 });
    const profile = { id: 'connection-1', dbType: 'sqlite' as const };
    const loader = jest.fn()
      .mockResolvedValueOnce('cached')
      .mockRejectedValueOnce(new Error('temporary failure'));

    await expect(service.load('user-1', profile, 'objects', ['db'], loader, { staleOnError: true })).resolves.toBe('cached');
    now = 1015;
    await expect(service.load('user-1', profile, 'objects', ['db'], loader, { staleOnError: true })).resolves.toBe('cached');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
