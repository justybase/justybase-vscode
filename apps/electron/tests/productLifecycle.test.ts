import {
  createLaunchPathQueue,
  deepLinkToSqlPath,
  ensureSingleInstance,
  JUSTYBASE_PROTOCOL,
  parseLaunchTargets,
  registerProtocolClient,
  sqlPathsFromTargets,
} from '../src/main/productLifecycle';

describe('Electron product lifecycle', () => {
  it('exposes the justybase protocol name', () => {
    expect(JUSTYBASE_PROTOCOL).toBe('justybase');
  });

  it('collects absolute .sql paths and deep links while ignoring flags', () => {
    expect(parseLaunchTargets(['/usr/bin/justybase', '--no-sandbox', '/tmp/a.sql', 'relative/b.sql', '/tmp/c.txt', 'justybase://open?path=%2Ftmp%2Fd.sql'])).toEqual({
      sqlFiles: ['/tmp/a.sql'],
      deepLinks: ['justybase://open?path=%2Ftmp%2Fd.sql'],
    });
    expect(parseLaunchTargets([])).toEqual({ sqlFiles: [], deepLinks: [] });
  });

  it('resolves only well-formed open deep links to absolute .sql paths', () => {
    expect(deepLinkToSqlPath('justybase://open?path=%2Ftmp%2Freport.sql')).toBe('/tmp/report.sql');
    expect(deepLinkToSqlPath('justybase://open?path=relative.sql')).toBeUndefined();
    expect(deepLinkToSqlPath('justybase://open?path=%2Ftmp%2Freport.csv')).toBeUndefined();
    expect(deepLinkToSqlPath('justybase://quit')).toBeUndefined();
    expect(deepLinkToSqlPath('https://example.test/open?path=%2Ftmp%2Fx.sql')).toBeUndefined();
    expect(deepLinkToSqlPath('not a url')).toBeUndefined();
  });

  it('neutralises hostile deep links: traversal normalises, oversize and null bytes rejected', () => {
    expect(deepLinkToSqlPath('justybase://open?path=%2Ftmp%2F..%2Fx.sql')).toBe('/x.sql');
    expect(deepLinkToSqlPath(`justybase://open?path=%2F${'a'.repeat(5000)}.sql`)).toBeUndefined();
    expect(deepLinkToSqlPath('justybase://open?path=%2Ftmp%2Fbad%00.sql')).toBeUndefined();
    expect(deepLinkToSqlPath('justybase://open?path=%2Ftmp%2Fx.sql&path=%2Fetc%2Fy.sql')).toBe('/tmp/x.sql');
    expect(deepLinkToSqlPath('JUSTYBASE://open?path=%2Ftmp%2Fupper.sql')).toBe('/tmp/upper.sql');
  });

  it('ignores non-string and flag-shaped argv entries', () => {
    expect(parseLaunchTargets(['--open=/tmp/a.sql', '-', '', 42 as never, null as never])).toEqual({ sqlFiles: [], deepLinks: [] });
  });

  it('merges file and deep-link targets without duplicates', () => {
    expect(sqlPathsFromTargets({ sqlFiles: ['/tmp/a.sql'], deepLinks: ['justybase://open?path=%2Ftmp%2Fa.sql', 'justybase://open?path=%2Ftmp%2Fb.sql', 'justybase://quit'] })).toEqual([
      '/tmp/a.sql',
      '/tmp/b.sql',
    ]);
  });

  it('forwards validated second-instance targets to the primary window', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = {
      requestSingleInstanceLock: jest.fn(() => true),
      on: jest.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }),
      setAsDefaultProtocolClient: jest.fn(() => true),
    };
    const seen: Array<{ sqlFiles: readonly string[]; deepLinks: readonly string[] }> = [];
    expect(ensureSingleInstance(app, targets => { seen.push(targets); })).toBe(true);
    listeners.get('second-instance')?.({}, ['/usr/bin/justybase', '/tmp/second.sql', '--flag']);
    expect(seen).toEqual([{ sqlFiles: ['/tmp/second.sql'], deepLinks: [] }]);
  });

  it('queues pre-startup file opens without duplicates and drains once', () => {
    const queue = createLaunchPathQueue();
    expect(queue.size).toBe(0);
    queue.push(['/tmp/a.sql', '/tmp/b.sql']);
    queue.push(['/tmp/b.sql', 42 as never, null as never]);
    expect(queue.size).toBe(2);
    expect(queue.drain()).toEqual(['/tmp/a.sql', '/tmp/b.sql']);
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('survives a throwing second-instance callback', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = {
      requestSingleInstanceLock: jest.fn(() => true),
      on: jest.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }),
      setAsDefaultProtocolClient: jest.fn(() => true),
    };
    expect(ensureSingleInstance(app, () => { throw new Error('renderer gone'); })).toBe(true);
    expect(() => listeners.get('second-instance')?.({}, [])).not.toThrow();
  });

  it('refuses startup work when another instance owns the lock', () => {    const app = {
      requestSingleInstanceLock: jest.fn(() => false),
      on: jest.fn(),
      setAsDefaultProtocolClient: jest.fn(() => true),
    };
    expect(ensureSingleInstance(app, () => { throw new Error('must not run'); })).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });

  it('registers the protocol handler best-effort', () => {
    expect(registerProtocolClient({
      requestSingleInstanceLock: () => true,
      on: () => undefined,
      setAsDefaultProtocolClient: jest.fn(() => true),
    })).toBe(true);
    expect(registerProtocolClient({
      requestSingleInstanceLock: () => true,
      on: () => undefined,
      setAsDefaultProtocolClient: () => { throw new Error('no desktop integration'); },
    })).toBe(false);
  });
});
