import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type BeforeApplicationShutdown, Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Env } from '../config/env';
import { ENV, ORM, SQS_CLIENT } from '../shared/infra/core.module';

const CHECK_TIMEOUT_MS = 1_000;

type CheckResult = 'ok' | 'error' | 'timeout';

async function check(probe: (signal: AbortSignal) => Promise<unknown>): Promise<CheckResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probe(controller.signal).then((): CheckResult => 'ok'), timeout]);
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController implements BeforeApplicationShutdown {
  private draining = false;

  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** 503 enquanto Postgres ou SQS não respondem em 1s, ou durante o shutdown (sai do balanceamento antes de parar). */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    if (this.draining) {
      res.status(503);
      return { status: 'draining' };
    }
    const [database, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('SELECT 1')),
      check((abortSignal) =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.env.SQS_INPUT_QUEUE }), { abortSignal }),
      ),
    ]);
    const ok = database === 'ok' && sqs === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { database, sqs } };
  }

  beforeApplicationShutdown(): void {
    this.draining = true;
  }
}
