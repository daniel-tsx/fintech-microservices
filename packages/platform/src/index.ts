import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ExpressAdapter } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Type } from '@nestjs/common';
import helmet from 'helmet';

export interface RequestContext {
  requestId: string;
  correlationId: string;
}

export function configureHttpApp(app: NestExpressApplication): void {
  app.use(helmet());
  (app.getHttpAdapter() as ExpressAdapter).useBodyParser('json', true, { limit: '64kb' });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}

export async function bootstrapService(rootModule: Type<unknown>, name: string, defaultPort: number): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, { rawBody: true, bodyParser: false });
  configureHttpApp(app);
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle(name).setVersion('1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, document);
  await app.listen(Number(process.env.PORT ?? defaultPort), '0.0.0.0');
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function backoffDelay(attempt: number, baseMs = 100, capMs = 10_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exponential / 2 + Math.random() * exponential / 2);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export * from './outbox.js';
export * from './inbox.js';
export * from './kafka.js';
export * from './logging.js';
