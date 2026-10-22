import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailure } from '../application/ports';
import type { OutboxMessage } from '../domain/outbox-message';

const SQS_BATCH_LIMIT = 10;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  /** `MessageGroupId` = wallet (ordem por partição) e `MessageDeduplicationId` = eventId (republicação segura). */
  async publish(messages: readonly OutboxMessage[]): Promise<PublishFailure[]> {
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
