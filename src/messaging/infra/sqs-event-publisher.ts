import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailure } from '../application/ports';
import type { OutboxMessage } from '../domain/outbox-message';

const SQS_BATCH_LIMIT = 10;
const LANES = 5;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  /**
   * `MessageGroupId` = wallet (ordem por partição) e `MessageDeduplicationId` = eventId (republicação segura).
   * Partições são distribuídas em faixas enviadas em paralelo; dentro de uma faixa o envio é sequencial,
   * então a ordem de cada wallet se mantém.
   */
  async publish(messages: readonly OutboxMessage[]): Promise<PublishFailure[]> {
    const lanes = Array.from({ length: LANES }, (): OutboxMessage[] => []);
    for (const message of messages) lanes[laneOf(message.partitionKey)]?.push(message);
    return (await Promise.all(lanes.map((lane) => this.publishSequentially(lane)))).flat();
  }

  private async publishSequentially(messages: readonly OutboxMessage[]): Promise<PublishFailure[]> {
    const failures: PublishFailure[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const batch = messages.slice(start, start + SQS_BATCH_LIMIT);
      const text = (value: string) => ({ DataType: 'String', StringValue: value });
      const res = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: batch.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.partitionKey,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: text(message.eventType),
              eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
              correlationId: text(String(message.payload.correlationId ?? '')),
            },
          })),
        }),
      );
      for (const failed of res.Failed ?? []) {
        failures.push({ id: failed.Id ?? '', error: `${failed.Code ?? 'Failed'}: ${failed.Message ?? ''}` });
      }
    }
    return failures;
  }
}

function laneOf(partitionKey: string): number {
  let hash = 0;
  for (let i = 0; i < partitionKey.length; i++) hash = (hash * 31 + partitionKey.charCodeAt(i)) >>> 0;
  return hash % LANES;
}
