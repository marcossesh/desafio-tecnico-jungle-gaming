import { z } from 'zod';

const ROLES = ['api', 'consumer', 'outbox', 'scheduler'] as const;
export type Role = (typeof ROLES)[number];

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

const schema = z.object({
  PORT: int(3000),
  ROLES: z
    .string()
    .default(ROLES.join(','))
    .transform((v) =>
      v
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(ROLES)).min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_GRACE_MS: int(25_000),

  DATABASE_URL: z.url(),
  DB_POOL_MAX: int(10),
  WALLET_LOCK_TIMEOUT_MS: int(3_000),

  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.url(),
  SQS_INPUT_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_DLQ_QUEUE: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wagering-events.fifo'),
  SQS_MAX_ATTEMPTS: int(5),
  SQS_RETRY_BASE_SECONDS: int(2),

  OUTBOX_TICK_MS: int(500),
  OUTBOX_LEASE_MS: int(30_000),

  PENDING_REF_TICK_MS: int(1_000),
  PENDING_REF_BASE_MS: int(2_000),
  PENDING_REF_CAP_MS: int(300_000),
  PENDING_REF_MAX_ATTEMPTS: int(10),

  AUTH_MODE: z.enum(['none', 'keycloak']).default('none'),
  AUTH_ISSUER: z.url().optional(),
  AUTH_AUDIENCE: z.string().default('wagering-api'),
  // dentro da rede do compose o IdP tem outro host que o `iss` dos tokens
  AUTH_JWKS_URL: z.url().optional(),

  FAILPOINTS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

const refined = schema.refine((env) => env.AUTH_MODE === 'none' || env.AUTH_ISSUER !== undefined, {
  message: 'AUTH_ISSUER is required when AUTH_MODE is keycloak',
  path: ['AUTH_ISSUER'],
});

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = refined.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
