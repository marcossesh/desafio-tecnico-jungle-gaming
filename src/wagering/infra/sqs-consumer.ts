import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Logger } from 'pino';
import { ApplicationError } from '../../shared/application/errors';
import { DomainError } from '../../shared/domain/errors';
import { Money } from '../../shared/money/money';
import type { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { parseWagerMessage } from './wager-message';

export interface SqsConsumerSettings {
  consumerName: string;
  queues: { input: string; dlq: string };
  /** Recebimentos com falha transitória antes da DLQ. */
  maxAttempts: number;
  retryBaseSeconds: number;
  waitTimeSeconds: number;
  maxMessages: number;
  shutdownGraceMs: number;
}

type Disposition = { type: 'ack' } | { type: 'dlq' | 'retry'; failureCode: string };

const MAX_VISIBILITY_SECONDS = 900;

/** Negócio → ack; não registrável (payload, conflito, wallet inexistente) → DLQ; infra/bug → retry. */
function classify(error: unknown): Disposition {
  if (error instanceof DomainError) return { type: 'dlq', failureCode: error.code };
  if (error instanceof ApplicationError) {
    const retry = error.kind === 'transient' || error.kind === 'internal';
    return { type: retry ? 'retry' : 'dlq', failureCode: error.code };
  }
  return { type: 'retry', failureCode: 'INTERNAL_ERROR' };
}

export class SqsConsumer {
  private stopping = false;
  private receiving: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly logger: Logger,
    private readonly settings: SqsConsumerSettings,
  ) {}

  start(): void {
    this.stopping = false;
    this.loop = this.poll();
  }

  /** Interrompe o long poll, espera o lote em andamento (até o grace) e devolve o que não começou. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.receiving?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.settings.shutdownGraceMs);
    });
    // timer pendente manteria o processo vivo até o fim do grace
    await Promise.race([this.loop, grace]);
    clearTimeout(timer);
  }

  /** Um ciclo de recebimento; grupos em paralelo, mensagens do mesmo grupo em ordem. */
  async runOnce(): Promise<number> {
    this.receiving = new AbortController();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.settings.queues.input,
        MaxNumberOfMessages: this.settings.maxMessages,
        WaitTimeSeconds: this.settings.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.receiving.signal },
    );

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
    return messages.length;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        if (this.stopping) break;
        this.logger.error({ err: error }, 'sqs receive failed');
        await Bun.sleep(1_000);
      }
    }
  }

  private async handleGroup(messages: Message[]): Promise<void> {
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await Promise.all(messages.slice(index).map((m) => this.changeVisibility(m, 0)));
        return;
      }
      await this.handle(message);
    }
  }

  private async handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let disposition: Disposition;
    let messageId: string | undefined;
    try {
      const envelope = parseWagerMessage(message.Body);
      messageId = envelope.messageId;
      const { idempotencyKey, ...data } = envelope.data;
      const outcome = await this.processWager.execute(
        { ...data, money: Money.from(data.money) },
        idempotencyKey,
        {
          channel: 'sqs',
          correlationId: messageId,
          causationId: messageId,
          inbox: { consumerName: this.settings.consumerName, messageId },
        },
      );
      this.logger.info(
        {
          messageId,
          walletId: data.walletId,
          providerId: data.providerId,
          outcome: outcome.type,
          ...(outcome.type !== 'duplicate_message' && {
            transactionId: outcome.transaction.id,
            status: outcome.transaction.status,
          }),
        },
        'wager message processed',
      );
      disposition = { type: 'ack' };
    } catch (error) {
      disposition = classify(error);
      this.logger.warn({ err: error, messageId, receiveCount, ...disposition }, 'wager message failed');
    }

    if (disposition.type === 'retry' && receiveCount >= this.settings.maxAttempts) {
      disposition = { type: 'dlq', failureCode: disposition.failureCode };
    }
    switch (disposition.type) {
      case 'ack':
        return this.delete(message);
      case 'dlq':
        return this.deadLetter(message, disposition.failureCode, messageId, receiveCount);
      case 'retry': {
        const backoff = 2 ** (receiveCount - 1) * this.settings.retryBaseSeconds;
        return this.changeVisibility(message, Math.min(backoff, MAX_VISIBILITY_SECONDS));
      }
    }
  }

  // Falhas de ack/visibilidade só atrasam: a mensagem reaparece e a inbox impede efeito duplicado.
  private async delete(message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.settings.queues.input,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, sqsMessageId: message.MessageId }, 'sqs delete failed');
    }
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.settings.queues.input,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, sqsMessageId: message.MessageId }, 'sqs visibility change failed');
    }
  }

  private async deadLetter(
    message: Message,
    failureCode: string,
    messageId: string | undefined,
    receiveCount: number,
  ): Promise<void> {
    const text = (value: string) => ({ DataType: 'String', StringValue: value });
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.settings.queues.dlq,
          MessageBody: message.Body || '(empty)',
          MessageGroupId: message.Attributes?.MessageGroupId || 'invalid',
          // reenvio após crash entre DLQ e delete é deduplicado pela fila
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureCode: text(failureCode),
            originalMessageId: text(messageId ?? message.MessageId ?? 'unknown'),
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
    } catch (error) {
      this.logger.error({ err: error, sqsMessageId: message.MessageId }, 'sqs dead-letter failed');
      return;
    }
    await this.delete(message);
  }
}
