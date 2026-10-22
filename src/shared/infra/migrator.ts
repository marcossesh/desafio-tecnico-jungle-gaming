import { SQL } from 'bun';
import { APP_ROLE } from '../../../migrations/0007_app_role';
import { createOrm } from './database/orm';

export type MigrationDirection = 'up' | 'down';

export async function runMigrations(
  clientUrl: string,
  direction: MigrationDirection,
  options: { to?: number | string } = {},
): Promise<string[]> {
  const orm = await createOrm({ clientUrl, poolMax: 1 });
  try {
    const target = options.to === undefined ? undefined : { to: options.to };
    const done = direction === 'up' ? await orm.migrator.up(target) : await orm.migrator.down(target);
    return done.map((m) => m.name);
  } finally {
    await orm.close();
  }
}

/** Dá login ao role da aplicação (criado na migration 0007); a senha vem do ambiente, nunca da migration. */
export async function provisionAppRole(clientUrl: string, password: string): Promise<void> {
  const sql = new SQL(clientUrl, { max: 1 });
  try {
    await sql.unsafe(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}'`);
  } finally {
    await sql.close();
  }
}
