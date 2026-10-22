import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../migrations';

export type MigrationDirection = 'up' | 'down';

export async function runMigrations(
  clientUrl: string,
  direction: MigrationDirection,
  options: { to?: number | string } = {},
): Promise<string[]> {
  const orm = await MikroORM.init({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: { migrationsList, snapshot: false, silent: true },
  });
  try {
    const target = options.to === undefined ? undefined : { to: options.to };
    const done = direction === 'up' ? await orm.migrator.up(target) : await orm.migrator.down(target);
    return done.map((m) => m.name);
  } finally {
    await orm.close();
  }
}
