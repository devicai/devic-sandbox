import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { loadConfig } from './config/config.loader';

async function bootstrap() {
  const config = loadConfig();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: config.logging?.level
      ? [config.logging.level as any, 'error', 'warn']
      : ['log', 'error', 'warn'],
  });

  // WebSocket adapter
  app.useWebSocketAdapter(new WsAdapter(app));

  // Body size limit for file uploads
  app.use(json({ limit: '10mb' }));

  // Global prefix
  const basePath = config.server.basePath ?? '/api/v1';
  app.setGlobalPrefix(basePath, { exclude: ['health', 'health/ready'] });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS
  if (config.server.cors?.enabled) {
    app.enableCors({
      origin: config.server.cors.origins,
    });
  }

  // Swagger / OpenAPI
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Operator')
    .setDescription('Operator — sandbox orchestration API (microsandbox/Docker abstraction layer)')
    .setVersion(process.env.npm_package_version ?? '0.1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${basePath}/docs`, app, document);

  // Start
  const port = config.server.port ?? 3200;
  await app.listen(port);

  logger.log(`Service running on port ${port}`);
  logger.log(`API docs: http://localhost:${port}${basePath}/docs`);
  logger.log(`MCP endpoint: http://localhost:${port}${basePath}/mcp`);
  logger.log(`Terminal WS: ws://localhost:${port}/ws/terminal`);

  if (config.extensions.properties.length > 0) {
    const extNames = config.extensions.properties.map((e) => e.name).join(', ');
    logger.log(`Entity extensions active: ${extNames}`);
  } else {
    logger.log('No entity extensions configured (standalone mode)');
  }
}

bootstrap();
