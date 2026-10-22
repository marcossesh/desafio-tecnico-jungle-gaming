import { runMigrations } from '../src/shared/infra/migrator';

const [direction, flag, value] = process.argv.slice(2);
if ((direction !== 'up' && direction !== 'down') || (flag !== undefined && flag !== '--to')) {
  console.error('usage: bun scripts/migrate.ts <up|down> [--to <name|0>]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const to = value === '0' ? 0 : value;
const applied = await runMigrations(url, direction, to === undefined ? {} : { to });
console.log(JSON.stringify({ msg: `migrations ${direction}`, applied }));
