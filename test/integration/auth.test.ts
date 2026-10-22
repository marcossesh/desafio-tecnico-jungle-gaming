// AUTH_MODE=keycloak contra um JWKS servido por HTTP de verdade: assinatura, iss, aud, exp e claim provider_id.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { loadEnv } from '../../src/config/env';
import { startTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertLedgerConsistent } from '../support/ledger';
import { betPayload, brl } from '../support/wager-api';

const ISSUER = 'http://idp.test/realms/wagering';
const AUDIENCE = 'wagering-api';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let db: TestDatabase;
let app: TestApp;
let jwks: Server<unknown>;
let signingKey: Key;
let foreignKey: Key;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [publicJwk] }) });

  db = await createTestDatabase();
  app = await startTestApp(db.url, {
    AUTH_MODE: 'keycloak',
    AUTH_ISSUER: ISSUER,
    AUTH_JWKS_URL: `http://127.0.0.1:${jwks.port}/certs`,
  });
});

afterAll(async () => {
  await assertLedgerConsistent(db.sql);
  await app.close();
  await jwks.stop(true);
  await db.drop();
});

interface TokenOptions {
  key?: Key;
  expiresIn?: string;
  issuer?: string;
  audience?: string;
}

function token(claims: JWTPayload = {}, options: TokenOptions = {}) {
  return new SignJWT({ provider_id: 'provider-a', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? signingKey);
}

const bearer = async (claims?: JWTPayload, options?: TokenOptions) => ({
  authorization: `Bearer ${await token(claims, options)}`,
});

async function openWallet() {
  const res = await app.request(
    'POST',
    '/wallets',
    { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
    await bearer(),
  );
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function submit(body: ReturnType<typeof betPayload>, headers: Record<string, string>) {
  return app.request('POST', '/wagering/transactions', body, {
    'idempotency-key': `${body.providerId}:${body.externalTransactionId}`,
    ...headers,
  });
}

describe('AUTH_MODE=keycloak', () => {
  test('a valid token for the same provider is accepted', async () => {
    const wallet = await openWallet();
    const res = await submit(betPayload(wallet), await bearer());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
  });

  test.each<[string, () => Promise<Record<string, string>>]>([
    ['no Authorization header', async () => ({})],
    ['a non-bearer scheme', async () => ({ authorization: `Basic ${btoa('provider-a:secret')}` })],
    ['a malformed token', async () => ({ authorization: 'Bearer not.a.jwt' })],
    ['an expired token', () => bearer({}, { expiresIn: '-1m' })],
    ['a token signed by another key', () => bearer({}, { key: foreignKey })],
    ['a token for another audience', () => bearer({}, { audience: 'other-api' })],
    ['a token from another issuer', () => bearer({}, { issuer: 'http://evil.test/realms/wagering' })],
    ['a token without provider_id', () => bearer({ provider_id: undefined })],
  ])('%s is 401 UNAUTHENTICATED and writes nothing', async (_name, headers) => {
    const wallet = await openWallet();
    const bet = betPayload(wallet);
    const res = await submit(bet, await headers());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    const [row] = await db.sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ${bet.externalTransactionId}`;
    expect(row.n).toBe(0);
  });

  test('a provider cannot act for another one, by body or by route', async () => {
    const wallet = await openWallet();
    const byBody = await submit(betPayload(wallet, { providerId: 'provider-b' }), await bearer());
    expect(byBody.status).toBe(403);
    expect(byBody.body.error.code).toBe('PROVIDER_MISMATCH');

    const byRoute = await app.request(
      'GET',
      '/providers/provider-b/wagering/transactions/anything',
      undefined,
      await bearer(),
    );
    expect(byRoute.status).toBe(403);
  });

  test('health and metrics stay open', async () => {
    expect((await app.request('GET', '/health/live')).status).toBe(200);
    expect((await fetch(`${await app.app.getUrl()}/metrics`)).status).toBe(200);
  });

  test('keycloak mode without AUTH_ISSUER does not start', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: db.url, SQS_ENDPOINT: 'http://localhost:4566', AUTH_MODE: 'keycloak' }),
    ).toThrow('AUTH_ISSUER');
  });
});
