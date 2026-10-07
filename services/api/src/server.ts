import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDeps, createDeps } from './deps.js';

const config = loadConfig();
const deps = createDeps(config);
const app = buildApp(deps);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stop accepting, finish in-flight requests
  await closeDeps(deps);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
