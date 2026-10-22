import { z } from 'zod';
import { ValidationError } from '../../shared/application/errors';
import { wagerBody } from '../http/wager.dto';

// Mesmo contrato de negócio do HTTP; a idempotency key vem no corpo em vez do header.
const wagerMessage = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: wagerBody.extend({ idempotencyKey: z.string().min(1).max(200) }),
});

export type WagerMessage = z.infer<typeof wagerMessage>;

export function parseWagerMessage(body: string | undefined): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new ValidationError('Message body is not JSON');
  }
  const result = wagerMessage.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new ValidationError('Invalid WagerTransactionRequested message', { issues });
  }
  return result.data;
}
