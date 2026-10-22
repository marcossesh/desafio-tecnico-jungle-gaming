import type { Request } from 'express';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { ProviderIdentity, ProviderIdentityPort } from './provider-identity';

export interface JwtProviderIdentitySettings {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

/**
 * `AUTH_MODE=keycloak`: JWT de client_credentials (um client por provedor) com a claim `provider_id`.
 * Assinatura via JWKS (com cache de chaves do jose), `iss`, `aud` e `exp` verificados.
 */
export class JwtProviderIdentity implements ProviderIdentityPort {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly settings: JwtProviderIdentitySettings) {
    this.keys = createRemoteJWKSet(new URL(settings.jwksUrl), { timeoutDuration: 3_000 });
  }

  async resolve(request: Request): Promise<ProviderIdentity | null> {
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['RS256'],
      });
      return typeof payload.provider_id === 'string' && payload.provider_id !== ''
        ? { providerId: payload.provider_id }
        : null;
    } catch {
      return null;
    }
  }
}
