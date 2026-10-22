import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CorrelationId } from '../../shared/http/correlation-id';
import { parseInput } from '../../shared/http/validation';
import { addLogContext } from '../../shared/infra/log-context';
import { Money } from '../../shared/money/money';
import { OpenWallet } from '../application/open-wallet';
import { ReconcileWallet } from '../application/reconcile-wallet';
import { WalletQueries } from '../application/wallet-queries';
import { ledgerQuery, openWalletBody, walletIdParam } from './wallet.dto';
import { presentLedgerPage, presentReconciliation, presentWallet } from './wallet.presenter';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const input = parseInput(openWalletBody, body);
    const wallet = await this.openWallet.execute({
      playerId: input.playerId,
      initialBalance: Money.from(input.initialBalance),
      correlationId,
    });
    addLogContext({ walletId: wallet.id });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(parseInput(walletIdParam, walletId)));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parseInput(ledgerQuery, query);
    const page = await this.queries.listLedger(parseInput(walletIdParam, walletId), { cursor, limit });
    return presentLedgerPage(page);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    addLogContext({ walletId });
    return presentReconciliation(await this.reconcileWallet.execute(parseInput(walletIdParam, walletId)));
  }
}
