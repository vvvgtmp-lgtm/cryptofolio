/**
 * One-off entrypoint for the `migrate` container:
 *   1. applies pending SQL migrations (node-pg-migrate, advisory-locked)
 *   2. optionally seeds demo data (SEED_DEMO_DATA=true)
 * Exits 0 on success so dependants can use `service_completed_successfully`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { createDb } from './database.js';
import { seedDemoData } from './seed.js';

const log = (level: string, msg: string) => console.log(JSON.stringify({ level, service: 'migrate', msg }));
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const applied = await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg: string) => log('info', msg),
  });
  log('info', `applied ${applied.length} migration(s)`);

  if (process.env.SEED_DEMO_DATA === 'true') {
    const db = createDb(databaseUrl);
    try {
      log('info', (await seedDemoData(db)) ? 'demo data seeded' : 'demo data already present');
    } finally {
      await db.destroy();
    }
  }
}

main().catch((err) => {
  log('error', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
