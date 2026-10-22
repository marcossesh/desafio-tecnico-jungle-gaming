import { provisionAppRole, runMigrations } from '../src/shared/infra/migrator';

const [direction, flag, value] = process.argv.slice(2);
if ((direction !== 'up' && direction !== 'down') || (flag !== undefined && flag !== '--to')) {
  console.error('usage: bun scripts/migrate.ts <up|down> [--to <name|0>]');
  process.exit(1);
}
// migrations rodam como dono do schema; a aplicação usa o role restrito em DATABASE_URL
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');

const to = value === '0' ? 0 : value;
const applied = await runMigrations(url, direction, to === undefined ? {} : { to });
const password = process.env.APP_DB_PASSWORD;
if (direction === 'up' && password) await provisionAppRole(url, password);
console.log(
  JSON.stringify({
    msg: `migrations ${direction}`,
    applied,
    appRoleProvisioned: direction === 'up' && !!password,
  }),
);
