// main.ts —— HTTP API 入口（week20 Day 2 的 BFF 形态）
// 工具链注意：tsx/esbuild 不产出 emitDecoratorMetadata，Nest 的构造注入靠它拿参数类型，
// 所以 API 走「编译产物」运行：pnpm --filter @agent-app/api build → node apps/api/dist/main.js
// （根目录 pnpm api 会先建引擎与 api 再启动）。
// reflect-metadata 必须在任何 @nestjs 导入之前加载，放在首行。
import "reflect-metadata";
import { INestApplication, Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { loadEnv } from "@agent-app/engine/config";
import { AppModule } from "./app.module.js";
import { AllExceptionsFilter } from "./common/all-exceptions.filter.js";
import { ChatService } from "./chat/chat.service.js";

/** 路由表内省用的最小形状（Express 5 是 app.router，老版本是 app._router，都试着拿） */
interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** 从适配器实例里挖出路由表，打不出就安静跳过（日志是锦上添花，不是启动条件） */
function listRoutes(app: INestApplication): string[] {
  const instance: unknown = app.getHttpAdapter().getInstance();
  const router =
    (instance as { router?: { stack: RouteLayer[] } }).router ??
    (instance as { _router?: { stack: RouteLayer[] } })._router;
  return (router?.stack ?? [])
    .flatMap((layer) => (layer.route ? [layer.route] : []))
    .map(
      (route) =>
        `${Object.keys(route.methods)
          .map((m) => m.toUpperCase())
          .join(", ")}\t${route.path}`,
    );
}

async function bootstrap(): Promise<void> {
  // Nest 官方 Logger 统一日志出口（替换裸 console）：带时间戳与上下文名，可全局覆写
  const logger = new Logger("Bootstrap", { timestamp: true });

  const app = await NestFactory.create(AppModule);

  // 优雅关闭：收到 SIGINT/SIGTERM 时先 onModuleDestroy/onApplicationShutdown 再退出
  // （开发 Ctrl+C / 生产容器停止都走这条路，避免请求被拦腰掐断）
  app.enableShutdownHooks();

  // CORS：web（apps/web 默认 3001 端口）跨域调用 API 必需；学习项目放开来源即可
  app.enableCors({ origin: true });

  // 全局参数校验：未知字段剥掉（whitelist）+ 请求体转 DTO 实例（transform）
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // 全局异常过滤：引擎的中文错误 → { statusCode, message, hint }，HttpException 放行
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger/OpenAPI 文档：DTO 上的 @ApiProperty 自动汇成 Schema，挂在 /api/docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle("AI Agent HTTP API")
    .setDescription("BFF 形态，SSE 流式对话见 GET /api/chat/stream（事件契约同 @agent-app/shared）")
    .setVersion("1.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  // PORT：环境变量优先于 .env 文件（同 dotenv 惯例），默认 3000
  const port = Number(process.env.PORT ?? loadEnv().PORT ?? 3000);
  await app.listen(port);

  const routes = listRoutes(app);
  logger.log(`=== AI Agent HTTP API（NestJS BFF）已启动：http://localhost:${port} ===`);
  for (const line of routes) {
    logger.log(`    ${line}`);
  }

  // 依赖注入自检：ChatService 经构造注入拿到 ConfigProvider（emitDecoratorMetadata 的功劳），
  // 这里显式 resolve 一次，装配失败（undefined/异常）当场暴露而不是等到首个请求
  const chat = app.get(ChatService);
  logger.log(
    `[boot] 依赖注入自检：ChatService ← ConfigProvider 装配成功，apiKey ${chat.describeInjection()}`,
  );
}

void bootstrap();
