import { Module } from '@nestjs/common';
import { OutboxPublisherHost } from './infra/outbox-publisher.host';

@Module({ providers: [OutboxPublisherHost] })
export class MessagingModule {}
