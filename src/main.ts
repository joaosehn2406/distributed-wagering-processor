import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnvironment } from './config/environment.js';
import { HttpErrorFilter } from './shared/infrastructure/http-exception.filter.js';
import { JsonNestLogger } from './shared/infrastructure/json-nest-logger.js';

async function bootstrap(): Promise<void> {
  const env = loadEnvironment();
  const app = await NestFactory.create(AppModule, { logger: new JsonNestLogger() });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.enableShutdownHooks();
  const listenPort = env.role === 'api' || env.role === 'all' ? env.port : env.metricsPort;
  if (listenPort === undefined) await app.init();
  else await app.listen(listenPort, '0.0.0.0');
}
void bootstrap();
