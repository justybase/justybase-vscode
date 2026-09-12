import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import type { ApiConfig } from './config';
import { buildServer } from './server';

export interface EmbeddedApiServer {
  readonly url?: string;
  readonly app?: FastifyInstance;
  start(): Promise<string>;
  close(): Promise<void>;
}
function loopbackHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
}

function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Starts the existing Fastify composition once for an embedded product.
 * Electron and tests use this instead of spawning a second API process.
 */
export function createEmbeddedApiServer(configuration: ApiConfig): EmbeddedApiServer {
  let instance: FastifyInstance | undefined;
  let address: string | undefined;
  let starting: Promise<string> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  const start = (): Promise<string> => {
    if (address) return Promise.resolve(address);
    if (closed) return Promise.reject(new Error('Embedded API server is closed.'));
    if (starting) return starting;
    starting = (async () => {
      const candidate = await buildServer({ ...configuration, host: loopbackHost(configuration.host), port: configuration.port || 0 });
      instance = candidate;
      try {
        await candidate.listen({ host: loopbackHost(configuration.host), port: configuration.port || 0 });
        const bound = candidate.server.address();
        if (!bound || typeof bound === 'string') throw new Error('Embedded API did not expose a TCP address.');
        address = `http://${urlHost(bound.address)}:${bound.port}`;
        return address;
      } catch (error: unknown) {
        await candidate.close().catch(() => undefined);
        instance = undefined;
        throw error;
      }
    })();
    void starting.then(undefined, () => { starting = undefined; });
    return starting;
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    const attempt = (async () => {
      closed = true;
      if (starting) await starting.catch(() => undefined);
      const candidate = instance;
      if (candidate) {
        await candidate.close();
        instance = undefined;
        address = undefined;
      }
    })();
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return closing;
  };

  return {
    get url() { return address; },
    get app() { return instance; },
    start,
    close,
  };
}
