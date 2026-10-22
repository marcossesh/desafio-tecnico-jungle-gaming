import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApplicationError } from '../application/errors';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from './provider-identity';

const PUBLIC_PATHS = /^\/(health|metrics)(\/|$)/;

/** Global: exige identidade e impede um provedor de operar em nome de outro (`providerId` do corpo ou da rota). */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (PUBLIC_PATHS.test(request.path)) return true;

    const identity = await this.identities.resolve(request);
    if (!identity)
      throw new ApplicationError('UNAUTHENTICATED', 'unauthenticated', 'Provider credentials are required');
    if (identity.providerId === null) return true;

    const claimed =
      request.params?.providerId ?? (request.body as { providerId?: unknown } | undefined)?.providerId;
    if (claimed !== undefined && claimed !== identity.providerId) {
      throw new ApplicationError(
        'PROVIDER_MISMATCH',
        'forbidden',
        'Authenticated provider differs from the request',
      );
    }
    return true;
  }
}
