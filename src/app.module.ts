import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { loadEnvironment } from './config/environment.js';
import { DatabaseService } from './shared/infrastructure/database.service.js';
import { MetricsService } from './shared/infrastructure/metrics.service.js';
import { HttpController } from './bootstrap/http.controller.js';
import { NoopAuthGuard } from './bootstrap/noop-auth.guard.js';
import { CreateWalletUseCase } from './wallet/application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from './wallet/application/reconcile-wallet.use-case.js';
import { SubmitWagerTransactionUseCase } from './wagering/application/submit-wager-transaction.use-case.js';
import { SqsService } from './messaging/sqs.service.js';
import { SqsConsumer } from './messaging/sqs-consumer.js';
import { OutboxPublisherWorker } from './outbox/outbox-publisher.worker.js';
import { PendingReferenceWorker } from './wagering/infrastructure/pending-reference.worker.js';
import { HealthService } from './health/health.service.js';
import { SchemaMigrationEntity } from './shared/infrastructure/schema-migration.entity.js';
import { CorrelationMiddleware } from './bootstrap/correlation.middleware.js';

const env = loadEnvironment();
@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: PostgreSqlDriver,
      clientUrl: env.databaseUrl,
      entities: [SchemaMigrationEntity],
    }),
  ],
  controllers: [HttpController],
  providers: [
    DatabaseService,
    MetricsService,
    NoopAuthGuard,
    CreateWalletUseCase,
    ReconcileWalletUseCase,
    SubmitWagerTransactionUseCase,
    SqsService,
    SqsConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    HealthService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
