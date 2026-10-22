import type { Clock, IdGenerator } from '../domain/ports';

export const systemClock: Clock = { now: () => new Date() };

// UUIDv7: ordenável por tempo, bom para índices B-tree.
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
