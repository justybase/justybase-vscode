import { loadConfig } from './config';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ host: config.host, port: config.port });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
