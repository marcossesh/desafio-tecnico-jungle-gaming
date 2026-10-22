import type { Request } from 'express';

/** `providerId: null` = qualquer provedor (sem autenticação configurada). */
export interface ProviderIdentity {
  providerId: string | null;
}

/** Resolve o provedor autenticado da requisição; `null` = não autenticado. */
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
