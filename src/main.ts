import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnvironment } from './config/environment.js';
import { HttpErrorFilter } from './shared/infrastructure/http-exception.filter.js';

async function bootstrap(): Promise<void> {
  const env = loadEnvironment();
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  if (env.role === 'api' || env.role === 'all') await app.listen(env.port, '0.0.0.0');
  else await app.init();
}
void bootstrap();
