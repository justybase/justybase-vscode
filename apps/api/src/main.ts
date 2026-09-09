import { loadConfig } from './config';
import { buildServer } from './server';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      const currentShutdown = shutdownPromise;
      // A second signal is an explicit request to stop waiting for a stuck
      // client or driver cleanup.
      console.error(`Forced shutdown after repeated ${signal}.`);
      process.exit(1);
      return currentShutdown;
    }

    const currentShutdown = (async () => {
      const timeout = setTimeout(() => {
        console.error(`Graceful shutdown exceeded ${SHUTDOWN_TIMEOUT_MS} ms.`);
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      try {
        await app.close();
        process.exit(0);
      } catch (error: unknown) {
        console.error(`Failed to shut down after ${signal}.`, error);
        process.exitCode = 1;
        process.exit(1);
      } finally {
        clearTimeout(timeout);
      }
    })();
    shutdownPromise = currentShutdown;
    return currentShutdown;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error: unknown) {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    await app.close().catch(() => undefined);
    throw error;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
