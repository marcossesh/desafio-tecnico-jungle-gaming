import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { ProviderAuthGuard } from '../../src/shared/http/provider-auth.guard';
import {
  AnonymousProviderIdentity,
  type ProviderIdentity,
  type ProviderIdentityPort,
} from '../../src/shared/http/provider-identity';

function contextFor(request: {
  path: string;
  params?: Record<string, string>;
  body?: unknown;
}): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const identityOf = (identity: ProviderIdentity | null): ProviderIdentityPort => ({
  resolve: () => Promise.resolve(identity),
});

describe('ProviderAuthGuard', () => {
  test('AUTH_MODE=none accepts every provider', async () => {
    const guard = new ProviderAuthGuard(new AnonymousProviderIdentity());
    expect(
      await guard.canActivate(contextFor({ path: '/wagering/transactions', body: { providerId: 'x' } })),
    ).toBe(true);
  });

  test('health and metrics stay open even without identity', async () => {
    const guard = new ProviderAuthGuard(identityOf(null));
    expect(await guard.canActivate(contextFor({ path: '/health/ready' }))).toBe(true);
    expect(await guard.canActivate(contextFor({ path: '/metrics' }))).toBe(true);
  });

  test('missing identity is UNAUTHENTICATED', async () => {
    const guard = new ProviderAuthGuard(identityOf(null));
    await expect(guard.canActivate(contextFor({ path: '/wallets' }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      kind: 'unauthenticated',
    });
  });

  test('a provider cannot act for another one, by body or route', async () => {
    const guard = new ProviderAuthGuard(identityOf({ providerId: 'provider-a' }));
    expect(
      await guard.canActivate(
        contextFor({ path: '/wagering/transactions', body: { providerId: 'provider-a' } }),
      ),
    ).toBe(true);
    await expect(
      guard.canActivate(contextFor({ path: '/wagering/transactions', body: { providerId: 'provider-b' } })),
    ).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH', kind: 'forbidden' });
    await expect(
      guard.canActivate(
        contextFor({
          path: '/providers/provider-b/wagering/transactions/x',
          params: { providerId: 'provider-b' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
  });
});
