import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../../shared/application/errors';
import { CorrelationId } from '../../shared/http/correlation-id';
import { parseInput } from '../../shared/http/validation';
import { Money } from '../../shared/money/money';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { WagerQueries } from '../application/wager-queries';
import { externalIdParams, idempotencyKeyHeader, transactionIdParam, wagerBody } from './wager.dto';
import { httpStatusOf, presentResult, presentTransaction } from './wager.presenter';

@Controller()
export class WagerTransactionsController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (idempotencyKey === undefined) {
      throw new ApplicationError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'validation',
        'Idempotency-Key header is required',
      );
    }
    const key = parseInput(idempotencyKeyHeader, idempotencyKey);
    const input = parseInput(wagerBody, body);
    const outcome = await this.processWager.execute({ ...input, money: Money.from(input.money) }, key, {
      channel: 'http',
      correlationId,
    });
    if (outcome.type === 'duplicate_message') throw new Error('HTTP requests never go through the inbox');

    res.status(httpStatusOf(outcome.transaction));
    return presentResult(outcome.transaction, outcome.type === 'replay');
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return presentTransaction(await this.queries.getById(parseInput(transactionIdParam, transactionId)));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param() params: unknown) {
    const { providerId, externalTransactionId } = parseInput(externalIdParams, params);
    return presentTransaction(await this.queries.getByExternalId(providerId, externalTransactionId));
  }
}
