import type { Request } from 'express';

/** `providerId: null` = qualquer provedor (sem autenticação configurada). */
export interface ProviderIdentity {
  providerId: string | null;
}

/**
 * Ponto de extensão da autenticação: um IdP (ex.: Keycloak com client_credentials por provedor)
 * implementaria `resolve` validando o JWT e lendo a claim `provider_id`; `null` = não autenticado.
 */
export interface ProviderIdentityPort {
  resolve(request: Request): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/** `AUTH_MODE=none`: toda requisição é aceita como canal confiável. */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  resolve(): Promise<ProviderIdentity> {
    return Promise.resolve({ providerId: null });
  }
}
