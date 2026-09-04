import { Injectable } from '@nestjs/common';
import { Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
  async text(): Promise<string> {
    return this.registry.metrics();
  }
}
