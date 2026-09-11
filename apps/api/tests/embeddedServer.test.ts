import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbeddedApiServer } from '../src/embeddedServer';

function configuration(dataDir: string) {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webDistDir: path.join(dataDir, 'missing-web'),
    masterKey: 'embedded-test-master-key',
    adminUsername: 'embedded-admin',
    adminPassword: 'embedded-admin-password',
  } as const;
}

describe('embedded API lifecycle', () => {
  it('starts the existing server on a loopback port and closes idempotently', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-embedded-api-'));
    const embedded = createEmbeddedApiServer(configuration(dataDir));
    try {
      const url = await embedded.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(embedded.url).toBe(url);
      expect(embedded.app).toBeDefined();
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
      expect(await embedded.start()).toBe(url);
      await Promise.all([embedded.close(), embedded.close()]);
      expect(embedded.app).toBeUndefined();
      expect(embedded.url).toBeUndefined();
      await expect(embedded.start()).rejects.toThrow('closed');
    } finally {
      await embedded.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a valid URL when bound to an IPv6 loopback host', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-embedded-api-ipv6-'));
    const embedded = createEmbeddedApiServer({ ...configuration(dataDir), host: '::1' });
    try {
      const url = await embedded.start();
      expect(url).toMatch(/^http:\/\/\[::1\]:\d+$/u);
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
    } finally {
      await embedded.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('cleans up the partially initialized server when listen fails', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'justybase-embedded-api-failed-'));
    const embedded = createEmbeddedApiServer({ ...configuration(dataDir), host: 'invalid-host-name-for-justybase' });
    try {
      await expect(embedded.start()).rejects.toThrow();
      expect(embedded.app).toBeUndefined();
      await embedded.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
