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
