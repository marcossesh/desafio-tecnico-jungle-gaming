import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { METRICS } from '../shared/infra/core.module';
import type { PromMetrics } from '../shared/infra/metrics';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PromMetrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('content-type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
