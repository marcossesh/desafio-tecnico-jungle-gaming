import { SQL } from 'bun';
import { runMigrations } from '../../src/shared/infra/migrator';

const TEMPLATE = 'wagering_test_template';
// Advisory lock serializa (re)construção e clonagem do template entre processos de teste concorrentes.
const TEMPLATE_LOCK = 72_001;

const baseUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

export interface TestDatabase {
  url: string;
  sql: SQL;
  drop(): Promise<void>;
}

let template: Promise<void> | undefined;

function urlFor(database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdmin<T>(fn: (admin: SQL) => Promise<T>): Promise<T> {
  const admin = new SQL(urlFor('postgres'), { max: 1 });
  try {
    await admin.unsafe(`SELECT pg_advisory_lock(${TEMPLATE_LOCK})`);
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

// Reconstruído uma vez por processo: migrations editadas nunca usam template velho.
function buildTemplate(): Promise<void> {
  return withAdmin(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
    await runMigrations(urlFor(TEMPLATE), 'up');
  });
}

export async function createTestDatabase(options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const migrated = options.migrated ?? true;
  const name = `wagering_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  if (migrated) {
    template ??= buildTemplate();
    await template;
    await withAdmin((admin) => admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`));
  } else {
    await withAdmin((admin) => admin.unsafe(`CREATE DATABASE ${name}`));
  }

  const url = urlFor(name);
  const sql = new SQL(url);
  return {
    url,
    sql,
    async drop() {
      await sql.close();
      await withAdmin((admin) => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
